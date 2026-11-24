import { describe, expect, it } from 'vitest';
import {
  NestedDetector,
  analyseCommandLine,
  parseSshTarget,
  parseUserSwitch,
  stripInputNoise,
} from '../../src/main/metadata/nested';

describe('parseSshTarget', () => {
  it('reads user, host and port in any order', () => {
    expect(parseSshTarget('-p 2222 root@198.18.0.5')).toMatchObject({ host: '198.18.0.5', username: 'root', port: 2222 });
    expect(parseSshTarget('root@198.18.0.5 -p 2222')).toMatchObject({ host: '198.18.0.5', port: 2222 });
    expect(parseSshTarget('-l admin 198.18.0.9')).toMatchObject({ host: '198.18.0.9', username: 'admin' });
    expect(parseSshTarget('-v')).toBeNull();
  });
});

describe('analyseCommandLine', () => {
  it('ignores terminal control sequences glued to the typed line', () => {
    expect(stripInputNoise('\u001b[I')).toBe('');
    expect(stripInputNoise('\u001b[Issh root@198.18.0.9')).toBe('ssh root@198.18.0.9');
    expect(analyseCommandLine('\u001b[Issh root@198.18.0.9')).toMatchObject({ type: 'push', hop: { host: '198.18.0.9' } });
    expect(analyseCommandLine('\u001b[200~exit\u001b[201~')).toMatchObject({ type: 'pop' });
  });

  it('detects a nested ssh login', () => {
    const signal = analyseCommandLine('ssh -p 2200 root@198.18.0.9', 1000);
    expect(signal).toMatchObject({
      type: 'push',
      hop: { host: '198.18.0.9', username: 'root', port: 2200, detectedBy: 'command-line', confidence: 'high', at: 1000 },
    });
  });

  it('fills in the port ssh would use when the line names none', () => {
    expect(analyseCommandLine('ssh root@198.18.0.5')).toMatchObject({ hop: { port: 22 } });
    expect(analyseCommandLine('ssh -o StrictHostKeyChecking=no root@198.18.0.5')).toMatchObject({ hop: { port: 22 } });
    expect(analyseCommandLine('mosh -p 2222 root@198.18.0.5')).toMatchObject({ hop: { port: 2222 } });
  });

  it('detects telnet, su and wsl', () => {
    expect(analyseCommandLine('telnet 198.18.0.9 23')).toMatchObject({ type: 'push', hop: { host: '198.18.0.9' } });
    expect(analyseCommandLine('sudo -i')).toMatchObject({ type: 'push', hop: { username: 'root', sameHost: true } });
    expect(analyseCommandLine('su - postgres')).toMatchObject({ hop: { username: 'postgres', sameHost: true } });
    expect(analyseCommandLine('wsl -d Ubuntu')).toMatchObject({ type: 'push', hop: { label: 'Ubuntu' } });
  });

  it('detects leaving a nested session', () => {
    expect(analyseCommandLine('exit')).toMatchObject({ type: 'pop' });
    expect(analyseCommandLine('logout')).toMatchObject({ type: 'pop' });
  });

  it('ignores ordinary commands', () => {
    expect(analyseCommandLine('ls -la')).toBeNull();
    expect(analyseCommandLine('echo ssh')).toBeNull();
    expect(analyseCommandLine('')).toBeNull();
  });
});

