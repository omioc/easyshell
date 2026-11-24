import { spawn } from 'node:child_process';
import type { ExecResult, PlatformOs, SessionKind, SessionSpecLocal, SessionSpecWsl } from '../../shared/types';
import { withWorkingDirectory } from './types';
import type { BackendHandlers, ExecOptions, SessionBackend } from './types';
import { encodePowerShellCommand } from '../metadata/probe';

export interface LaunchPlan {
  kind: SessionKind;
  label: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  posix: boolean;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'ELECTRON_NO_ATTACH_CONSOLE') continue;
    env[key] = value;
  }
  return env;
}

function looksPosixShell(command: string): boolean {
  return /(?:^|[\\/])(?:bash|zsh|sh|fish|dash|ksh)(?:\.exe)?$/i.test(command);
}

export function planSession(
  spec: SessionSpecLocal | SessionSpecWsl,
  platform: PlatformOs,
  homeDir: string,
  sessionId: string,
): LaunchPlan {
  const env = baseEnv();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'EasyShell';
  env.EASYSHELL_SESSION_ID = sessionId;

  if (spec.kind === 'wsl') {
    const file = platform === 'win32' ? 'wsl.exe' : 'wsl';
    const args = spec.distribution ? ['-d', spec.distribution] : [];
    return {
      kind: 'wsl',
      label: spec.distribution || 'WSL',
      file,
      args,
      cwd: spec.cwd ?? homeDir,
      env,
      posix: true,
    };
  }

  const posix = platform !== 'win32' || looksPosixShell(spec.command);
  return {
    kind: 'local',
    label: spec.command,
    file: spec.command,
    args: spec.args,
    cwd: spec.cwd ?? homeDir,
    env,
    posix,
  };
}

type PtyModule = typeof import('@lydell/node-pty');

let ptyModule: PtyModule | null = null;

async function loadPty(): Promise<PtyModule> {
  if (!ptyModule) ptyModule = await import('@lydell/node-pty');
  return ptyModule;
}

export async function startLocalSession(
  plan: LaunchPlan,
  handlers: BackendHandlers,
  cols: number,
  rows: number,
): Promise<SessionBackend> {
  const pty = await loadPty();
  handlers.onStatus('connecting');

  const term = pty.spawn(plan.file, plan.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: plan.cwd,
    env: plan.env,
    useConpty: process.platform === 'win32',
  });

  let exited = false;
  term.onData((data) => handlers.onData(data));
  term.onExit(({ exitCode }) => {
    if (exited) return;
    exited = true;
    handlers.onExit(exitCode ?? null);
  });
  handlers.onStatus('connected');

  return {
    kind: plan.kind,
    posixShell: plan.posix,
    write(data) {
      term.write(data);
    },
    resize(nextCols, nextRows) {
      try {
        term.resize(Math.max(2, nextCols), Math.max(2, nextRows));
      } catch {
        // Resizing a dead pty throws; nothing to recover.
      }
    },
    kill() {
      try {
        term.kill();
      } catch {
        // Already gone.
      }
    },
    exec(command, options) {
      return runOutOfBand(plan, command, options);
    },
  };
}

function resolveExecShell(plan: LaunchPlan, command: string, options?: ExecOptions): { file: string; args: string[] } {
  const requested = options?.shell ?? (plan.posix ? 'posix' : 'powershell');
  // Inside WSL there is no PowerShell: always run through the distribution.
  const shell = plan.kind === 'wsl' ? 'posix' : requested;
  if (shell === 'powershell') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(command)],
    };
  }
  if (shell === 'cmd') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  if (plan.kind === 'wsl') {
    return { file: plan.file, args: [...plan.args, '--', 'sh', '-lc', command] };
  }
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(command)],
    };
  }
  return { file: '/bin/sh', args: ['-lc', command] };
}

function runOutOfBand(plan: LaunchPlan, command: string, options?: ExecOptions): Promise<ExecResult> {
  const shell = options?.shell ?? (plan.posix ? 'posix' : 'powershell');
  const { file, args } = resolveExecShell(plan, withWorkingDirectory(command, options?.cwd, shell), options);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  return new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(file, args, { cwd: plan.cwd, env: plan.env, windowsHide: true });
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
        child.kill();
      } catch {
        // Already gone; the close handler settles either way.
      }
    };
    if (options?.signal?.aborted) {
      finish(null);
      return;
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      emit(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      emit(text);
    });
    child.on('error', (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code ?? null));
  });
}