import { describe, expect, it } from 'vitest';
import {
  adoptAddress,
  adoptPrompt,
  adoptTitle,
  candidateMatches,
  commitHop,
  endpointFromChain,
  popHop,
  pushHop,
} from '../../src/main/metadata/chain';
import type { SessionHop } from '../../src/shared/types';

const TTL = 20_000;

/** The bastion endpoint: an address and the account the SSH client dialed. */
function bastion(): SessionHop {
  return {
    label: 'sso-demo@192.0.2.6',
    host: '192.0.2.6',
    username: 'sso-demo',
    port: 60022,
    detectedBy: 'session',
    confidence: 'high',
    at: 0,
  };
}

/** `ssh bob@198.51.100.119` typed inside the bastion tab. */
function typedSsh(at = 1000): SessionHop {
  return {
    label: 'bob@198.51.100.119',
    host: '198.51.100.119',
    username: 'bob',
    port: 22,
    detectedBy: 'command-line',
    confidence: 'high',
    at,
  };
}

describe('pushHop', () => {
  it('keeps the address the command dialed', () => {
    const chain = [bastion()];
    const update = pushHop(chain, typedSsh());
    expect(update).toEqual({ changed: true, machineChanged: true });
    expect(chain).toHaveLength(2);
    expect(chain[1]?.host).toBe('198.51.100.119');
  });

  it('inherits the machine for a hop that only changes the user', () => {
    const chain = [bastion(), { ...typedSsh(), hostname: 'inner-01' }];
    const update = pushHop(chain, {
      label: 'root (su)',
      username: 'root',
      sameHost: true,
      detectedBy: 'command-line',
      confidence: 'low',
      at: 2000,
    });
    // The machine did not change, so nothing already learned about it is stale.
    expect(update).toEqual({ changed: true, machineChanged: false });
    expect(chain[2]).toMatchObject({
      host: '198.51.100.119',
      hostname: 'inner-01',
      port: 22,
      username: 'root',
    });
  });
});

describe('adoptTitle', () => {
  it('records the name a machine uses for itself without losing the address', () => {
    const chain = [bastion(), typedSsh()];
    const update = adoptTitle(chain, {
      host: 'demo-instance',
      username: 'bob',
      label: 'bob@demo-instance',
    });
    expect(update).toEqual({ changed: true, machineChanged: false });
    expect(chain[1]).toMatchObject({
      label: 'bob@demo-instance',
      host: '198.51.100.119',
      hostname: 'demo-instance',
      port: 22,
    });
  });

  it('never renames the first hop, and ignores a repeated title', () => {
    const chain = [bastion()];
    expect(adoptTitle(chain, { host: 'jump', label: 'jump' }).changed).toBe(false);
    expect(chain[0]?.label).toBe('sso-demo@192.0.2.6');

    const inner = [bastion(), typedSsh()];
    adoptTitle(inner, { host: 'inner-01', username: 'bob', label: 'bob@inner-01' });
    const again = adoptTitle(inner, { host: 'inner-01', username: 'bob', label: 'bob@inner-01' });
    expect(again.changed).toBe(false);
  });
});

