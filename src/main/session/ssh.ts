import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import type { ExecResult, SessionSpecSsh, Settings } from '../../shared/types';
import { KnownHostsStore } from './known-hosts';
import { SshPortForwarding } from './port-forwarding';
import { withWorkingDirectory } from './types';
import type { BackendHandlers, ExecOptions, SessionBackend } from './types';
import { encodePowerShellCommand } from '../metadata/probe';

/** What a real session and a one-shot test both need to open a connection. */
export interface SshConnectOptions {
  spec: SessionSpecSsh;
  settings: Settings;
  knownHosts: KnownHostsStore;
  onHostKeyChanged?: (host: string) => void;
  onHostKeyFirstSeen?: (host: string) => void;
}

export interface SshSessionOptions extends SshConnectOptions {
  handlers: BackendHandlers;
  cols: number;
  rows: number;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${homedir()}${path.slice(1)}`;
  return path;
}

const DEFAULT_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

function agentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return DEFAULT_AGENT_PIPE;
  return undefined;
}

function buildConnectConfig(options: SshConnectOptions): ConnectConfig {
  const { spec, settings } = options;
  const { target } = spec;
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: 20_000,
    keepaliveInterval: Math.max(0, settings.ssh.keepAliveSeconds) * 1000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
    hostVerifier: (key: Buffer | string) => {
      const verdict = options.knownHosts.verify(
        target.host,
        target.port,
        key,
        target.hostKeyPolicy,
      );
      if (!verdict.ok) return false;
      if (verdict.changed) options.onHostKeyChanged?.(`${target.host}:${target.port}`);
      if (verdict.firstSeen) options.onHostKeyFirstSeen?.(`${target.host}:${target.port}`);
      return true;
    },
  };

  if (target.auth.type === 'password') {
    config.password = target.auth.password;
  } else if (target.auth.type === 'key') {
    const keyPath = expandHome(target.auth.privateKeyPath);
    if (/\.ppk$/i.test(keyPath)) {
      throw new Error('PuTTY .ppk keys are not supported; export an OpenSSH key with "puttygen -O private-openssh"');
    }
    config.privateKey = readFileSync(keyPath);
    if (target.auth.passphrase) config.passphrase = target.auth.passphrase;
  } else if (target.auth.type === 'agent') {
    const agent = agentPath();
    if (agent) config.agent = agent;
  }

  return config;
}

export function startSshSession(options: SshSessionOptions): Promise<SessionBackend> {
  const { handlers, cols, rows, spec } = options;
  const client = new Client();
  const forwarding = new SshPortForwarding(client, spec.portForwards, handlers.onForwardError);
  let stream: ClientChannel | null = null;
  let finished = false;
  let ready = false;

  const finish = (code: number | null, error?: Error) => {
    if (finished) return;
    finished = true;
    forwarding.close();
    handlers.onExit(code, error);
  };

  const backend: SessionBackend = {
    kind: 'ssh',
    posixShell: true,
    write(data) {
      stream?.write(data);
    },
    resize(nextCols, nextRows) {
      stream?.setWindow(Math.max(2, nextRows), Math.max(2, nextCols), 0, 0);
    },
    kill() {
      forwarding.close();
      try {
        stream?.close();
      } catch {
        // ignore
      }
      client.end();
    },
    exec(command, execOptions) {
      return execRemote(client, command, execOptions);
    },
    sftp() {
      return new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, channel) => (error ? reject(error) : resolve(channel)));
      });
    },
  };

  return new Promise<SessionBackend>((resolve, reject) => {
    handlers.onStatus('connecting');

    const settleReject = (error: Error) => {
      finish(null, error);
      client.end();
      reject(error);
    };

    client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, done) => {
      // Bastion SSO tickets arrive as keyboard-interactive, not as a password.
      const password = spec.target.auth.type === 'password' ? spec.target.auth.password : '';
      done(password ? [password] : []);
    });

    client.on('error', (error: Error) => {
      handlers.onError(error.message);
      finish(null, error);
      client.end();
      if (!ready) reject(error);
    });

    client.on('close', () => {
      if (!ready) {
        settleReject(new Error('The host closed the connection before it was ready'));
        return;
      }
      finish(stream ? 0 : null);
    });

    client.on('ready', async () => {
      // A tunnel that refuses to come up is not a login that failed: the shell
      // below is what the tab is, and it is still worth opening.
      try {
        await forwarding.start();
      } catch (error) {
        handlers.onForwardError({
          rule: '',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (finished) return;
      client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
        if (error) {
          settleReject(error);
          return;
        }
        if (finished) { channel.close(); return; }
        stream = channel;
        ready = true;
        channel.on('data', (data: Buffer) => handlers.onData(data.toString('utf8')));
        channel.stderr.on('data', (data: Buffer) => handlers.onData(data.toString('utf8')));
        channel.on('close', () => {
          finish(0);
          client.end();
        });
        handlers.onStatus('connected');
        resolve(backend);
      });
    });

    try {
      client.connect(buildConnectConfig(options));
    } catch (error) {
      settleReject(error as Error);
    }
  });
}

/**
 * Opens a connection and hangs up again: the "test" behind the editor's button.
 *
 * It performs the same handshake and the same host-key verdict a real tab would,
 * so a policy that would refuse the host refuses the test too, but it never asks
 * for a shell - nothing is left running on the far side.
 */
export function testSshConnection(options: SshConnectOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      try {
        client.end();
      } catch {
        // Already gone; the verdict is what the caller wanted either way.
      }
      if (error) reject(error);
      else resolve();
    };

    client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, done) => {
      const password = options.spec.target.auth.type === 'password' ? options.spec.target.auth.password : '';
      done(password ? [password] : []);
    });
    client.on('ready', () => finish());
    client.on('error', (error: Error) => finish(error));
    client.on('close', () => finish(new Error('The host closed the connection before it was ready')));

    try {
      client.connect(buildConnectConfig(options));
    } catch (error) {
      finish(error as Error);
    }
  });
}

/**
 * Runs one command on the far side, over a channel next to the interactive
 * shell.
 *
 * Streaming is what makes an agent's command watchable: `onData` fires with
 * every chunk as it arrives, so the terminal can put it on screen while it is
 * still happening. The full text is accumulated anyway — ACP asks for the
 * output of the finished command, not for the stream.
 */
function execRemote(
  client: Client,
  command: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  const shell = options?.shell ?? 'posix';
  const wrapped = withWorkingDirectory(command, options?.cwd, shell);
  const payload =
    shell === 'powershell'
      ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(wrapped)}`
      : wrapped;

  return new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let channel: ClientChannel | null = null;
    const timeoutMs = options?.timeoutMs ?? 15_000;

    const emit = (chunk: string) => {
      if (chunk) options?.onData?.(chunk);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const onAbort = () => {
      try {
        channel?.close();
      } catch {
        // Already gone; the close handler settles either way.
      }
      // A channel that refuses to close must not leave the caller waiting.
      setTimeout(() => finish(null), 250);
    };

    if (options?.signal?.aborted) {
      finish(null);
      return;
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    client.exec(payload, (error, next) => {
      if (error) {
        stderr += error.message;
        finish(null);
        return;
      }
      channel = next;
      timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      next.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        stdout += chunk;
        emit(chunk);
      });
      next.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        stderr += chunk;
        emit(chunk);
      });
      next.on('close', (code: number | null) => finish(code ?? null));
    });
  });
}
