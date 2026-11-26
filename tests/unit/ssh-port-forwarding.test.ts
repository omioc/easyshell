import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { Server } from 'ssh2';
import type { Connection } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSshSession } from '../../src/main/session/ssh';
import type { KnownHostsStore } from '../../src/main/session/known-hosts';
import type { SessionBackend } from '../../src/main/session/types';
import type { Settings, SshPortForward } from '../../src/shared/types';

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
let sshServer: Server;
let sshPort: number;
let destinationPort: number;
let rejectRemote: boolean;
let rejectShell: boolean;
let backend: SessionBackend | undefined;
const connections = new Set<Connection>();
const servers = new Set<NetServer>();
const streams = new Set<Duplex>();
const onError = vi.fn();
const onForwardError = vi.fn();
const onExit = vi.fn();

function track<T extends Duplex>(stream: T): T {
  streams.add(stream);
  stream.on('error', () => {});
  stream.on('close', () => streams.delete(stream));
  return stream;
}

async function listen(server: NetServer, port = 0): Promise<number> {
  servers.add(server);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function rule(mode: SshPortForward['mode'], bindPort: number, targetPort = destinationPort): SshPortForward {
  return { mode, bindHost: '127.0.0.1', bindPort, targetHost: '127.0.0.1', targetPort };
}

async function start(portForwards: SshPortForward[]): Promise<SessionBackend> {
  backend = await startSshSession({
    spec: {
      kind: 'ssh', portForwards,
      target: { host: '127.0.0.1', port: sshPort, username: 'test', auth: { type: 'password', password: 'test' }, hostKeyPolicy: 'accept-new' },
    },
    settings: { ssh: { keepAliveSeconds: 0 } } as Settings,
    knownHosts: { verify: () => ({ ok: true }) } as unknown as KnownHostsStore,
    handlers: { onData: () => {}, onStatus: () => {}, onError, onForwardError, onExit },
    cols: 80, rows: 24,
  });
  return backend;
}

/** Destination waits for EOF before replying, exercising TCP half-close. */
async function exchange(port: number, payload = 'hello tunnel'): Promise<string> {
  const socket = track(createConnection({ host: '127.0.0.1', port }));
  socket.setTimeout(3000, () => socket.destroy(new Error('Timed out')));
  let result = '';
  socket.on('data', (chunk) => { result += chunk.toString(); });
  const ended = once(socket, 'end');
  socket.end(payload);
  await ended;
  return result;
}

beforeEach(async () => {
  rejectRemote = false;
  rejectShell = false;
  backend = undefined;
  onError.mockClear();
  onForwardError.mockClear();
  onExit.mockClear();
  destinationPort = await listen(createServer({ allowHalfOpen: true }, (raw) => {
    const socket = track(raw);
    let input = '';
    socket.on('data', (chunk) => { input += chunk.toString(); });
    socket.on('end', () => socket.end(`reply:${input}`));
  }));
  sshServer = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    const remoteListeners = new Map<number, NetServer>();
    connection.on('error', () => {});
    connection.on('close', () => {
      connections.delete(connection);
      for (const server of remoteListeners.values()) server.close();
    });
    connection.on('authentication', (context) => context.accept());
    connection.on('session', (accept, reject) => {
      if (rejectShell) { reject(); return; }
      const session = accept();
      session.on('pty', (acceptPty) => acceptPty?.());
      session.on('shell', (acceptShell) => { track(acceptShell()); });
    });
    connection.on('tcpip', (accept, _reject, info) => {
      const channel = track(accept());
      const socket = track(createConnection({ host: info.destIP, port: info.destPort, allowHalfOpen: true }));
      socket.on('error', () => channel.destroy());
      channel.on('close', () => socket.destroySoon());
      socket.pipe(channel).pipe(socket);
    });
    connection.on('request', (accept, reject, name, info) => {
      if (name === 'cancel-tcpip-forward') {
        remoteListeners.get(info.bindPort)?.close();
        remoteListeners.delete(info.bindPort);
        accept?.();
        return;
      }
      if (rejectRemote) { reject?.(); return; }
      const server = createServer({ allowHalfOpen: true }, (raw) => {
        const socket = track(raw);
        connection.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress!, socket.remotePort!, (error, channel) => {
          if (error) { socket.destroy(); return; }
          track(channel);
          channel.on('close', () => socket.destroySoon());
          socket.on('error', () => channel.destroy());
          // ssh2 server channels close on finish; send EOF without closing the
          // reverse direction, as an SSH daemon does for a half-closed socket.
          socket.on('end', () => channel.write(Buffer.alloc(0), () => channel.eof()));
          socket.pipe(channel, { end: false }).pipe(socket);
        });
      });
      servers.add(server);
      server.on('error', () => reject?.());
      server.listen(info.bindPort, info.bindAddr, () => {
        remoteListeners.set(info.bindPort, server);
        accept?.();
      });
    });
  });
  sshServer.listen(0, '127.0.0.1');
  await once(sshServer, 'listening');
  sshPort = (sshServer.address() as { port: number }).port;
});