describe('adoptPrompt', () => {
  /** The prompt the machine behind a typed `ssh` paints once the login lands. */
  const landed = { username: 'bob', hostname: 'demo-instance', at: 2000, ttlMs: TTL };

  it('commits the hop a typed line was aiming at, keeping the address it dialed', () => {
    const chain = [bastion()];
    const update = adoptPrompt(chain, landed, { loggedIn: false, candidate: typedSsh(1000) });
    expect(update.move).toBe('entered');
    expect(chain).toHaveLength(2);
    expect(chain[1]).toMatchObject({
      label: 'bob@demo-instance',
      host: '198.51.100.119',
      hostname: 'demo-instance',
      port: 22,
      detectedBy: 'prompt',
      confidence: 'high',
    });
  });

  it('leaves the chain alone when the prompt is not where the typed line pointed', () => {
    const chain = [bastion()];
    const update = adoptPrompt(
      chain,
      { username: 'nobody', hostname: 'elsewhere', at: 2000, ttlMs: TTL },
      { loggedIn: false, candidate: typedSsh(1000) },
    );
    expect(update).toEqual({ changed: false, machineChanged: false, move: 'cancelled' });
    expect(chain).toHaveLength(1);
  });

  it('does not invent a hop from a prompt when the machine has no name', () => {
    // Both halves are unknown, so nothing says this is the same machine: stay put.
    const quiet: SessionHop[] = [bastion()];
    const identity = { username: 'bob', hostname: 'third-01', at: 2000, ttlMs: TTL };
    expect(adoptPrompt(quiet, identity, { loggedIn: false }).move).toBe('none');
    expect(quiet).toHaveLength(1);
  });

  it('only believes a machine it does not know after a login banner', () => {
    const chain: SessionHop[] = [bastion()];
    const identity = { username: 'bob', hostname: 'third-01', at: 2000, ttlMs: TTL };
    expect(adoptPrompt(chain, identity, { loggedIn: true }).move).toBe('moved');
    expect(chain).toHaveLength(2);
    expect(chain[1]).toMatchObject({ host: 'third-01', hostname: 'third-01', detectedBy: 'prompt' });
  });

  it('only renames for the account and machine the top hop already names', () => {
    const chain = [bastion(), { ...typedSsh(), hostname: 'inner-01' }];
    const update = adoptPrompt(chain, { username: 'bob', hostname: 'inner-01', at: 2000, ttlMs: TTL }, { loggedIn: false });
    expect(update.move).toBe('renamed');
    expect(chain).toHaveLength(2);
    // The address it was dialed on stays, and so does everything else.
    expect(chain[1]).toMatchObject({ label: 'bob@inner-01', host: '198.51.100.119', hostname: 'inner-01' });
  });

  it('steps back when the prompt belongs to a hop further down', () => {
    const su: SessionHop = {
      label: 'root@inner-01',
      username: 'root',
      sameHost: true,
      detectedBy: 'prompt',
      confidence: 'high',
      at: 3000,
    };
    const chain = [bastion(), { ...typedSsh(), hostname: 'inner-01' }, su];
    const update = adoptPrompt(chain, { username: 'bob', hostname: 'inner-01', at: 4000, ttlMs: TTL }, { loggedIn: false });
    expect(update).toMatchObject({ changed: true, machineChanged: false, move: 'back' });
    expect(chain).toHaveLength(2);
  });
});

describe('commitHop', () => {
  it('gives a same-host switch the machine it happens on', () => {
    const chain = [bastion(), { ...typedSsh(), hostname: 'inner-01' }];
    const update = commitHop(
      chain,
      {
        label: 'root (su)',
        username: 'root',
        sameHost: true,
        detectedBy: 'command-line',
        confidence: 'low',
        at: 3000,
      },
      { source: 'prompt', hostname: 'inner-01', username: 'root' },
    );
    expect(update).toEqual({ changed: true, machineChanged: false });
    expect(chain[2]).toMatchObject({
      label: 'root@inner-01',
      host: '198.51.100.119',
      hostname: 'inner-01',
      port: 22,
      username: 'root',
      sameHost: true,
    });
  });
});

describe('candidateMatches', () => {
  it('accepts the name a hop dialed by address learns on arrival', () => {
    expect(candidateMatches(typedSsh(), { username: 'bob', hostname: 'inner-01' })).toBe(true);
  });

  it('refuses another account, and another name once it knows one', () => {
    expect(candidateMatches(typedSsh(), { username: 'root', hostname: 'inner-01' })).toBe(false);
    const named = { ...typedSsh(), hostname: 'inner-01' };
    expect(candidateMatches(named, { username: 'bob', hostname: 'inner-02' })).toBe(false);
  });
});