describe('parseUserSwitch', () => {
  it('reads every shape that ends in another account shell', () => {
    expect(parseUserSwitch('su')).toEqual({ user: 'root' });
    expect(parseUserSwitch('su -')).toEqual({ user: 'root' });
    expect(parseUserSwitch('su - postgres')).toEqual({ user: 'postgres' });
    expect(parseUserSwitch('su --login app')).toEqual({ user: 'app' });
    // The shape most people type. The `-` is what makes it a login shell.
    expect(parseUserSwitch('sudo su -')).toEqual({ user: 'root' });
    expect(parseUserSwitch('sudo -i')).toEqual({ user: 'root' });
    expect(parseUserSwitch('sudo -s')).toEqual({ user: 'root' });
    expect(parseUserSwitch('sudo --login')).toEqual({ user: 'root' });
    expect(parseUserSwitch('sudo bash')).toEqual({ user: 'root' });
    expect(parseUserSwitch('sudo -u app -i')).toEqual({ user: 'app' });
    expect(parseUserSwitch('sudo -iu app')).toEqual({ user: 'app' });
    expect(parseUserSwitch('sudo -u=app -s')).toEqual({ user: 'app' });
  });

  it('ignores a switch that runs a command and comes back', () => {
    expect(parseUserSwitch('su -c "systemctl restart nginx"')).toBeNull();
    expect(parseUserSwitch('sudo bash -c "systemctl restart nginx"')).toBeNull();
    expect(parseUserSwitch('sudo systemctl restart nginx')).toBeNull();
    expect(parseUserSwitch('sudo')).toBeNull();
    expect(parseUserSwitch('ssh root@198.18.0.9')).toBeNull();
  });

  it('is what analyseCommandLine reports, as a hop on the same machine', () => {
    expect(analyseCommandLine('sudo su -')).toMatchObject({
      type: 'push',
      hop: { username: 'root', sameHost: true },
    });
  });
});

describe('NestedDetector', () => {
  it('emits one push per completed typed line', () => {
    const detector = new NestedDetector(true);
    // The line arrives in two chunks: the address is split mid-octet.
    const signals = [...detector.feedInput('ssh root@198.18.'), ...detector.feedInput('0.9\r')];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: 'push', hop: { host: '198.18.0.9' } });
  });

  it('reads the line the shell would have run, not the keys that built it', () => {
    const detector = new NestedDetector(true);
    const signals = [
      ...detector.feedInput('ssh root@203.0.113.3'),
      // Backspace over the `3`, then a `4`: `.34` was never typed by anybody.
      ...detector.feedInput('\x7f4'),
      ...detector.feedInput('\r'),
    ];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: 'push', hop: { host: '203.0.113.4' } });
  });

  it('never moves before the line was submitted', () => {
    const detector = new NestedDetector(true);
    expect(detector.feedInput('ssh root@203.0.113.4')).toEqual([]);
    expect(detector.feedInput('\r')).toHaveLength(1);
  });

  it('drops the line on Ctrl-C, and stops trusting one the shell edited', () => {
    const detector = new NestedDetector(true);
    detector.feedInput('ssh root@203.0.113.3');
    expect(detector.feedInput('\x03')).toEqual([{ type: 'cancelled', reason: 'interrupted' }]);
    expect(detector.feedInput('\r')).toEqual([]);

    // Tab completion rewrites the word from the shell's side.
    expect([...detector.feedInput('ssh root@203.0.113.\t'), ...detector.feedInput('\r')]).toEqual([]);
  });
  it('reads the host out of an OSC title once', () => {
    const detector = new NestedDetector(true);
    const title = '\x1b]2;root@inner-01: ~\x07';
    const first = detector.feedOutput(title);
    const second = detector.feedOutput(title);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'title', host: 'inner-01', username: 'root' });
    expect(second).toHaveLength(0);
  });

  it('pops the chain when the connection reports closed', () => {
    const detector = new NestedDetector(true);
    const signals = detector.feedOutput('Shared connection to 198.18.0.9 closed.\r\n');
    expect(signals.some((signal) => signal.type === 'pop')).toBe(true);
  });

  it('stays silent when detection is disabled', () => {
    const detector = new NestedDetector(false);
    expect(detector.feedInput('ssh root@198.18.0.9\r')).toEqual([]);
    expect(detector.feedOutput('\x1b]2;root@h: ~\x07')).toEqual([]);
  });

  it('counts one logout once, not once per layer that reports it', () => {
    const detector = new NestedDetector(true);
    const at = 1_000_000;
    const signals = [
      ...detector.feedInput('exit\r', at),
      ...detector.feedOutput('\r\nlogout\r\n', at + 12),
      ...detector.feedOutput('Connection to 203.0.113.4 closed.\r\n', at + 20),
      ...detector.feedOutput('root@203.0.113.3:~# ', at + 40),
    ];
    expect(signals.filter((signal) => signal.type === 'pop')).toHaveLength(1);
  });

  it('lets a second exit the user typed end a second hop', () => {
    const detector = new NestedDetector(true);
    const at = 2_000_000;
    detector.feedInput('exit\r', at);
    detector.feedOutput('\r\nlogout\r\n', at + 10);
    detector.feedOutput('Connection to 203.0.113.4 closed.\r\n', at + 20);
    const next = [
      ...detector.feedInput('exit\r', at + 900),
      ...detector.feedOutput('\r\nlogout\r\n', at + 910),
    ];
    expect(next.filter((signal) => signal.type === 'pop')).toHaveLength(1);
  });

  it('pops once when the connection drops without a typed exit', () => {
    const detector = new NestedDetector(true);
    const at = 3_000_000;
    const signals = [
      ...detector.feedOutput('\r\nlogout\r\n', at),
      ...detector.feedOutput('Connection to 198.18.0.9 closed.\r\n', at + 8),
    ];
    expect(signals.filter((signal) => signal.type === 'pop')).toHaveLength(1);
  });

  it('reads a closed line split across two chunks exactly once', () => {
    const detector = new NestedDetector(true);
    const at = 4_000_000;
    const signals = [
      ...detector.feedOutput('Connection to 198.18.0.9 clo', at),
      ...detector.feedOutput('sed.\r\n', at + 5),
      ...detector.feedOutput('user@jump:~$ ', at + 40),
    ];
    expect(signals.filter((signal) => signal.type === 'pop')).toHaveLength(1);
  });
});

