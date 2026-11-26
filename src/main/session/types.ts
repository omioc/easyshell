import type { SFTPWrapper } from 'ssh2';
import type { PortForwardFailure } from '../../shared/port-forwards';
import type { ExecResult, SessionKind } from '../../shared/types';

export type ExecShell = 'posix' | 'powershell' | 'cmd';

/**
 * How a command is run out of band, next to the interactive shell.
 *
 * The same options serve two callers: an invisible probe (no `onData`, the
 * result is all that matters) and a command the user is meant to watch (every
 * chunk is forwarded to the display as it arrives).
 */
export interface ExecOptions {
  /** Which interpreter should run the command. Defaults to the session's own. */
  shell?: ExecShell;
  timeoutMs?: number;
  /** Working directory, when the backend can honour it without a shell. */
  cwd?: string;
  /** Called for every chunk as it arrives, before the result resolves. */
  onData?(chunk: string): void;
  /** Aborts the command. `terminal/kill` is the caller that uses it. */
  signal?: AbortSignal;
}

export interface BackendHandlers {
  onData(chunk: string): void;
  onExit(code: number | null, error?: Error): void;
  onStatus(status: 'connecting' | 'connected'): void;
  onError(message: string): void;
  /**
   * A tunnel the user configured did not come up.
   *
   * Separate from `onError` because the session is fine: the shell works, the
   * login worked, and only a port forward is missing. Reporting it as a
   * connection error would paint a working tab red.
   */
  onForwardError(failure: PortForwardFailure): void;
}

export interface SessionBackend {
  readonly kind: SessionKind;
  /** True when the interactive shell is POSIX, so commands can be injected. */
  readonly posixShell: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Runs a command out of band: child process for local/WSL, exec channel for SSH. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /**
   * A file channel multiplexed over the same connection, so the file sheet
   * costs no second login and inherits the session's credentials.
   */
  sftp?(): Promise<SFTPWrapper>;
}
export function emptyExecResult(): ExecResult {
  return { code: null, stdout: '', stderr: '', timedOut: false };
}

/** POSIX single-quoting: everything is literal inside `'…'`. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Prefixes a command with a move to `cwd`.
 *
 * ACP hands the host a working directory, not a shell, so the directory has to
 * become part of the command line. Only an absolute path is accepted: a
 * relative one would silently depend on wherever the shell happens to be, which
 * is exactly the ambiguity `cwd` exists to remove.
 */
export function withWorkingDirectory(
  command: string,
  cwd: string | undefined,
  shell: ExecShell,
): string {
  const target = cwd?.trim();
  if (!target || !target.startsWith('/') || !command.trim()) return command;
  if (shell === 'powershell') {
    // A POSIX path is not a PowerShell path: leave it to the PowerShell branch.
    return command;
  }
  if (shell === 'cmd') return command;
  return `cd -- ${posixQuote(target)} && ${command}`;
}