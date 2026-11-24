import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/shared/types';
import type { SessionSpecSsh } from '../../src/shared/types';
import type { KnownHostsStore } from '../../src/main/session/known-hosts';

/**
 * A stand-in for the `ssh2` client: the tests drive the events a real host would
 * produce, and `shell()` is recorded so we can prove a test never asks for one.
 */
const handlers = new Map<string, (...args: unknown[]) => void>();
const calls: string[] = [];
let onConnect: (config: unknown) => void = () => {};

vi.mock('ssh2', () => {
  class Client {
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return this;
    }
    removeAllListeners() {
      handlers.clear();
      return this;
    }
    end() {
      calls.push('end');
      return this;
    }
    shell() {
      calls.push('shell');
    }
    connect(config: unknown) {
      calls.push('connect');
      onConnect(config);
    }
  }
  return { Client };
});

const { testSshConnection } = await import('../../src/main/session/ssh');

const spec: SessionSpecSsh = {
  kind: 'ssh',
  target: {
    host: '198.18.0.5',
    port: 22,
    username: 'root',
    auth: { type: 'password', password: 'secret' },
    hostKeyPolicy: 'accept-new',
  },
};

const options = {
  spec,
  settings: { ssh: { keepAliveSeconds: 0 } } as unknown as Settings,
  knownHosts: { verify: () => ({ ok: true }) } as unknown as KnownHostsStore,
};

const emit = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args);

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  onConnect = () => {};
});

describe('testing a host before saving it', () => {
  it('resolves once the host is ready and hangs up without a shell', async () => {
    onConnect = () => queueMicrotask(() => emit('ready'));
    await expect(testSshConnection(options)).resolves.toBeUndefined();
    expect(calls).toContain('connect');
    expect(calls).toContain('end');
    expect(calls).not.toContain('shell');
  });

  it('rejects with the reason the host gave', async () => {
    onConnect = () => queueMicrotask(() => emit('error', new Error('All configured authentication methods failed')));
    await expect(testSshConnection(options)).rejects.toThrow('All configured authentication methods failed');
  });

  it('rejects when the host hangs up before it is ready', async () => {
    onConnect = () => queueMicrotask(() => emit('close'));
    await expect(testSshConnection(options)).rejects.toThrow(/closed the connection/i);
  });

  it('rejects without connecting when the key cannot be read', async () => {
    const keyed: SessionSpecSsh = {
      ...spec,
      target: { ...spec.target, auth: { type: 'key', privateKeyPath: 'Z:/does/not/exist' } },
    };
    await expect(testSshConnection({ ...options, spec: keyed })).rejects.toThrow();
    expect(calls).not.toContain('connect');
  });

  it('answers a keyboard-interactive prompt with the stored password', async () => {
    let answered: string[] = [];
    onConnect = () =>
      queueMicrotask(() =>
        emit('keyboard-interactive', 'user', 'instructions', 'en', [], (responses: string[]) => {
          answered = responses;
        }),
      );
    void testSshConnection(options);
    await Promise.resolve();
    await Promise.resolve();
    expect(answered).toEqual(['secret']);
  });
});