/**
 * A shell that takes itself away because nobody typed anything.
 *
 * `readonly TMOUT=600` in `/etc/profile` is how most servers enforce an idle
 * logout, and bash leaves with `timed out waiting for input: auto-logout` —
 * never with `logout`, which it only prints when an interactive login shell is
 * left by something the user did. So the typed-line and `logout` reports both
 * stay silent, and the only other evidence would be a prompt that names nothing.
 */
describe('a shell that timed itself out', () => {
  it('reports the departure the shell prints on its way out', () => {
    const detector = new NestedDetector(true);
    // What bash 5 actually writes: the bracketed-paste mode switched off, a CR,
    // then the BEL it rings before the message.
    const signals = detector.feedOutput('\x1b[?2004l\r\x07timed out waiting for input: auto-logout\r');
    expect(signals.filter((signal) => signal.type === 'pop')).toEqual([
      { type: 'pop', origin: 'printed', reason: 'timeout' },
    ]);
  });

  it('reads the message once when it arrives in two chunks', () => {
    const detector = new NestedDetector(true);
    const at = 5_000_000;
    const signals = [
      ...detector.feedOutput('timed out waiting for in', at),
      ...detector.feedOutput('put: auto-logout\r\n', at + 10),
    ];
    expect(signals.filter((signal) => signal.type === 'pop')).toHaveLength(1);
  });

  it('counts one departure, not a second one for the closed connection', () => {
    const detector = new NestedDetector(true);
    const at = 6_000_000;
    const signals = [
      ...detector.feedOutput('\r\x07timed out waiting for input: auto-logout\r', at),
      ...detector.feedOutput('Connection to 203.0.113.4 closed.\r\n', at + 30),
      ...detector.feedOutput('alice@203.0.113.2:~$ ', at + 60),
    ];
    expect(signals.filter((signal) => signal.type === 'pop')).toHaveLength(1);
  });

  it('does not read the words out of ordinary output', () => {
    const detector = new NestedDetector(true);
    // A file being printed, and a line that merely mentions the message.
    expect(detector.feedOutput('grep: timed out waiting for input: auto-logout\r\n')).toEqual([]);
    expect(detector.feedOutput('readonly TMOUT=600; export TMOUT\r\n')).toEqual([]);
  });
});