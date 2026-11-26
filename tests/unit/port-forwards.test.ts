import { describe, expect, it } from 'vitest';
import { buildSshSpecFromProfile, createSshProfile, normalizeSshProfiles } from '../../src/shared/profiles';
import { forwardEndpoint, validatePortForwards } from '../../src/shared/port-forwards';
import type { SshPortForward } from '../../src/shared/types';

const rule: SshPortForward = { mode: 'local', bindHost: '127.0.0.1', bindPort: 21380, targetHost: '127.0.0.1', targetPort: 21380 };

describe('saved forwarding rules', () => {
  it('retains multiple rules through serialization and session construction', () => {
    const profile = createSshProfile({ host: 'host', username: 'user', portForwards: [rule, { ...rule, mode: 'remote' }] });
    const restored = normalizeSshProfiles(JSON.parse(JSON.stringify([profile])))[0]!;
    const spec = buildSshSpecFromProfile(restored, { hostKeyPolicy: 'accept-new' });
    expect(spec?.kind === 'ssh' && spec.portForwards).toEqual(profile.portForwards);
    expect(createSshProfile().portForwards).toBeUndefined();
  });

  it.each([0, -1, 65536, 1.5, NaN, Infinity])('rejects invalid listener and destination port %s', (port) => {
    expect(validatePortForwards([{ ...rule, bindPort: port, targetPort: port }]).map((issue) => issue.field)).toEqual(['bindPort', 'targetPort']);
  });

  it('does not discard or repair malformed rules into an unintended tunnel', () => {
    const profile = normalizeSshProfiles([{ host: 'host', username: 'user', portForwards: [null, { ...rule, mode: 'dynamic' }] }])[0]!;
    expect(profile.portForwards).toHaveLength(2);
    expect(buildSshSpecFromProfile(profile, { hostKeyPolicy: 'accept-new' })).toBeNull();
    expect(validatePortForwards({})).not.toEqual([]);
  });

  it('rejects blank hosts and duplicate listeners but allows one listener per mode', () => {
    expect(validatePortForwards([{ ...rule, bindHost: ' ', targetHost: 'bad host' }])).toHaveLength(2);
    expect(validatePortForwards([rule, { ...rule, targetPort: 80 }])[0]?.key).toBe('connections.forwardDuplicate');
    expect(validatePortForwards([rule, { ...rule, mode: 'remote' }])).toEqual([]);
  });

  it('normalizes IPv6 brackets without treating address colons as port separators', () => {
    const profile = createSshProfile({ portForwards: [{ ...rule, bindHost: ' [::1] ', targetHost: '::1' }] });
    expect(profile.portForwards?.[0]?.bindHost).toBe('::1');
    expect(validatePortForwards(profile.portForwards)).toEqual([]);
    expect(forwardEndpoint('::1', 21380)).toBe('[::1]:21380');
  });
});
