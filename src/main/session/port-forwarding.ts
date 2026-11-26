import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2';
import { forwardRuleLabel, normalizePortForwards, validatePortForwards } from '../../shared/port-forwards';
import type { PortForwardFailure } from '../../shared/port-forwards';
import type { SshPortForward } from '../../shared/types';

const TIMEOUT_MS = 20_000;

/** Owns all listeners and traffic channels for a single SSH session. */
export class SshPortForwarding {
  private readonly servers = new Set<Server>();
  private readonly streams = new Set<Duplex>();
  private readonly remoteRules: SshPortForward[] = [];
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly rules: SshPortForward[] | undefined,
    /**
     * Told about every tunnel that did not come up.
     *
     * A tunnel is something the user asked for *on top of* the session, so a
     * failure here is a message, not a reason to fail the login: a port already
     * taken on either side says nothing about whether the shell works.
     */
    private readonly onFailure: (failure: PortForwardFailure) => void,
  ) {}

  /**
   * Brings every rule up, one at a time.
   *
   * A rule that fails does not stop the next one, and does not take down the
   * listeners that are already working: two tunnels are two things, and the
   * user asked for both.
   */
  async start(): Promise<void> {
    if (validatePortForwards(this.rules).length) {
      this.onFailure({ rule: '', detail: 'Invalid SSH port forwarding configuration' });
      return;
    }
    this.client.on('tcp connection', this.onRemoteConnection);
    for (const rule of normalizePortForwards(this.rules) ?? []) {
      if (this.closed) return;
      try {
        await this.startRule(rule);
      } catch (error) {
        // A remote listener that was refused is not registered on the far side,
        // so the rule must not stay in the table traffic is matched against.
        if (rule.mode === 'remote') {
          const at = this.remoteRules.indexOf(rule);
          if (at >= 0) this.remoteRules.splice(at, 1);
        }
        this.onFailure(this.failure(rule, error as Error));
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const server of this.servers) server.close();
    this.servers.clear();
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
    for (const rule of this.remoteRules) this.cancelRemote(rule);
    this.remoteRules.length = 0;
    this.client.removeListener('tcp connection', this.onRemoteConnection);
  }

  private cancelRemote(rule: SshPortForward): void {
    try {
      this.client.unforwardIn(rule.bindHost, rule.bindPort, () => {});
    } catch {
      // Disconnecting the SSH transport also releases the remote listener.
    }
  }

  private failure(rule: SshPortForward, error: Error): PortForwardFailure {
    return { rule: forwardRuleLabel(rule), detail: error.message };
  }

  private startRule(rule: SshPortForward): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error('SSH connection closed'));
      const timer = setTimeout(() => finish(new Error('Listener setup timed out')), TIMEOUT_MS);
      this.abort.signal.addEventListener('abort', onAbort, { once: true });

      try {
        if (rule.mode === 'remote') {
          // Register before requesting so traffic can arrive immediately after success.
          this.remoteRules.push(rule);
          this.client.forwardIn(rule.bindHost, rule.bindPort, (error) => {
            if (!error && this.closed) this.cancelRemote(rule);
            finish(error ?? undefined);
          });
        } else {
          const server = createServer({ allowHalfOpen: true }, (socket) => this.onLocalConnection(rule, socket));
          this.servers.add(server);
          server.on('error', (error) => {
            if (!settled) finish(error);
            else if (!this.closed) this.onFailure(this.failure(rule, error));
          });
          server.listen({ host: rule.bindHost, port: rule.bindPort, signal: this.abort.signal }, () => finish());
        }
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  private track<T extends Duplex>(stream: T, rule: SshPortForward): T {
    this.streams.add(stream);
    stream.on('error', (error) => {
      if (!this.closed) this.onFailure(this.failure(rule, error));
    });
    stream.once('close', () => this.streams.delete(stream));
    return stream;
  }

  private pipe(socket: Socket, channel: ClientChannel, rule: SshPortForward): void {
    this.track(channel, rule);
    socket.once('close', (hadError) => {
      // A normal TCP close can precede the SSH channel draining its window.
      // Destroying here would discard the remaining response bytes.
      if (hadError || !socket.readableEnded) channel.destroy();
      else channel.end();
    });
    // Flush data already queued on the TCP socket before closing it.
    channel.once('close', () => socket.destroySoon());
    socket.on('error', () => channel.destroy());
    channel.on('error', () => socket.destroy());
    const closeWhenDrained = () => {
      if (channel.readableEnded && channel.writableFinished) channel.close();
    };
    channel.once('end', closeWhenDrained);
    channel.once('finish', closeWhenDrained);
    // pipe propagates EOF in each direction, preserving TCP half-close semantics.
    socket.pipe(channel).pipe(socket);
  }

  private onLocalConnection(rule: SshPortForward, socket: Socket): void {
    if (this.closed) { socket.destroy(); return; }
    this.track(socket, rule);
    const timer = setTimeout(() => socket.destroy(new Error('Connection timed out')), TIMEOUT_MS);
    socket.once('close', () => clearTimeout(timer));
    try {
      this.client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0,
        rule.targetHost, rule.targetPort,
        (error, channel) => {
          clearTimeout(timer);
          if (error) { socket.destroy(error); return; }
          if (this.closed || socket.destroyed) { channel.destroy(); return; }
          this.pipe(socket, channel, rule);
        },
      );
    } catch (error) {
      clearTimeout(timer);
      socket.destroy(error as Error);
    }
  }

  private onRemoteConnection = (
    info: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void,
  ): void => {
    const rule = this.remoteRules.find((item) => item.bindHost === info.destIP && item.bindPort === info.destPort);
    if (this.closed || !rule) { reject(); return; }
    const socket = this.track(createConnection({ host: rule.targetHost, port: rule.targetPort, allowHalfOpen: true }), rule);
    let connected = false;
    const timer = setTimeout(() => socket.destroy(new Error('Connection timed out')), TIMEOUT_MS);
    socket.once('close', () => {
      clearTimeout(timer);
      if (!connected) reject();
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      if (this.closed) { socket.destroy(); return; }
      connected = true;
      this.pipe(socket, accept(), rule);
    });
  };
}
