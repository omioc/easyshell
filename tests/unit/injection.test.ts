import { describe, expect, it } from 'vitest';
import {
  buildShellInjection,
  injectionTailToDisplay,
  isBarePromptRepaint,
  looksLikeCredentialPrompt,
  looksLikePasswordPrompt,
  looksLikePromptTail,
  passwordPromptTarget,
  promptIdentity,
  promptOnScreen,
  stripAnsi,
} from '../../src/main/session/injection';

const TOKEN = 'abc1234567';

describe('buildShellInjection', () => {
  const { line, beginMarker, endMarker } = buildShellInjection(TOKEN, 'echo hi');

  it('keeps the markers out of the echoed line', () => {
    expect(beginMarker).toBe(`EASYSHELL-ESB-${TOKEN}`);
    expect(endMarker).toBe(`EASYSHELL-ESE-${TOKEN}`);
    // The shell echoes everything it is given: a verbatim marker would be
    // mistaken for the start of the capture.
    expect(line).not.toContain(beginMarker);
    expect(line).not.toContain(endMarker);
  });

  it('types a line the user is not meant to notice', () => {
    expect(line.startsWith(' ')).toBe(true);
  });

  it('removes its own history entry, but only its own', () => {
    expect(line).toContain(`*"YSHELL-ESB-${TOKEN}"*`);
    expect(line).toContain('history -d -1');
    // The check has to come first: shells that never record the line
    // (HISTCONTROL=ignorespace, fish) would otherwise lose the previous command.
    expect(line.indexOf('history 1')).toBeLessThan(line.indexOf('history -d -1'));
  });

  it('still reports the exit code of the command, not of the cleanup', () => {
    const status = line.indexOf(`__easyshell_code=$?`);
    const cleanup = line.indexOf('history -d -1');
    const marker = line.indexOf('printf');
    expect(status).toBeGreaterThan(line.indexOf('{ echo hi ; } 2>&1'));
    expect(status).toBeLessThan(cleanup);
    expect(line.lastIndexOf(`"$__easyshell_code"`)).toBeGreaterThan(cleanup);
    expect(marker).toBeGreaterThan(0);
  });
});

describe('injectionTailToDisplay', () => {
  it('drops the prompt the shell repaints', () => {
    expect(injectionTailToDisplay('root@node-01:~# ')).toBe('');
    expect(injectionTailToDisplay('\r\nroot@node-01:~# \x1b[?25h')).toBe('');
    expect(injectionTailToDisplay('')).toBe('');
    expect(injectionTailToDisplay('\r\n')).toBe('');
  });

  it('drops a repaint that the shell painted more than once', () => {
    expect(injectionTailToDisplay('root@node-01:~# root@node-01:~# ')).toBe('');
    expect(
      injectionTailToDisplay(
        '\x1b[?2004h\x1b[32mroot@node-01\x1b[m:~# \r\nroot@node-01:~# ',
        'root@node-01:~#',
      ),
    ).toBe('');
  });

  it('drops a repaint even when the prompt has no punctuation to go on', () => {
    // A theme prompt such as `~/src ❯` is not prompt-shaped by regex, but it is
    // still exactly what was on screen before the injection.
    expect(injectionTailToDisplay('~/src \u276f ', '~/src \u276f')).toBe('');
  });

  it('shows anything a prompt repaint cannot explain', () => {
    expect(injectionTailToDisplay('job 1 finished\r\nroot@host:~# ')).toBe(
      '\r\njob 1 finished\r\nroot@host:~# ',
    );
    expect(injectionTailToDisplay('some output')).toBe('\r\nsome output');
  });
});

describe('promptOnScreen', () => {
  it('reads the last line without escape sequences', () => {
    expect(promptOnScreen('output\r\n\x1b]0;t\x07root@srv:~# ')).toBe('root@srv:~#');
    expect(promptOnScreen('')).toBe('');
  });
});

describe('isBarePromptRepaint', () => {
  const prompt = 'root@node-01:~#';

  it('recognises the repaint a slow shell paints after the injection', () => {
    expect(isBarePromptRepaint('root@node-01:~# ', prompt)).toBe(true);
    expect(isBarePromptRepaint('\x1b[?2004h\x1b[32mroot@node-01\x1b[m:~# \x1b]0;t\x07', prompt)).toBe(
      true,
    );
    expect(isBarePromptRepaint('\x1b[?25h\u276f ', '\u276f')).toBe(true);
  });

  it('leaves anything that starts a new line alone', () => {
    // Pressing Enter at an empty prompt prints a new line and a new prompt.
    expect(isBarePromptRepaint('\r\nroot@node-01:~# ', prompt)).toBe(false);
    expect(isBarePromptRepaint('\n', prompt)).toBe(false);
  });

  it('never hides a prompt the user is not looking at', () => {
    // Leaving a nested login with `exit`: the machine underneath paints its own
    // prompt. Swallowing it as a "repaint" leaves a terminal with no prompt.
    expect(isBarePromptRepaint('root@bastion:~# ', prompt)).toBe(false);
    expect(isBarePromptRepaint('alice@node-01:~$ ', prompt)).toBe(false);
    // Nothing is known about what is on screen, so nothing may be hidden.
    expect(isBarePromptRepaint('root@node-01:~# ', '')).toBe(false);
  });

  it('never eats a real redraw or real output', () => {
    // Ctrl-L: clear plus a redraw.
    expect(isBarePromptRepaint('\x1b[H\x1b[2Jroot@node-01:~# ', prompt)).toBe(false);
    expect(isBarePromptRepaint('root@node-01:~# ls -la', prompt)).toBe(false);
    expect(isBarePromptRepaint('make: done', prompt)).toBe(false);
  });
});

