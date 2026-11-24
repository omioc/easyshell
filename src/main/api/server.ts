import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { buildSshSpecFromProfile } from '../../shared/profiles';
import type { SessionEvent, SessionSpec, SshProfile, Settings } from '../../shared/types';
import type { SessionManager } from '../session/manager';

export interface ControlServerOptions {
  manager: SessionManager;
  getSettings: () => Settings;
  appVersion: string;
}

interface StartResult {
  ok: boolean;
  port?: number;
  error?: string;
}

/** A saved connection as the API may expose it: never the secret material. */
function publicProfile(profile: SshProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType: profile.authType,
    privateKeyPath: profile.privateKeyPath,
    hostKeyPolicy: profile.hostKeyPolicy,
    notes: profile.notes,
    hasPassword: Boolean(profile.password),
    hasPassphrase: Boolean(profile.passphrase),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastUsedAt: profile.lastUsedAt,
  };
}

function publicSettings(settings: Settings): Settings {
  return {
    ...settings,
    api: { ...settings.api, token: '***' },
    ssh: {
      ...settings.ssh,
      profiles: settings.ssh.profiles.map((profile) => ({
        ...profile,
        password: profile.password ? '***' : undefined,
        passphrase: profile.passphrase ? '***' : undefined,
      })),
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Local control API.
 *
 * Bound to 127.0.0.1 and gated by a bearer token that lives in settings. It is
 * the surface an agent uses: list sessions with their live metadata, attach to
 * one, type into it, resize it, or run a command through its side channel.
 */
export class ControlServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly sockets = new Map<WebSocket, { sessionId: string; clientId: string }>();

  constructor(private readonly options: ControlServerOptions) {}

  get baseUrl(): string | null {
    return this.httpServer ? `http://127.0.0.1:${this.port}` : null;
  }

  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  async start(): Promise<StartResult> {
    const settings = this.options.getSettings();
    if (!settings.api.enabled) return { ok: false, error: 'disabled' };

    const server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!this.isAuthorized(req, url)) {
        socket.destroy();
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)\/attach$/.exec(url.pathname);
      if (!match) {
        socket.destroy();
        return;
      }
      const sessionId = decodeURIComponent(match[1] as string);
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleAttach(ws, sessionId);
      });
    });

    const result = await new Promise<StartResult>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        resolve({ ok: false, error: error.code ?? error.message });
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve({ ok: true, port: settings.api.port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(settings.api.port, settings.api.host);
    });

    if (!result.ok) {
      server.close();
      wss.close();
      return result;
    }

    this.httpServer = server;
    this.wss = wss;
    this.port = settings.api.port;
    return result;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets.keys()) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    const wss = this.wss;
    const server = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    this.port = 0;
    await Promise.all([
      new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve())),
      new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
    ]);
  }

  /** Fans a manager event out to every attached client. */
  handleEvent(event: SessionEvent): void {
    for (const [socket, client] of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (event.type === 'session-output') {
        if (event.id !== client.sessionId) continue;
        this.send(socket, { type: 'data', data: event.data });
        continue;
      }
      if (event.type === 'session-metadata') {
        if (event.id !== client.sessionId) continue;
        this.send(socket, { type: 'metadata', metadata: event.metadata });
        continue;
      }
      if (event.type === 'session-updated') {
        if (event.session.id !== client.sessionId) continue;
        this.send(socket, { type: 'session', session: event.session });
        continue;
      }
      if (event.type === 'session-closed') {
        if (event.id !== client.sessionId) continue;
        this.send(socket, { type: 'exit', code: event.code });
      }
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Client vanished between the readyState check and the send.
    }
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const token = this.options.getSettings().api.token;
    if (!token) return false;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7) === token;
    const queryToken = url.searchParams.get('token');
    return queryToken === token;
  }

  private handleAttach(ws: WebSocket, sessionId: string): void {
    const clientId = randomUUID();
    const manager = this.options.manager;
    const snapshot = manager.attach(sessionId);
    if (!snapshot) {
      this.send(ws, { type: 'error', message: 'session not found' });
      ws.close();
      return;
    }
    this.sockets.set(ws, { sessionId, clientId });
    manager.addClient(sessionId, clientId);
    this.send(ws, {
      type: 'snapshot',
      data: snapshot.data,
      cols: snapshot.cols,
      rows: snapshot.rows,
      session: manager.get(sessionId),
    });

    ws.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = message['type'];
      if (type === 'input' && typeof message['data'] === 'string') {
        manager.write(sessionId, message['data']);
      } else if (type === 'resize') {
        const cols = Number(message['cols']);
        const rows = Number(message['rows']);
        if (Number.isFinite(cols) && Number.isFinite(rows)) manager.resize(sessionId, cols, rows);
      } else if (type === 'probe') {
        void manager.probe(sessionId);
      } else if (type === 'detach') {
        ws.close();
      }
    });

    const cleanup = () => {
      this.sockets.delete(ws);
      manager.removeClient(sessionId, clientId);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (!this.isAuthorized(req, url)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    const { manager } = this.options;
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (method === 'GET' && path === '/v1/health') {
        json(res, 200, { ok: true, version: this.options.appVersion });
        return;
      }
      if (method === 'GET' && path === '/v1/sessions') {
        json(res, 200, { sessions: manager.list() });
        return;
      }
      if (method === 'POST' && path === '/v1/sessions') {
        const body = (await readJson(req)) as Record<string, unknown>;
        const spec = (body['spec'] ?? body) as SessionSpec & { profileId?: string };
        const profileId = spec?.profileId ?? (typeof body['profileId'] === 'string' ? body['profileId'] : undefined);

        if (profileId) {
          const settings = this.options.getSettings();
          const profile = settings.ssh.profiles.find((item) => item.id === profileId);
          if (!profile) {
            json(res, 404, { error: 'connection not found' });
            return;
          }
          const resolved = buildSshSpecFromProfile(profile, { hostKeyPolicy: settings.ssh.hostKeyPolicy });
          if (!resolved) {
            json(res, 400, { error: 'connection is incomplete' });
            return;
          }
          const session = await manager.create({ ...resolved, origin: { type: 'api' } });
          json(res, 201, { session });
          return;
        }

        if (!spec || typeof spec !== 'object' || !spec.kind) {
          json(res, 400, { error: 'invalid session spec' });
          return;
        }
        const session = await manager.create({ ...spec, origin: spec.origin ?? { type: 'api' } });
        json(res, 201, { session });
        return;
      }
      if (method === 'GET' && path === '/v1/settings') {
        json(res, 200, { settings: publicSettings(this.options.getSettings()) });
        return;
      }
      if (method === 'GET' && path === '/v1/connections') {
        const settings = this.options.getSettings();
        json(res, 200, { connections: settings.ssh.profiles.map(publicProfile) });
        return;
      }

      const sessionMatch = /^\/v1\/sessions\/([^/]+)(?:\/(input|resize|title|probe|exec))?$/.exec(path);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] as string);
        const action = sessionMatch[2];

        if (!action && method === 'GET') {
          const session = manager.get(sessionId);
          if (!session) {
            json(res, 404, { error: 'session not found' });
            return;
          }
          json(res, 200, { session });
          return;
        }
        if (!action && method === 'DELETE') {
          manager.close(sessionId);
          json(res, 200, { ok: true });
          return;
        }
        if (action === 'input' && method === 'POST') {
          const body = (await readJson(req)) as Record<string, unknown>;
          manager.write(sessionId, String(body['data'] ?? ''));
          json(res, 200, { ok: true });
          return;
        }
        if (action === 'resize' && method === 'POST') {
          const body = (await readJson(req)) as Record<string, unknown>;
          manager.resize(sessionId, Number(body['cols'] ?? 80), Number(body['rows'] ?? 24));
          json(res, 200, { ok: true });
          return;
        }
        if (action === 'title' && method === 'POST') {
          const body = (await readJson(req)) as Record<string, unknown>;
          manager.rename(sessionId, String(body['title'] ?? ''));
          json(res, 200, { ok: true });
          return;
        }
        if (action === 'probe' && method === 'POST') {
          const metadata = await manager.probe(sessionId);
          if (!metadata) {
            json(res, 404, { error: 'session not found' });
            return;
          }
          json(res, 200, { metadata });
          return;
        }
        if (action === 'exec' && method === 'POST') {
          const body = (await readJson(req)) as Record<string, unknown>;
          const command = String(body['command'] ?? '');
          const timeoutMs = body['timeoutMs'] ? Number(body['timeoutMs']) : undefined;
          const via = body['via'] === 'shell' ? 'shell' : 'channel';
          const shell = body['shell'];
          const result =
            via === 'shell'
              ? await manager.execViaShell(sessionId, command, timeoutMs)
              : await manager.exec(sessionId, command, {
                  timeoutMs,
                  shell: shell === 'posix' || shell === 'powershell' || shell === 'cmd' ? shell : undefined,
                });
          json(res, 200, result);
          return;
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}