describe('popHop', () => {
  it('leaves the machine data alone when only the user is given back', () => {
    const su: SessionHop = {
      label: 'root (su)',
      sameHost: true,
      username: 'root',
      detectedBy: 'command-line',
      confidence: 'low',
      at: 3000,
    };
    const chain: SessionHop[] = [bastion(), typedSsh(), su];
    expect(chain).toHaveLength(3);
    expect(popHop(chain)).toEqual({ changed: true, machineChanged: false });
    expect(chain).toHaveLength(2);
    expect(popHop(chain)).toEqual({ changed: true, machineChanged: true });
    expect(chain).toHaveLength(1);
  });

  it('never empties the chain', () => {
    const chain = [bastion()];
    expect(popHop(chain)).toEqual({ changed: false, machineChanged: false });
    expect(chain).toHaveLength(1);
  });
});

describe('endpointFromChain', () => {
  it('mirrors the top hop, address and hostname included', () => {
    const chain: SessionHop[] = [
      bastion(),
      { ...typedSsh(), hostname: 'demo-instance' },
    ];
    expect(endpointFromChain(chain)).toEqual({
      displayName: 'bob@198.51.100.119',
      host: '198.51.100.119',
      hostname: 'demo-instance',
      port: 22,
      username: 'bob',
    });
    expect(endpointFromChain([])).toBeNull();
  });
});

describe('adoptAddress', () => {
  /** `ssh node-01` typed: the hop has a name and no address. */
  function namedHop(): SessionHop {
    return {
      label: 'root@node-01',
      host: 'node-01',
      hostname: 'node-01',
      username: 'root',
      port: 22,
      detectedBy: 'osc-title',
      confidence: 'medium',
      at: 1000,
    };
  }

  it('fills in the address a hop dialed by name never had', () => {
    const chain: SessionHop[] = [bastion(), namedHop()];
    const update = adoptAddress(chain, { hostname: 'node-01', ips: ['203.0.113.3'] });
    expect(update).toEqual({ changed: true, machineChanged: false });
    expect(chain[1]).toMatchObject({ host: '203.0.113.3', hostname: 'node-01' });
  });

  it('never replaces an address the session was dialed on', () => {
    const chain: SessionHop[] = [bastion(), typedSsh()];
    const update = adoptAddress(chain, { ips: ['192.0.2.99'] });
    expect(update).toEqual({ changed: false, machineChanged: false });
    expect(chain[1]?.host).toBe('198.51.100.119');
  });

  it('prefers the network it was reached from over a container bridge', () => {
    const chain: SessionHop[] = [bastion(), namedHop()];
    adoptAddress(chain, { ips: ['198.18.17.1', '192.0.2.9'] });
    expect(chain[1]?.host).toBe('192.0.2.9');
  });

  it('ignores loopback addresses and keeps the name when nothing is left', () => {
    const chain: SessionHop[] = [bastion(), namedHop()];
    const update = adoptAddress(chain, { ips: ['127.0.0.1', '169.254.1.1'] });
    expect(update.changed).toBe(false);
    expect(chain[1]?.host).toBe('node-01');
  });

  it('keeps the name it was dialed on when the machine names itself too', () => {
    const chain: SessionHop[] = [bastion(), { ...typedSsh(), host: 'node-02', hostname: undefined }];
    adoptAddress(chain, { hostname: 'node-02', ips: ['198.51.100.7'] });
    expect(chain[1]).toMatchObject({ host: '198.51.100.7', hostname: 'node-02' });
  });

  it('ignores facts about a machine the hop is not on', () => {
    const chain: SessionHop[] = [bastion(), namedHop()];
    const update = adoptAddress(chain, { hostname: 'node-02', ips: ['203.0.113.4'] });
    expect(update).toEqual({ changed: false, machineChanged: false });
    expect(chain[1]).toMatchObject({ host: 'node-01', hostname: 'node-01' });
  });

  it('accepts the short form of the name the hop already knows', () => {
    const chain: SessionHop[] = [bastion(), { ...namedHop(), hostname: 'node-01.example.com' }];
    adoptAddress(chain, { hostname: 'node-01', ips: ['203.0.113.3'] });
    expect(chain[1]?.host).toBe('203.0.113.3');
  });
});