describe('looksLikePromptTail', () => {
  it('recognises the usual prompts', () => {
    expect(looksLikePromptTail('root@node-01:~# ')).toBe(true);
    expect(looksLikePromptTail('\x1b]0;title\x07alice@alice:/mnt/c$ ')).toBe(true);
    expect(looksLikePromptTail('>>> ')).toBe(true);
  });

  it('does not mistake a typed line for a prompt', () => {
    expect(looksLikePromptTail('root@node-01:~# echo hi')).toBe(false);
    expect(looksLikePromptTail('apt install foo')).toBe(false);
  });
});

describe('promptIdentity', () => {
  it('reads both prompt shapes a Linux shell paints', () => {
    expect(promptIdentity('root@node-01:~# ')).toEqual({
      username: 'root',
      hostname: 'node-01',
    });
    // CentOS / Kylin / RHEL default: bracketed, with the cwd instead of `~`.
    expect(promptIdentity('[bob@demo-instance bob]$ ')).toEqual({
      username: 'bob',
      hostname: 'demo-instance',
    });
    expect(promptIdentity('make[1]: done\n[bob@build-host src]# ')).toEqual({
      username: 'bob',
      hostname: 'build-host',
    });
  });

  it('ignores anything that is not a prompt', () => {
    expect(promptIdentity('root@node-01:~# echo hi')).toBeNull();
    expect(promptIdentity('')).toBeNull();
    expect(promptIdentity('scp bob@host:/tmp/file .')).toBeNull();
  });

  it('reads the run the cursor ends on, not the one the line started with', () => {
    // The prompt of the shell underneath is painted at column 0 of the line the
    // hop stopped on: a bare CR, never a line break.
    expect(promptIdentity('root@node-01:/home/bob# \rbob@node-01:~$ ')).toEqual({
      username: 'bob',
      hostname: 'node-01',
    });
    // The same shape after the report an idle logout prints on its way out.
    expect(promptIdentity('timed out waiting for input: auto-logout\rbob@node-01:~$ ')).toEqual({
      username: 'bob',
      hostname: 'node-01',
    });
  });
});

describe('looksLikeCredentialPrompt', () => {
  it('recognises the prompts that read the answer from this tty', () => {
    expect(looksLikeCredentialPrompt("root@203.0.113.3's password: ")).toBe(true);
    expect(looksLikeCredentialPrompt('Password:')).toBe(true);
    expect(looksLikeCredentialPrompt('[sudo] password for root: ')).toBe(true);
    expect(looksLikeCredentialPrompt("Enter passphrase for key '/root/.ssh/id_rsa': ")).toBe(true);
    expect(
      looksLikeCredentialPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? '),
    ).toBe(true);
    expect(looksLikeCredentialPrompt('Verification code: ')).toBe(true);
  });

  it('leaves a shell prompt alone', () => {
    expect(looksLikeCredentialPrompt('root@harbor-node:~# ')).toBe(false);
    expect(looksLikeCredentialPrompt('[bob@build-host src]$ ')).toBe(false);
    expect(looksLikeCredentialPrompt('')).toBe(false);
  });

  it('only reads the last line: output above the prompt is not the prompt', () => {
    expect(looksLikeCredentialPrompt("password: \r\nroot@harbor-node:~# ")).toBe(false);
  });
});

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\x1b[1;32mhello\x1b[0m \x1b]0;t\x07')).toBe('hello ');
  });
});

describe('passwordPromptTarget', () => {
  it('names the login a prompt is asking about', () => {
    expect(passwordPromptTarget("alice@203.0.113.13's password: ")).toEqual({
      username: 'alice',
      host: '203.0.113.13',
    });
    expect(passwordPromptTarget('Password for bob@bastion: ')).toEqual({ username: 'bob', host: 'bastion' });
  });

  it('reads the keyboard-interactive prompt the OpenSSH client paints', () => {
    // What `ssh` prints on a host that offers keyboard-interactive auth — which
    // Debian, Ubuntu and most appliances do, and which the client prefers.
    expect(passwordPromptTarget('(alice@203.0.113.13) Password: ')).toEqual({
      username: 'alice',
      host: '203.0.113.13',
    });
    expect(looksLikePasswordPrompt('(alice@203.0.113.13) Password: ')).toBe(true);
    expect(passwordPromptTarget('\x1b[m(alice@host4) Password: ')).toEqual({ username: 'alice', host: 'host4' });
  });

  it('does not claim a prompt that names nobody', () => {
    // `sudo` and `su` ask about the account already in use: the machine comes
    // from the hop the user stands on, not from the prompt.
    expect(passwordPromptTarget('[sudo] password for alice: ')).toBeNull();
    expect(passwordPromptTarget('Password: ')).toBeNull();
    // A confirmation is not a password, and a bracket around a host alone names
    // no login.
    expect(passwordPromptTarget('(yes/no) password: ')).toBeNull();
    expect(passwordPromptTarget('(host4) Password: ')).toBeNull();
  });
});