afterEach(async () => {
  // A session that now connects (a failed tunnel no longer fails it) has to be
  // killed *and* its exit awaited here: the exit arrives on a later tick, and an
  // exit landing after the next test cleared these spies would be counted there.
  if (backend) {
    backend.kill();
    await new Promise((resolve) => setTimeout(resolve, 50));
    backend = undefined;
  }
  for (const connection of connections) connection.end();
  for (const stream of streams) stream.destroy();
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
  await new Promise<void>((resolve) => sshServer.close(() => resolve()));
});

describe('SSH port forwarding over a real SSH transport', () => {
  it('transfers local and remote traffic, including replies after EOF', async () => {
    const local = await freePort();
    const remote = await freePort();
    await start([rule('local', local), rule('remote', remote)]);
    expect(await exchange(local)).toBe('reply:hello tunnel');
    expect(await exchange(remote)).toBe('reply:hello tunnel');
    expect(onError).not.toHaveBeenCalled();
  });

  it('closes active sockets and releases both listeners when the session is killed', async () => {
    const local = await freePort();
    const remote = await freePort();
    await start([rule('local', local), rule('remote', remote)]);
    const socket = track(createConnection({ host: '127.0.0.1', port: local }));
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    backend!.kill();
    await closed;
    await expect.poll(() => onExit.mock.calls.length).toBe(1);
    await expect.poll(() => connections.size).toBe(0);
    expect(await listen(createServer(), local)).toBe(local);
    expect(await listen(createServer(), remote)).toBe(remote);
  });

  it('flushes responses larger than the SSH channel window without truncation', async () => {
    const local = await freePort();
    const remote = await freePort();
    await start([rule('local', local), rule('remote', remote)]);
    const payload = 'forwarded data '.repeat(200_000);
    const localReply = await exchange(local, payload);
    expect(localReply.length).toBe(payload.length + 6);
    expect(localReply === `reply:${payload}`).toBe(true);
    const remoteReply = await exchange(remote, payload);
    expect(remoteReply.length).toBe(payload.length + 6);
    expect(remoteReply === `reply:${payload}`).toBe(true);
  });

  it('keeps the session and the working tunnels when one listener cannot bind', async () => {
    const local = await freePort();
    // The destination server already holds this port, so the second rule fails.
    await start([rule('local', local), rule('local', destinationPort)]);
    await expect.poll(() => onForwardError.mock.calls.length).toBe(1);
    expect(onForwardError.mock.calls[0]?.[0]).toMatchObject({
      rule: `-L 127.0.0.1:${destinationPort} → 127.0.0.1:${destinationPort}`,
      detail: expect.stringMatching(/EADDRINUSE/),
    });
    // The tunnel that did come up is untouched, and the tab is still a session.
    expect(await exchange(local)).toBe('reply:hello tunnel');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports a rejected remote forward without losing the local tunnel', async () => {
    rejectRemote = true;
    const local = await freePort();
    await start([rule('local', local), rule('remote', await freePort())]);
    await expect.poll(() => onForwardError.mock.calls.length).toBe(1);
    expect(onForwardError.mock.calls[0]?.[0]).toMatchObject({
      rule: expect.stringContaining('-R '),
    });
    expect(onExit).not.toHaveBeenCalled();
    expect(await exchange(local)).toBe('reply:hello tunnel');
  });

  it('cleans up listeners if opening the shell fails', async () => {
    rejectShell = true;
    const local = await freePort();
    await expect(start([rule('local', local)])).rejects.toThrow();
    expect(await listen(createServer(), local)).toBe(local);
  });

  it('releases listeners when the SSH server disconnects', async () => {
    const local = await freePort();
    await start([rule('local', local)]);
    for (const connection of connections) connection.end();
    await expect.poll(() => onExit.mock.calls.length).toBe(1);
    expect(await listen(createServer(), local)).toBe(local);
  });

  it('reports an invalid forwarding configuration without failing the session', async () => {
    await start([rule('local', 0)]);
    expect(onForwardError).toHaveBeenCalledTimes(1);
    expect(onForwardError.mock.calls[0]?.[0]).toMatchObject({
      detail: expect.stringMatching(/Invalid SSH port forwarding/),
    });
    expect(onExit).not.toHaveBeenCalled();
  });
});
