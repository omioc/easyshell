import { randomUUID } from 'node:crypto';
import type { SFTPWrapper } from 'ssh2';
import type {
  ExecResult,
  PlatformOs,
  ProbeState,
  SessionEvent,
  SessionHop,
  SessionInfo,
  SessionMetadata,
  SessionSpec,
  Settings,
} from '../../shared/types';
import type { PortForwardFailure } from '../../shared/port-forwards';
import { NestedDetector } from '../metadata/nested';
import { BANNER_HINT, LOGIN_SIGNATURE, distroName, parseLoginBanner } from '../metadata/banner';
import {
  adoptAddress,
  adoptPrompt,
  adoptTitle,
  candidateMatches,
  commitHop,
  endpointFromChain,
  namesAgree,
  popHop,
} from '../metadata/chain';
import type { NestedSignal } from '../metadata/nested';
import {
  parseProbeOutput,
  posixProbeScript,
  probeLooksValid,
  windowsProbeScript,
} from '../metadata/probe';
import {
  buildShellInjection,
  injectionCaptureToDisplay,
  injectionTailToDisplay,
  isBarePromptRepaint,
  looksLikeCredentialPrompt,
  looksLikePromptTail,
  looksLikeSessionEnd,
  promptIdentity,
  promptOnScreen,
  stripAnsi,
} from './injection';
import { planSession, startLocalSession } from './local';
import { startSshSession } from './ssh';
import type { KnownHostsStore } from './known-hosts';
import { withWorkingDirectory } from './types';
import { CredentialDesk } from './credentials';
import type { SshCredential } from '../../shared/types';
import type { ExecOptions, SessionBackend } from './types';

const BUFFER_LIMIT = 256 * 1024;

/** Dim / reset, around the annotations the app itself writes into a terminal. */
const DISPLAY_DIM = '\x1b[2m';
const DISPLAY_RESET = '\x1b[0m';
/** How long the shell gets to repaint its prompt before the injection lets go. */
const INJECTION_DRAIN_IDLE_MS = 250;
/** Upper bound, so a slow prompt (or a slow link) cannot freeze the display. */
const INJECTION_DRAIN_MAX_MS = 2000;

/** How long after an injection a repeated prompt repaint is still swallowed. */
const INJECTION_REPAINT_GUARD_MS = 3000;

/** How long the shell gets to settle after a nested login before it is typed to. */
const SHELL_PROBE_DELAY_MS = 1200;

/**
 * How long a command typed into a nested shell may run before the app stops
 * waiting for its markers.
 *
 * The caller's own timeout wins when it has one; this is only the floor for a
 * shell that never answers at all.
 */
const SHELL_COMMAND_TIMEOUT_MS = 60_000;

/** Retry spacing when the shell was busy: 2 s, 4 s, 6 s, 8 s. */
const SHELL_PROBE_RETRY_MS = 2000;
/** After that the user is clearly using the shell; come back every half minute. */
const SHELL_PROBE_SLOW_RETRY_MS = 30_000;
const SHELL_PROBE_MAX_ATTEMPTS = 4;
/** Fast attempts plus slow ones, so an unprobeable shell is not typed to forever. */
const SHELL_PROBE_MAX_TOTAL = 12;

/**
 * Output debounce before the app types `pwd` at a fresh prompt.
 *
 * The answer is only wanted after a command finished: asking during output
 * would type into a line that is still being printed.
 */
const CWD_QUIET_MS = 600;
/**
 * Login commands: when the first line may be typed, how long each one gets to
 * finish printing, and how long the queue waits before giving up on quiet.
 *
 * The seconds here are the user's own commands, not an app probe: a `docker ps`
 * that takes three seconds must not have the next line typed into its output.
 */
const LOGIN_COMMAND_FIRST_DELAY_MS = 250;
const LOGIN_COMMAND_STEP_MS = 200;
const LOGIN_COMMAND_QUIET_MS = 350;
const LOGIN_COMMAND_QUIET_MAX_MS = 15_000;

/**
 * OSC 7 (`file://host/path`) and OSC 9;9 (`C:\path`) are the two ways a shell
 * tells its terminal where it is. Both are free to read, which is why the
 * terminal tries them before typing anything at all.
 */
const OSC_CWD =
  /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Percent-decoded OSC 7 payload; a path that cannot be decoded is used as is. */
function decodeCwd(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** An exec channel emits LF; a terminal needs CRLF to start a new line. */
function toDisplayLines(chunk: string): string {
  return chunk.replace(/\r?\n/g, '\r\n');
}

/**
 * A command line, made safe to put on a terminal that is *not* running it.
 *
 * The echoed line is a record the user is meant to trust, so it may not carry
 * bytes a terminal acts on: an escape sequence inside an agent's command could
 * otherwise repaint the screen and make the record say something that never
 * happened. Control characters become caret notation (`^[`), which is both
 * inert and readable. Newlines stay line breaks — a multi-line command is a
 * normal thing to run — but continuation lines are indented so the whole block
 * reads as one command rather than as a prompt followed by another.
 */
function displaySafeCommand(command: string): string {
  const escaped = command
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, (char) =>
      char === '\u007f' ? '^?' : `^${String.fromCharCode(char.charCodeAt(0) + 64)}`,
    );
  return escaped
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\r\n');
}

/**
 * The Windows prompts that name their own directory: `PS C:\work>`, `C:\work>`,
 * and the same with a prefix in front of it (`(base) PS C:\work>`, printed by
 * every shell a conda environment has touched).
 *
 * `cmd.exe` and Windows PowerShell have no OSC 7 / OSC 9;9 without shell
 * integration, and they cannot be typed into either, so the prompt is the only
 * signal there is. It is read from the last line on screen and nothing else: a
 * line that merely contains a path is not a prompt, because a prompt ends in the
 * path and a `>`.
 */
const WINDOWS_PROMPT = /(?:^|[\s>)\]}])(?:PS\s+)?((?:[A-Za-z]:\\|\\\\)[^>\r\n]*?)\s*>\s*$/;

/** A login banner still belongs to the current hop for this long. */
const LOGIN_SIGNAL_TTL_MS = 20_000;

/**
 * One departure is printed more than once, and the reports are not always
 * together: a slow link can deliver `Connection to … closed.` seconds after the
 * typed `exit`. Inside this window every report belongs to the same departure;
 * past it, a report is still recognised by the machine it names, for as long as
 * the departure it describes can plausibly still arrive.
 */
const POP_EPISODE_MS = 5000;
const POP_REPORT_LATE_MS = 120_000;

interface PendingInjection {
  token: string;
  beginMarker: string;
  endMarker: string;
  /**
   * What the capture finds between the markers goes on screen as it arrives.
   *
   * A probe's capture is the app's own business and stays invisible unless it
   * carries something the user must see. A command an agent runs is the
   * opposite: the user is watching a machine they are responsible for.
   */
  visible: boolean;
  /** How much of the visible capture has already been shown. */
  shown: number;
  command: string;
  buffer: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Set once the end marker arrived; the promise has resolved by then. */
  settled: boolean;
  /** Everything seen after the end marker, normally the prompt repaint. */
  drained: string;
  drainTimer: NodeJS.Timeout | null;
  drainDeadline: number;
  /** The prompt that was on screen when the line was typed. */
  promptBefore: string;
  resolve: (result: ExecResult) => void;
}

interface Runtime {
  info: SessionInfo;
  backend: SessionBackend | null;
  buffer: string;
  detector: NestedDetector;
  timer: NodeJS.Timeout | null;
  /** Text the current host printed about itself since the last hop change. */
  bannerText: string;
  /** `user@host` of the last prompt painted, for spotting a changed machine. */
  promptLabel: string;
  /** When output carried a login banner; the next changed prompt is the host. */
  loginSignalAt: number;
  /**
   * The machine the chain dropped last, and when. A departure is printed by
   * every layer that took part in it, and the late copies name the hop that is
   * already gone — never the one being stood on.
   */
  lastDeparture: { at: number; host?: string; hostname?: string } | null;
  /**
   * The place a submitted line aims at, which the chain does not know about
   * yet. It only becomes a hop once the shell on the other side answers with
   * that account and machine; until then the panel keeps describing where the
   * user still is, because that is the truth.
   */
  candidate: SessionHop | null;
  /**
   * What the line the user last submitted says the machine may ask a password
   * for: `sudo` authenticates the account already here, `su` the one it switches
   * to. `null` when that line asks for no password at all.
   */
  escalation: { via: 'sudo' | 'su'; account?: string } | null;
  /**
   * The one shell probe a hop is allowed, and how far it got. `Depth` is the
   * chain length that was answered, so a new hop always deserves a new probe.
   */
  shellProbeTimer: NodeJS.Timeout | null;
  shellProbeTimerDepth: number;
  shellProbeDepth: number;
  shellProbeAttempts: number;
  /** Keys the user typed on the current line and has not submitted yet. */
  pendingInput: string;
  /** Invalidates work scheduled against an earlier state of the input line. */
  inputVersion: number;
  /** A submitted command's echo is not a returned shell prompt. */
  awaitingLineBreak: boolean;
  probeBusy: boolean;
  probeFailures: number;
  everConnected: boolean;
  injection: PendingInjection | null;
  /** Prompt text on screen, kept by the last injection. */
  promptText: string;
  /** Until when a bare prompt repaint is swallowed instead of printed. */
  repaintGuardUntil: number;
  lastOutputAt: number;
  tailText: string;
  altScreen: boolean;
  titleLocked: boolean;
  apiClients: Set<string>;
  connecting: boolean;
  initialCommandPending: string | null;
  /** Login commands still to be typed, in order; emptied as they are sent. */
  loginCommandsPending: string[];
  /** The password prompt in this tab, and what the user said about it. */
  credential: CredentialDesk;
  closed: boolean;
  /** Where the interactive shell is, once anything revealed it. */
  cwd: string | null;
  /** Input revision for which the shell already reported / was asked for cwd. */
  cwdReportedVersion: number;
  cwdQueriedVersion: number;
  cwdQueryBusy: boolean;
  cwdFollowing: boolean;
  cwdTimer: NodeJS.Timeout | null;
  /** Tail of an OSC sequence that was split across two chunks. */
  oscScan: string;
}

export interface SessionManagerOptions {
  getSettings: () => Settings;
  platform: PlatformOs;
  homeDir: string;
  knownHosts: KnownHostsStore;
  emit: (event: SessionEvent) => void;
  /**
   * Writes the whole vault back. The manager owns the decision to remember a
   * password; where it is kept, and how it is sealed, is the store's business.
   */
  replaceCredentials?: (next: SshCredential[]) => void;
}

function nowMs(): number {
  return Date.now();
}

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly options: SessionManagerOptions) {}

  list(): SessionInfo[] {
    return [...this.runtimes.values()]
      .map((runtime) => this.snapshot(runtime))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): SessionInfo | null {
    const runtime = this.runtimes.get(id);
    return runtime ? this.snapshot(runtime) : null;
  }

  async create(spec: SessionSpec): Promise<SessionInfo> {
    const settings = this.options.getSettings();
    const id = randomUUID();
    const cols = 80;
    const rows = 24;
    const title = spec.title ?? this.defaultTitle(spec);
    const chain: SessionHop[] = [this.initialHop(spec)];

    const info: SessionInfo = {
      id,
      kind: spec.kind,
      title,
      status: 'connecting',
      createdAt: nowMs(),
      lastActivityAt: nowMs(),
      cols,
      rows,
      origin: spec.origin ?? { type: 'ui' },
      metadata: {
        endpoint: {
          kind: spec.kind,
          displayName: chain[0]?.label ?? title,
          host: chain[0]?.host,
          port: chain[0]?.port,
          username: chain[0]?.username,
          distribution: spec.kind === 'wsl' ? spec.distribution : undefined,
          source: 'session',
          chain,
        },
        os: {},
        extra: {},
        updatedAt: nowMs(),
      },
      probe: this.probeState(settings),
      attachedClients: 0,
      bufferBytes: 0,
    };

    // The desk reads the session lazily — it only looks at the chain and the
    // screen when a prompt is on it, never before the session exists.
    let runtime: Runtime;
    const credential = new CredentialDesk({
      candidate: () => runtime.candidate,
      landed: () => runtime.info.metadata.endpoint.chain.at(-1) ?? null,
      depth: () => runtime.info.metadata.endpoint.chain.length,
      // The password a `sudo` / `su` asks for belongs to an account rather than
      // to a login that will show up next: `sudo` wants the one running it, `su`
      // the one it switches to. The hop on top knows the account and both names
      // of the machine it stands on.
      login: () => {
        const chain = runtime.info.metadata.endpoint.chain;
        const top = chain[chain.length - 1];
        if (!top?.username) return null;
        return { username: top.username, host: top.host, hostname: top.hostname, port: top.port };
      },
      escalation: () => runtime.escalation,
      tail: () => runtime.tailText,
      // `vault` is always set by the settings store; a caller that hands the
      // manager a partial settings object still gets an empty vault.
      credentials: () => this.options.getSettings().vault?.credentials ?? [],
      replaceCredentials: (next) => this.options.replaceCredentials?.(next),
      typeSecret: (password) => {
        runtime.info.lastActivityAt = nowMs();
        runtime.backend?.write(`${password}\r`);
      },
      ask: (request) =>
        this.options.emit({ type: 'session-credential', id: runtime.info.id, request }),
      saved: (label) =>
        this.options.emit({
          type: 'notice',
          notice: { level: 'info', key: 'notice.credentialSaved', params: { label } },
        }),
    });
    runtime = {
      info,
      backend: null,
      buffer: '',
      detector: new NestedDetector(settings.probe.nestedDetection),
      timer: null,
      bannerText: '',
      promptLabel: '',
      loginSignalAt: 0,
      lastDeparture: null,
      shellProbeTimer: null,
      shellProbeTimerDepth: 0,
      shellProbeDepth: 0,
      shellProbeAttempts: 0,
      candidate: null,
      escalation: null,
      credential,
      pendingInput: '',
      inputVersion: 0,
      awaitingLineBreak: false,
      probeBusy: false,
      probeFailures: 0,
      everConnected: false,
      injection: null,
      promptText: '',
      repaintGuardUntil: 0,
      lastOutputAt: nowMs(),
      tailText: '',
      altScreen: false,
      titleLocked: Boolean(spec.title),
      apiClients: new Set<string>(),
      connecting: true,
      initialCommandPending: spec.initialCommand ?? null,
      // The spec only carries them for SSH, where "after login" is a moment the
      // user cannot be sitting at the keyboard for.
      loginCommandsPending: spec.kind === 'ssh' ? [...(spec.loginCommands ?? [])] : [],
      closed: false,
      cwd: null,
      cwdReportedVersion: -1,
      cwdQueriedVersion: -1,
      cwdQueryBusy: false,
      cwdFollowing: false,
      cwdTimer: null,
      oscScan: '',
    };

    const handlers = {
      onData: (chunk: string) => this.handleData(runtime, chunk),
      onExit: (code: number | null, error?: Error) => this.handleExit(runtime, code, error),
      onStatus: (status: 'connecting' | 'connected') => {
        runtime.connecting = status === 'connecting';
        runtime.info.status = status === 'connecting' ? 'connecting' : 'connected';
        if (status === 'connected') {
          runtime.everConnected = true;
          this.flushInitialCommand(runtime);
          this.flushLoginCommands(runtime);
          // ConPTY can swallow the first prompt when the renderer fits the pane
          // right after spawn. A resize wiggle forces a repaint (SIGWINCH).
          this.nudgeRepaint(runtime, 600);
          this.scheduleProbe(runtime, 1200);
        }
        this.emitUpdate(runtime);
      },
      onError: (message: string) => this.handleError(runtime, message),
      /**
       * A tunnel is not the tab.
       *
       * The login succeeded and the shell is about to open, so nothing about the
       * session's state changes here: the user gets a toast naming the tunnel
       * that did not come up and keeps working in a tab that is genuinely
       * connected.
       */
      onForwardError: (failure: PortForwardFailure) =>
        this.options.emit({
          type: 'notice',
          notice: {
            level: 'error',
            key: failure.rule ? 'notice.portForwardFailed' : 'notice.portForwardFailedGeneric',
            params: { rule: failure.rule, detail: failure.detail },
          },
        }),
    };

    this.runtimes.set(id, runtime);
    this.options.emit({ type: 'session-created', session: this.snapshot(runtime) });

    try {
      if (spec.kind === 'ssh') {
        runtime.backend = await startSshSession({
          spec,
          settings,
          knownHosts: this.options.knownHosts,
          handlers,
          cols,
          rows,
          onHostKeyChanged: (host) => {
            this.options.emit({ type: 'notice', notice: { level: 'warn', key: 'notice.hostKeyChanged', params: { host } } });
          },
        });
      } else {
        const plan = planSession(spec, this.options.platform, this.options.homeDir, id);
        runtime.info.metadata.endpoint.distribution = spec.kind === 'wsl' ? spec.distribution : undefined;
        runtime.backend = await startLocalSession(plan, handlers, cols, rows);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.info.status = 'error';
      runtime.info.metadata.os.probeError = message;
      this.handleError(runtime, message);
    }

    return this.snapshot(runtime);
  }

  write(id: string, data: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed || !data) return;
    runtime.info.lastActivityAt = nowMs();
    runtime.inputVersion += 1;
    this.cancelCwdRefresh(runtime);
    // What is on the user's line right now. The shell probe must never type on
    // top of it, and this is how the probe knows.
    const submitted = Math.max(data.lastIndexOf('\r'), data.lastIndexOf('\n'));
    if (submitted >= 0) runtime.pendingInput = data.slice(submitted + 1).slice(-256);
    else if (data.includes('\x03')) runtime.pendingInput = '';
    else runtime.pendingInput = `${runtime.pendingInput}${data}`.slice(-256);
    // A password typed at a prompt is the same keystrokes as any other line: the
    // desk sees them before the shell does and decides what they were.
    runtime.credential.onInput(data);
    // Read the typed line first, whatever else is going on: a probe in flight
    // lasts a second or two, and a nested login typed in that window is still a
    // nested login. Dropping it here is what turns a whole hop into a guess.
    if (this.options.getSettings().probe.nestedDetection) {
      const signals = runtime.detector.feedInput(data);
      if (signals.length > 0) this.applySignals(runtime, signals);
    }

    const injection = runtime.injection;
    if (injection) {
      // The user is typing while a probe is in flight: hand the input over to
      // the shell, and let go of the probe at once — whether it already has its
      // answer or not. A line that is still waiting for one may have landed on a
      // login prompt and been read as the password; leaving it in flight would
      // keep the app convinced it knows what is on screen, and the next attempt
      // would type again into the same prompt.
      if (injection.settled) this.finishInjection(runtime, injection);
      else this.abortInjection(runtime, 'interrupted by user input');
    }
    // Invalidate after finishing the drain: it may restore the previous prompt.
    // No amount of silence after Enter can make that old prompt current again.
    if (submitted >= 0 || /[\x03\x04]/.test(data)) {
      runtime.tailText = '';
      runtime.oscScan = '';
      runtime.awaitingLineBreak = submitted >= 0;
    }
    runtime.repaintGuardUntil = 0;
    this.cancelCwdRefresh(runtime);
    runtime.backend?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed) return;
    runtime.info.cols = Math.max(2, Math.floor(cols));
    runtime.info.rows = Math.max(2, Math.floor(rows));
    runtime.backend?.resize(runtime.info.cols, runtime.info.rows);
    this.emitUpdate(runtime);
  }

  rename(id: string, title: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.titleLocked = true;
    runtime.info.title = title;
    this.emitUpdate(runtime);
  }

  attach(id: string): { data: string; cols: number; rows: number } | null {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    return { data: runtime.buffer, cols: runtime.info.cols, rows: runtime.info.rows };
  }

  addClient(id: string, clientId: string): boolean {
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;
    runtime.apiClients.add(clientId);
    runtime.info.attachedClients = runtime.apiClients.size;
    this.emitUpdate(runtime);
    return true;
  }

  removeClient(id: string, clientId: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    if (!runtime.apiClients.delete(clientId)) return;
    runtime.info.attachedClients = runtime.apiClients.size;
    this.emitUpdate(runtime);
  }

  close(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.backend?.kill();
    if (runtime.closed) {
      // A session that failed before it connected stays readable until the user
      // closes its tab; closing the tab is what removes it.
      this.runtimes.delete(id);
      this.options.emit({ type: 'session-closed', id, code: runtime.info.exitCode ?? null });
      return;
    }
    this.finalize(runtime, null, true);
  }

  shutdown(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.backend?.kill();
    }
    this.runtimes.clear();
  }

  exec(id: string, command: string, options?: ExecOptions): Promise<ExecResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed) {
      return Promise.resolve({ code: null, stdout: '', stderr: 'session not found', timedOut: false });
    }
    if (!runtime.backend) {
      return Promise.resolve({ code: null, stdout: '', stderr: 'session not found', timedOut: false });
    }
    return runtime.backend.exec(command, options);
  }

  /**
   * Runs a command the user is meant to watch.
   *
   * An agent's command is not the app's own probe: it changes a machine the
   * user is responsible for, so it has to be visible while it happens, not
   * summarised afterwards. Three things make that true, in this order: the tab
   * comes to the front, the command line is written into the terminal, and
   * every chunk of output is forwarded as it arrives.
   *
   * *Where* it runs is decided by the chain, not by the tab. A nested login
   * (`ssh`, `su`, `sudo -i`) replaces the machine the interactive shell answers
   * for while the side channel still dials the address the tab was created with,
   * so from the first hop on the command is typed into the shell that is on
   * screen (`runCommandOnCurrentHop()`). A tab that is still on its own machine
   * keeps the out-of-band channel.
   *
   * A local session keeps it too. Nothing an agent does on the desktop needs
   * watching — the user is already there — and typing into a PowerShell prompt
   * that may be mid-line would be worse than silence. The exception is the same
   * one an SSH tab has: `ssh` typed inside a local shell puts the user elsewhere,
   * and a command run "locally" would then land on the desktop instead.
   */
  async runCommand(id: string, command: string, options?: ExecOptions): Promise<ExecResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed || !runtime.backend) {
      return { code: null, stdout: '', stderr: 'session not found', timedOut: false };
    }
    // Where the user is standing decides where the command goes — never the kind
    // of tab it happens to be. A login that was typed here and has not answered
    // yet counts as "not where the tab was opened" too: which machine is on
    // screen is already ambiguous, and the tab's own host would be a guess.
    const nested =
      runtime.info.metadata.endpoint.chain.length > 1 || runtime.candidate !== null;
    if (runtime.info.kind !== 'ssh' && !nested) return this.exec(id, command, options);

    this.options.emit({ type: 'session-focus', id });
    this.pushDisplay(runtime, `\r\n${DISPLAY_DIM}$ ${displaySafeCommand(command)}${DISPLAY_RESET}\r\n`);

    let streamed = false;
    const result = nested
      ? await this.runCommandOnCurrentHop(runtime, command, options)
      : await this.exec(id, command, {
          ...options,
          onData: (chunk) => {
            options?.onData?.(chunk);
            if (chunk) streamed = true;
            this.pushDisplay(runtime, toDisplayLines(chunk));
          },
        });
    // A channel that never opened has nothing on screen yet: the reason it
    // failed is the only thing worth showing. A command that ran in the shell
    // streamed its own output; what is left in `stderr` there is the answer to
    // why it did *not* run.
    if (!streamed && result.stderr.trim()) this.pushDisplay(runtime, toDisplayLines(result.stderr));
    this.pushDisplay(runtime, `${DISPLAY_DIM}[exit ${result.code ?? '?'}]${DISPLAY_RESET}\r\n`);
    // The block above was written *over* the line the shell's prompt was on, so
    // the prompt is now somewhere up the scrollback and the user is left with a
    // bare cursor: the shell will not paint again until Enter. A window change
    // makes the shell redraw its own prompt where the cursor is — the same
    // thing pressing Enter by hand did, minus the keystroke. The repaint guard
    // is cleared first, because its premise ("the prompt on screen is the one
    // being repainted") is exactly what the block just invalidated.
    //
    // A command typed into the shell needs none of that: no annotation covered
    // its prompt line, and the shell painted its own prompt afterwards, which
    // the display already has. Nudging there would paint a second one.
    if (!nested) {
      runtime.repaintGuardUntil = 0;
      this.nudgeRepaint(runtime, 40);
    }
    this.emitUpdate(runtime);
    return result;
  }

  /**
   * Runs a command on the machine the user is standing on, by typing it into
   * that shell.
   *
   * After a nested login the side channel still answers for the outer host.
   * Using it would change a machine the user is not looking at while the panel
   * names the other one — the worst answer this app can give. The shell on
   * screen is the only channel that reaches the hop on top of the chain, so the
   * command goes in the same way the metadata probe does: one line, invisible
   * markers around the output, and the captured middle of it streamed to the
   * display (`visible`).
   *
   * When the shell cannot be typed into, nothing runs anywhere. A missing exit
   * code is a bug; a destructive command on the wrong machine is not.
   */
  private async runCommandOnCurrentHop(
    runtime: Runtime,
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const target = runtime.info.metadata.endpoint.displayName;
    // A login that was typed here and has not answered yet: the shell may be
    // reading a password right now, and which machine it is on is not known. A
    // line typed into that is worse than a refusal — it is a password nobody
    // typed, sent to a host nobody chose.
    if (runtime.candidate) {
      return {
        code: null,
        stdout: '',
        stderr: 'not run: a login typed in this terminal has not answered yet',
        timedOut: false,
      };
    }
    const reason = this.shellRefusal(runtime);
    if (reason) {
      return { code: null, stdout: '', stderr: `not run on ${target}: ${reason}`, timedOut: false };
    }

    const result = await this.execViaShell(
      runtime.info.id,
      // The directory has to travel with the line: the shell it is typed into
      // is wherever the user left it, which is not the caller's business.
      withWorkingDirectory(command, options?.cwd, 'posix'),
      options?.timeoutMs ?? SHELL_COMMAND_TIMEOUT_MS,
      { visible: true, signal: options?.signal },
    );
    // Nothing was captured and there is no exit status: the line never reached a
    // shell. Saying so is the only honest answer, because the alternative is
    // running it on the machine that is still reachable and is the wrong one.
    if (result.code === null && !result.stdout.trim()) {
      return {
        ...result,
        stderr: `not run on ${target}: ${result.stderr || 'the shell did not answer'}`,
      };
    }
    return result;
  }

  /** Why a command cannot be typed into this shell, or `undefined` when it can. */
  private shellRefusal(runtime: Runtime): string | undefined {
    if (!runtime.backend?.posixShell) return 'its shell is not a POSIX shell, so no line can be typed into it';
    if (runtime.altScreen) return 'a full-screen program is running in it';
    if (runtime.injection) return 'the app is already typing into it';
    return undefined;
  }

  /** Brings a terminal to the front, for callers outside the renderer. */
  focus(id: string): boolean {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed) return false;
    this.options.emit({ type: 'session-focus', id });
    return true;
  }

  /**
   * Types a command into the interactive shell and captures its output between
   * two invisible markers. This is the only way to reach the *current* machine
   * after a nested login, because the side channel still points at the outer
   * host.
   *
   * The metadata probe is not supposed to be noticed: the line keeps itself out
   * of the shell history and the prompt repaint that follows it is drained
   * instead of printed. See `buildShellInjection()` / `finishInjection()`.
   *
   * A command an agent runs is the opposite — `visible` — and its output is
   * shown as it arrives (see `streamInjection()`): the user is watching a
   * machine they are responsible for.
   */
  async execViaShell(
    id: string,
    command: string,
    timeoutMs = 8000,
    options: { visible?: boolean; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return { code: null, stdout: '', stderr: 'session not found', timedOut: false };
    }
    if (options.signal?.aborted) {
      return { code: null, stdout: '', stderr: 'interrupted', timedOut: false };
    }
    if (!runtime.backend?.posixShell) {
      return { code: null, stdout: '', stderr: 'shell injection is only supported for POSIX shells', timedOut: false };
    }
    if (runtime.injection) {
      return { code: null, stdout: '', stderr: 'another probe is in flight', timedOut: false };
    }
    const inputVersion = runtime.inputVersion;
    if (!(await this.waitForIdle(runtime, 3000, inputVersion)) ||
        inputVersion !== runtime.inputVersion || !this.injectionSafe(runtime)) {
      // `waitForIdle()` polls, so its verdict can be a fifth of a second old —
      // old enough for the user to have submitted a line in between. Checked
      // again immediately before the write, because the cost of being wrong is
      // a login that fails with a password nobody typed.
      return { code: null, stdout: '', stderr: 'session is busy', timedOut: true };
    }

    const token = randomUUID().replace(/-/g, '').slice(0, 10);
    const { line, beginMarker, endMarker } = buildShellInjection(token, command);

    return new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = runtime.injection;
        runtime.injection = null;
        if (pending?.drainTimer) clearTimeout(pending.drainTimer);
        // The line never answered. Whatever the app believed was on screen
        // cannot be trusted any more: it is exactly this stale prompt that lets
        // the next attempt type into a login prompt that has no marker output.
        runtime.tailText = '';
        runtime.promptText = '';
        resolve({
          code: null,
          stdout: pending ? stripAnsi(pending.buffer) : '',
          stderr: 'timeout',
          timedOut: true,
        });
        this.emitUpdate(runtime);
      }, timeoutMs);

      runtime.injection = {
        token,
        beginMarker,
        endMarker,
        visible: options.visible === true,
        shown: 0,
        command,
        buffer: '',
        startedAt: nowMs(),
        timer,
        settled: false,
        drained: '',
        drainTimer: null,
        drainDeadline: 0,
        // What the user is looking at: the prompt the shell is about to paint
        // again. Recorded here, before the line is typed, so a repaint can be
        // recognised even when it carries no prompt-shaped punctuation.
        promptBefore: promptOnScreen(runtime.tailText),
        resolve,
      };
      // Ctrl-C at the shell: the command stops where it runs, and the line it
      // was part of goes with it. Waiting for markers that will never arrive
      // would leave a killed command blocking the tab for its full timeout.
      options.signal?.addEventListener(
        'abort',
        () => {
          if (runtime.injection?.token !== token) return;
          runtime.backend?.write('\x03');
          this.abortInjection(runtime, 'interrupted', false, false);
        },
        { once: true },
      );
      runtime.backend?.write(`${line}\r`);
    });
  }

  async probe(id: string): Promise<SessionMetadata | null> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    const depth = runtime.info.metadata.endpoint.chain.length;
    if (depth > 1 && runtime.backend?.posixShell) {
      // Manual refresh on a nested login: the side channel still answers for the
      // outer host, so the only way to answer for this one is the shell.
      runtime.shellProbeAttempts = 0;
      await this.runShellProbe(runtime, depth, true);
    } else {
      await this.runProbe(runtime);
    }
    return runtime.info.metadata;
  }

  /**
   * The directory the interactive shell is in.
   *
   * Three sources, cheapest first: the shell names it (OSC 7 / OSC 9;9), a
   * `pwd` typed at its prompt answers it, or it stays unknown. The typed line
   * only happens once per prompt, only while the shell is idle, and only for a
   * shell whose line can be hidden — the machinery the nested-login probe
   * already uses. Nothing is typed into a nested login: that tab's files belong
   * to the host it was opened on, so following would point at another machine.
   */
  async refreshCwd(id: string): Promise<string | null> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    if (!this.canQueryCwd(runtime)) return runtime.cwd;
    if (runtime.cwdQueryBusy) return runtime.cwd;
    // The shell named its directory for this very prompt: nothing to type.
    if (runtime.cwdReportedVersion === runtime.inputVersion) return runtime.cwd;
    if (runtime.cwdQueriedVersion === runtime.inputVersion) return runtime.cwd;
    if (nowMs() - runtime.lastOutputAt < CWD_QUIET_MS) return runtime.cwd;
    if (!this.injectionSafe(runtime)) return runtime.cwd;

    const inputVersion = runtime.inputVersion;
    runtime.cwdQueryBusy = true;
    runtime.cwdQueriedVersion = inputVersion;
    let retry = false;
    try {
      const result = await this.execViaShell(id, 'pwd', 4000);
      // Another probe can acquire the shell during execViaShell's idle check.
      // Nothing was written in that case; this prompt still deserves its query.
      retry = result.stderr === 'session is busy' || result.stderr === 'another probe is in flight';
      if (retry && runtime.cwdQueriedVersion === inputVersion) runtime.cwdQueriedVersion = -1;
      const answer = stripAnsi(result.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop();
      if (runtime.closed || inputVersion !== runtime.inputVersion ||
          !this.canQueryCwd(runtime) || result.code !== 0 || result.timedOut ||
          !answer || !answer.startsWith('/')) return runtime.cwd;
      if (answer !== runtime.cwd) {
        runtime.cwd = answer;
        this.emitUpdate(runtime);
      }
      return answer;
    } finally {
      runtime.cwdQueryBusy = false;
      // A new prompt may have arrived while the previous query was interrupted.
      if (retry || inputVersion !== runtime.inputVersion) this.scheduleCwdRefresh(runtime);
    }
  }

  /** Follow only while the file sheet needs it; subsequent output drives queries. */
  followCwd(id: string, follow: boolean): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed) return;
    runtime.cwdFollowing = follow;
    this.cancelCwdRefresh(runtime);
    if (follow) this.scheduleCwdRefresh(runtime);
  }

  private canQueryCwd(runtime: Runtime): boolean {
    return !runtime.closed && runtime.backend?.posixShell === true &&
      runtime.info.metadata.endpoint.chain.length === 1 && !runtime.candidate && !runtime.altScreen;
  }

  private cancelCwdRefresh(runtime: Runtime): void {
    if (runtime.cwdTimer) clearTimeout(runtime.cwdTimer);
    runtime.cwdTimer = null;
  }

  /** Coalesces split prompt output once, without a renderer or main-process poll. */
  private scheduleCwdRefresh(runtime: Runtime): void {
    this.cancelCwdRefresh(runtime);
    if (!runtime.cwdFollowing || !this.canQueryCwd(runtime) || runtime.cwdQueryBusy ||
        runtime.cwdReportedVersion === runtime.inputVersion ||
        runtime.cwdQueriedVersion === runtime.inputVersion || !this.injectionSafe(runtime)) return;
    const inputVersion = runtime.inputVersion;
    const delay = Math.max(0, CWD_QUIET_MS - (nowMs() - runtime.lastOutputAt));
    runtime.cwdTimer = setTimeout(() => {
      runtime.cwdTimer = null;
      if (!runtime.cwdFollowing || inputVersion !== runtime.inputVersion) return;
      void this.refreshCwd(runtime.info.id).catch(() => undefined);
    }, delay);
  }

  /** The session's own SFTP channel, multiplexed over its SSH connection. */
  /**
   * Answers the credential popover of one terminal.
   *
   * Two answers are possible because two questions are: `accept` types a saved
   * password into the prompt that is waiting, or keeps the one just typed; and
   * `dismiss` means "not now" — the password is neither used nor stored, and
   * the tab is not asked again about that login.
   */
  respondCredential(id: string, decision: 'accept' | 'dismiss'): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed) return;
    runtime.credential.respond(decision);
  }

  openSftp(id: string): Promise<SFTPWrapper | null> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed || !runtime.backend?.sftp) return Promise.resolve(null);
    return runtime.backend.sftp().catch(() => null);
  }

  setProbeEnabled(id: string, enabled: boolean): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.info.probe.enabled = enabled;
    if (!enabled && runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    if (enabled) this.scheduleProbe(runtime, 200);
    this.emitUpdate(runtime);
  }

  /* ------------------------------------------------------------- internals */

  private defaultTitle(spec: SessionSpec): string {
    if (spec.kind === 'ssh') return `${spec.target.username}@${spec.target.host}`;
    if (spec.kind === 'wsl') return spec.distribution || 'WSL';
    return spec.args.length > 0 ? `${spec.command} ${spec.args.join(' ')}` : spec.command;
  }

  private initialHop(spec: SessionSpec): SessionHop {
    if (spec.kind === 'ssh') {
      return {
        label: `${spec.target.username}@${spec.target.host}`,
        host: spec.target.host,
        port: spec.target.port,
        username: spec.target.username,
        detectedBy: 'session',
        confidence: 'high',
        at: nowMs(),
      };
    }
    if (spec.kind === 'wsl') {
      return {
        label: spec.distribution || 'WSL',
        detectedBy: 'session',
        confidence: 'high',
        at: nowMs(),
      };
    }
    return {
      label: spec.command,
      detectedBy: 'session',
      confidence: 'high',
      at: nowMs(),
    };
  }

  private probeState(settings: Settings): ProbeState {
    return {
      enabled: settings.probe.enabled,
      intervalMs: settings.probe.intervalMs,
      channel: undefined,
    };
  }

  private snapshot(runtime: Runtime): SessionInfo {
    const { endpoint, os } = runtime.info.metadata;
    return {
      ...runtime.info,
      metadata: {
        ...runtime.info.metadata,
        endpoint: {
          ...endpoint,
          // WSL sessions know their distribution from the spec; everywhere else
          // it comes from what the probe or the login banner read about the host.
          distribution: endpoint.distribution ?? distroName(os.os),
          chain: [...endpoint.chain],
        },
        os: { ...os },
        extra: { ...runtime.info.metadata.extra },
      },
      probe: { ...runtime.info.probe },
      cwd: runtime.cwd ?? undefined,
      attachedClients: runtime.apiClients.size,
      bufferBytes: runtime.buffer.length,
    };
  }

  private emitUpdate(runtime: Runtime): void {
    // A probe or metadata timer can finish after the tab was closed. A snapshot
    // for a session the renderer already dropped must never reach it again, or
    // the tab comes back from the dead.
    if (!this.runtimes.has(runtime.info.id)) return;
    this.options.emit({ type: 'session-updated', session: this.snapshot(runtime) });
  }

  private emitMetadata(runtime: Runtime): void {
    runtime.info.metadata.updatedAt = nowMs();
    this.options.emit({
      type: 'session-metadata',
      id: runtime.info.id,
      metadata: this.snapshot(runtime).metadata,
    });
    this.emitUpdate(runtime);
  }

  private handleData(runtime: Runtime, chunk: string): void {
    runtime.info.lastActivityAt = nowMs();
    runtime.lastOutputAt = nowMs();

    if (runtime.injection) {
      this.handleInjectionData(runtime, chunk);
      return;
    }

    // A slow link or a slow prompt can paint the prompt again *after* the
    // injection stopped looking. It is the prompt that is already on screen, so
    // it is swallowed here instead of turning one prompt into two.
    if (runtime.repaintGuardUntil > nowMs() && isBarePromptRepaint(chunk, runtime.promptText)) {
      runtime.tailText = `${runtime.tailText}${chunk}`.slice(-400);
      return;
    }

    this.appendBuffer(runtime, chunk);
    this.options.emit({ type: 'session-output', id: runtime.info.id, data: chunk });

    if (chunk.includes('\x1b[?1049h')) runtime.altScreen = true;
    if (chunk.includes('\x1b[?1049l')) runtime.altScreen = false;
    runtime.tailText = `${runtime.tailText}${chunk}`.slice(-400);
    // The submitted line's echo (which can itself end in '$' or '#') must end
    // before a prompt can be considered fresh. Bracketed-paste enable also
    // identifies readline returning to its prompt, including with echo off.
    if (chunk.includes('\n') || chunk.includes('\x1b[?2004h')) runtime.awaitingLineBreak = false;
    this.trackPrompt(runtime);
    // The prompt on screen may be a password prompt: noticed before anything
    // else reads the output, so a saved answer can be offered while it waits.
    runtime.credential.onOutput();
    this.trackCwd(runtime, chunk);
    // The banner last: a hop the prompt just confirmed is on the chain by now,
    // so the addresses the banner reports land on the hop they describe.
    this.collectBanner(runtime, chunk);

    if (this.options.getSettings().probe.nestedDetection) {
      const signals = runtime.detector.feedOutput(chunk);
      if (signals.length > 0) this.applySignals(runtime, signals);
    }
    this.scheduleCwdRefresh(runtime);
  }

  private handleInjectionData(runtime: Runtime, chunk: string): void {
    const pending = runtime.injection;
    if (!pending) return;

    if (pending.settled) {
      pending.drained += chunk;
      if (!pending.visible) {
        this.armInjectionDrain(runtime, pending);
        return;
      }
      // A command the user is watching: the prompt the shell paints after it is
      // the thing they need back, and they never saw this line's echo, so there
      // is no duplicate to protect them from.
      this.armVisibleFinish(runtime, pending);
      return;
    }

    pending.buffer += chunk;
    // The shell under the line is going away — `exit` from a nested login, a
    // dropped connection. The markers will never arrive, and waiting for the
    // timeout would freeze the terminal and then throw this output away.
    if (looksLikeSessionEnd(pending.buffer)) {
      this.abortInjection(runtime, 'the session ended', true);
      return;
    }
    // A command the user is meant to watch says what it is doing as it does it;
    // a probe's capture stays invisible until it is over.
    if (pending.visible) this.streamInjection(runtime, pending);
    const endIndex = pending.buffer.indexOf(pending.endMarker);
    if (endIndex < 0) {
      // The line landed on a prompt that reads its answer from this tty — an
      // `ssh` password, a host-key confirmation, a passphrase. The markers are
      // never going to come, and a retry would answer that prompt again, so the
      // probe lets go at once and forgets what it thought was on screen.
      if (looksLikeCredentialPrompt(pending.buffer)) {
        this.abortInjection(runtime, 'the line was read by a login prompt');
      }
      return;
    }
    const codeStart = endIndex + pending.endMarker.length + 1;
    const codeEnd = pending.buffer.indexOf('\n', codeStart);
    const rawCode = codeEnd < 0 ? pending.buffer.slice(codeStart) : pending.buffer.slice(codeStart, codeEnd);
    const beginIndex = pending.buffer.indexOf(pending.beginMarker);
    const start = beginIndex < 0 ? 0 : beginIndex + pending.beginMarker.length;
    const captured = beginIndex < 0 ? '' : pending.buffer.slice(start, endIndex);
    const code = Number.parseInt(rawCode.trim(), 10);
    const remainder = codeEnd < 0 ? '' : pending.buffer.slice(codeEnd + 1);

    clearTimeout(pending.timer);
    pending.settled = true;
    pending.buffer = '';
    pending.drained = remainder;
    pending.drainDeadline = nowMs() + INJECTION_DRAIN_MAX_MS;
    pending.resolve({
      code: Number.isFinite(code) ? code : null,
      stdout: captured.replace(/\r\n/g, '\n'),
      stderr: '',
      timedOut: false,
    });
    // The answer is in, but the display stays quiet for a moment: what follows
    // the end marker is the shell repainting the prompt that is already there.
    if (pending.visible) this.armVisibleFinish(runtime, pending);
    else this.armInjectionDrain(runtime, pending);
  }

  /**
   * Ends a visible injection on the next tick.
   *
   * The prompt the shell paints after the markers belongs to whatever the
   * caller that typed the line does next: it prints its own closing line
   * (`[exit 0]`) the moment the promise resolves, and a prompt that arrived in
   * the same chunk as the marker must land after that line, not before it and
   * never inside the block.
   */
  private armVisibleFinish(runtime: Runtime, pending: PendingInjection): void {
    if (pending.drainTimer) clearTimeout(pending.drainTimer);
    pending.drainTimer = setTimeout(() => this.finishInjection(runtime, pending), 0);
  }

  /**
   * Puts what a *visible* injection has produced on screen so far.
   *
   * Only the span between the markers is output: the echoed line before the
   * begin marker and the end marker itself are the app's own noise, and half a
   * marker arriving in one chunk is not output either — so the last few
   * characters are held back until the marker is either found or the line is
   * given up on.
   */
  private streamInjection(runtime: Runtime, pending: PendingInjection): void {
    const begin = pending.buffer.indexOf(pending.beginMarker);
    if (begin < 0) return;
    const from = begin + pending.beginMarker.length;
    const end = pending.buffer.indexOf(pending.endMarker, from);
    const until = end >= 0 ? end : Math.max(from, pending.buffer.length - pending.endMarker.length);
    if (until - from <= pending.shown) return;
    const fresh = pending.buffer.slice(from + pending.shown, until);
    pending.shown = until - from;
    if (fresh) this.pushDisplay(runtime, toDisplayLines(fresh));
  }

  /**
   * Keeps swallowing output until the prompt repaint looks complete.
   *
   * A repaint that already ends in something prompt-shaped is done: a short
   * quiet window means the shell has nothing more to say. Anything else — an
   * empty tail because the repaint is still in flight, or real output — waits
   * for the deadline instead. Ending early there would let the rest of the
   * prompt escape the drain, and a prompt flushed in two chunks (ConPTY, a slow
   * SSH link) would print a second time after all.
   */
  private armInjectionDrain(runtime: Runtime, pending: PendingInjection): void {
    if (pending.drainTimer) clearTimeout(pending.drainTimer);
    const remaining = pending.drainDeadline - nowMs();
    if (remaining <= 0) {
      this.finishInjection(runtime, pending);
      return;
    }
    const complete =
      pending.drained.length > 0 &&
      (looksLikePromptTail(promptOnScreen(pending.drained)) ||
        promptOnScreen(pending.drained) === pending.promptBefore);
    const delay = Math.min(complete ? INJECTION_DRAIN_IDLE_MS : remaining, remaining);
    pending.drainTimer = setTimeout(() => this.finishInjection(runtime, pending), Math.max(60, delay));
  }

  /**
   * Ends an injection.
   *
   * Everything after the end marker is normally the shell repainting its
   * prompt — the same prompt the user is already looking at, sometimes painted
   * more than once. Printing it again is what made a prompt appear two or three
   * times on one line after a nested login, so a block that is nothing but
   * repaints is dropped. A block a repaint cannot explain is still shown,
   * because dropping it would swallow real output.
   */
  private finishInjection(runtime: Runtime, pending: PendingInjection): void {
    if (pending.drainTimer) {
      clearTimeout(pending.drainTimer);
      pending.drainTimer = null;
    }
    if (runtime.injection !== pending) return;

    runtime.injection = null;
    const drained = pending.drained;
    pending.drained = '';
    if (drained) {
      runtime.tailText = `${runtime.tailText}${drained}`.slice(-400);
      // A probe's tail is normally the prompt it already showed, so a block that
      // is nothing but repaints is dropped. A visible command has shown nothing
      // of the sort: its prompt is new to the screen, and it is what the user is
      // waiting for.
      const text = pending.visible ? drained : injectionTailToDisplay(drained, pending.promptBefore);
      if (text) {
        this.appendBuffer(runtime, text);
        this.options.emit({ type: 'session-output', id: runtime.info.id, data: text });
      }
    }
    // Keep watching for a while: a shell that is slow to paint its prompt can
    // still repaint the one that is already there.
    runtime.promptText = pending.promptBefore;
    runtime.repaintGuardUntil = nowMs() + INJECTION_REPAINT_GUARD_MS;
    this.emitUpdate(runtime);
    // A metadata probe may have held the shell when the cwd timer fired.
    // The input revision keeps a cwd probe from scheduling another copy of itself.
    this.scheduleCwdRefresh(runtime);
  }

  /**
   * Throws an injection away, without showing anything it captured.
   *
   * Used when the typed line can no longer be trusted to be answered by a
   * shell: the user took the line over, or the line itself was read by a login
   * prompt. The captured text is the app's own noise and is dropped — but the
   * tail goes with it. A prompt the app saw *before* it typed may not be on
   * screen any more, and judging the shell idle from that is exactly what makes
   * the next attempt type into a password prompt.
   */
  private abortInjection(runtime: Runtime, reason: string, flush = false, timedOut = true): void {
    const pending = runtime.injection;
    if (!pending) return;
    runtime.injection = null;
    clearTimeout(pending.timer);
    if (pending.drainTimer) clearTimeout(pending.drainTimer);
    pending.drainTimer = null;
    pending.settled = true;
    runtime.tailText = '';
    runtime.promptText = '';
    runtime.repaintGuardUntil = 0;

    // A session that ended under the injection took real output down with it.
    // That output is put on screen before the line is dropped; the rest of the
    // capture is the app's own typed line and stays out of the display.
    if (flush) {
      const visible = injectionCaptureToDisplay(pending.buffer);
      if (visible) {
        const block = `\r\n${visible}`;
        runtime.tailText = block.slice(-400);
        this.appendBuffer(runtime, block);
        this.options.emit({ type: 'session-output', id: runtime.info.id, data: block });
      }
    }

    pending.resolve({
      code: null,
      stdout: stripAnsi(pending.buffer),
      stderr: reason,
      timedOut,
    });
    this.emitUpdate(runtime);
  }

  /**
   * Writes text the app authored into one terminal.
   *
   * It travels the same two paths as real output — the rollback buffer and the
   * `session-output` event — so a command the agent ran is still on screen
   * after the tab is reopened. The prompt tracker is deliberately left alone:
   * `tailText` is what the probes judge the shell by, and an annotation the app
   * wrote itself is not something a shell said.
   */
  private pushDisplay(runtime: Runtime, text: string): void {
    if (!text) return;
    this.appendBuffer(runtime, text);
    this.options.emit({ type: 'session-output', id: runtime.info.id, data: text });
    runtime.lastOutputAt = nowMs();
  }

  private appendBuffer(runtime: Runtime, chunk: string): void {
    runtime.buffer += chunk;
    if (runtime.buffer.length > BUFFER_LIMIT) {
      runtime.buffer = runtime.buffer.slice(runtime.buffer.length - BUFFER_LIMIT);
    }
  }

  private handleExit(runtime: Runtime, code: number | null, error?: Error): void {
    if (error) runtime.info.metadata.os.probeError = error.message;
    this.finalize(runtime, code);
  }

  private finalize(runtime: Runtime, code: number | null, explicit = false): void {
    if (runtime.closed) {
      if (!explicit) return;
      this.runtimes.delete(runtime.info.id);
      this.options.emit({ type: 'session-closed', id: runtime.info.id, code: runtime.info.exitCode ?? null });
      return;
    }

    runtime.closed = true;
    this.cancelCwdRefresh(runtime);
    runtime.info.status = code === 0 || code === null ? 'exited' : 'error';
    runtime.info.exitCode = code;
    // Nothing is typed into a tab that is gone.
    runtime.loginCommandsPending.length = 0;
    runtime.credential.reset();
    if (runtime.timer) clearTimeout(runtime.timer);
    if (runtime.shellProbeTimer) clearTimeout(runtime.shellProbeTimer);
    if (runtime.injection) {
      clearTimeout(runtime.injection.timer);
      if (runtime.injection.drainTimer) clearTimeout(runtime.injection.drainTimer);
      runtime.injection = null;
    }

    // A session that never connected (bad credentials, unreachable host, bad
    // key file) keeps its tab open so the reason stays visible in the UI and in
    // Session info, instead of vanishing after a toast.
    if (!runtime.everConnected && !explicit) {
      runtime.info.status = 'error';
      this.emitUpdate(runtime);
      return;
    }

    this.emitUpdate(runtime);
    this.options.emit({ type: 'session-closed', id: runtime.info.id, code });
    this.runtimes.delete(runtime.info.id);
  }

  private handleError(runtime: Runtime, message: string): void {
    runtime.info.status = 'error';
    runtime.info.metadata.os.probeError = message;
    this.options.emit({
      type: 'notice',
      notice: { level: 'error', key: 'error.connect', params: { message } },
    });
    this.emitUpdate(runtime);
  }

  /**
   * Applies what the terminal said to the chain.
   *
   * A typed line only *proposes* a move: it becomes `runtime.candidate`, and the
   * chain is not touched until the shell confirms it (see `trackPrompt`). Every
   * way an attempt can end without arriving — a refused password, a connection
   * that never opened, `Ctrl-C` — drops the candidate and leaves the chain
   * describing the place the user is still standing on.
   */
  private applySignals(runtime: Runtime, signals: NestedSignal[]): void {
    const chain = runtime.info.metadata.endpoint.chain;
    let changed = false;
    let machineChanged = false;

    for (const signal of signals) {
      if (signal.type === 'push') {
        // Not a hop yet: the line was submitted, the login has not answered.
        runtime.candidate = signal.hop;
      } else if (signal.type === 'escalation') {
        // What the machine may want a password for next: `sudo` asks about the
        // account already here, `su` about the one it switches to. Every
        // submitted line replaces this, so a `sudo` the user has moved on from
        // stops answering for whatever prompt turns up later.
        runtime.escalation = signal.via ? { via: signal.via, account: signal.account } : null;
      } else if (signal.type === 'failed' || signal.type === 'cancelled') {
        this.dropCandidate(runtime);
        runtime.escalation = null;
        // The login this password was typed for did not happen after all.
        runtime.credential.onAttemptFailed();
      } else if (signal.type === 'pop') {
        // An `exit` (or a closed connection) while a move is still in flight
        // means the move is what is being abandoned.
        if (runtime.candidate) {
          this.dropCandidate(runtime);
          continue;
        }
        // One departure is printed by every layer that took part in it, and the
        // copies land seconds apart on a slow link. Only the first may take a
        // hop; the rest describe the hop that is already gone.
        if (this.reportIsCounted(runtime, signal)) continue;
        const leaving = chain[chain.length - 1];
        const update = popHop(chain);
        if (!update.changed) continue;
        this.noteDeparture(runtime, leaving);
        changed = true;
        if (update.machineChanged) machineChanged = true;
        runtime.info.metadata.endpoint.source = chain.length > 1 ? 'nested' : 'session';
      } else if (signal.type === 'title') {
        runtime.info.metadata.extra['terminal.title'] = signal.label;
        // The shell of the machine that was dialed is painting a title: the
        // candidate is where the user is.
        if (runtime.candidate && this.titleConfirms(runtime, signal)) {
          const update = commitHop(chain, runtime.candidate, {
            source: 'osc-title',
            hostname: signal.host,
            username: signal.username,
          });
          runtime.candidate = null;
          runtime.credential.onLanded();
          changed = changed || update.changed;
          if (update.machineChanged) machineChanged = true;
          runtime.info.metadata.endpoint.source = 'nested';
          runtime.info.metadata.extra['nested.at'] = String(nowMs());
          continue;
        }
        const update = adoptTitle(chain, signal);
        changed = changed || update.changed;
      }
    }

    if (!changed) {
      this.emitUpdate(runtime);
      return;
    }
    if (machineChanged) this.forgetHostData(runtime);
    this.recomputeEndpoint(runtime);
    this.emitMetadata(runtime);
    // A nested login means the side channel no longer describes where the user
    // is: ask the shell itself, once, without them noticing.
    if (machineChanged) this.scheduleShellProbe(runtime);
  }

  /**
   * True when a title names the machine the typed line was aiming at.
   *
   * The shell repaints its title after a login, and a machine that never
   * answered never gets that far — which is exactly what makes this evidence.
   */
  private titleConfirms(runtime: Runtime, signal: { host?: string; username?: string }): boolean {
    if (!runtime.candidate || !signal.host) return false;
    return candidateMatches(runtime.candidate, {
      username: signal.username ?? runtime.candidate.username ?? '',
      hostname: signal.host,
    });
  }

  /** True when a printed report describes a departure that is already counted. */
  private reportIsCounted(runtime: Runtime, signal: { origin: 'typed' | 'printed'; host?: string }): boolean {
    if (signal.origin !== 'printed') return false;
    const last = runtime.lastDeparture;
    if (!last) return false;
    const since = nowMs() - last.at;
    if (since < POP_EPISODE_MS) return true;
    if (!signal.host) return false;
    // A late copy names the machine the user just left; the hop being stood on
    // now is described by other reports, if there is one.
    const names = [last.host, last.hostname].filter((name): name is string => Boolean(name));
    return since < POP_REPORT_LATE_MS && names.some((name) => namesAgree(name, signal.host as string));
  }

  /** Remembers the hop that was just dropped, so its late reports are recognised. */
  private noteDeparture(runtime: Runtime, hop: SessionHop | undefined): void {
    if (!hop) return;
    runtime.lastDeparture = { at: nowMs(), host: hop.host, hostname: hop.hostname };
  }

  /**
   * Forgets a move that was typed but never confirmed.
   *
   * Nothing about the chain changes: it never held that hop.
   */
  private dropCandidate(runtime: Runtime): void {
    runtime.candidate = null;
  }

  /**
   * Drops everything learned about the machine the session just left.
   *
   * What the probe and the banner said describes the outer host from now on, and
   * showing it for the inner one is worse than showing nothing. A hop that only
   * changed the user keeps all of it, because the machine did not change.
   */
  private forgetHostData(runtime: Runtime): void {
    runtime.info.metadata.os = {};
    runtime.bannerText = '';
    runtime.shellProbeDepth = 0;
    runtime.shellProbeAttempts = 0;
    if (runtime.shellProbeTimer) {
      clearTimeout(runtime.shellProbeTimer);
      runtime.shellProbeTimer = null;
    }
  }

  /** Mirrors the top of the chain onto the endpoint the panel reads. */
  private recomputeEndpoint(runtime: Runtime): void {
    const endpoint = runtime.info.metadata.endpoint;
    const next = endpointFromChain(endpoint.chain);
    if (!next) return;
    endpoint.displayName = next.displayName;
    endpoint.host = next.host;
    endpoint.hostname = next.hostname;
    endpoint.port = next.port;
    endpoint.username = next.username;
    if (endpoint.chain.length > 1) endpoint.source = 'nested';
    if (!runtime.titleLocked) runtime.info.title = next.displayName;
  }

  /**
   * Gives the hop the user is on the address the machine reported about itself.
   *
   * Nothing else would ever fill it in: a nested login `ssh node-01` names
   * no address, and the probe that learns one describes the machine the user is
   * standing on right now — the moment to write it down is before the chain
   * moves on and that data is dropped.
   */
  private adoptCurrentAddress(runtime: Runtime): void {
    const update = adoptAddress(runtime.info.metadata.endpoint.chain, runtime.info.metadata.os);
    if (update.changed) this.recomputeEndpoint(runtime);
  }

  /**
   * Follows the `user@host` of the prompt that is on screen.
   *
   * This is where a typed move becomes real, and where it stops being real:
   *
   *   - the same prompt painting again means the shell is still where it was, so
   *     a move that has not been confirmed by now never happened (`Ctrl-C` at a
   *     password, a login that was refused, a connection that dropped);
   *   - a different prompt is read by `adoptPrompt()`: it confirms the typed
   *     move, steps back out of a hop, or names a machine a banner announced.
   *
   * A nested login the typed line never reported — a command the app typed
   * itself, a paste the detector split, a keystroke lost in an injection — still
   * shows up through the second rule.
   */
  private trackPrompt(runtime: Runtime): void {
    const identity = promptIdentity(runtime.tailText);
    if (!identity) return;
    const label = `${identity.username}@${identity.hostname}`;

    if (label === runtime.promptLabel) {
      // Same prompt again: nothing moved. A move that was typed and never
      // confirmed is exactly what this describes.
      if (runtime.candidate) this.dropCandidate(runtime);
      return;
    }

    const firstPrompt = runtime.promptLabel === '';
    runtime.promptLabel = label;
    // The prompt the tab opened with says nothing the session was not created
    // with; every later one is the shell renaming where the user stands.
    if (firstPrompt) {
      this.dropCandidate(runtime);
      return;
    }
    // Another shell is painting its prompt: whatever was typed at the prompt
    // that just went away was answered by a login that got through. The chain
    // may not follow it — a command recalled from history leaves nothing for the
    // detector to read — but the login happened, so the password is worth
    // offering to keep.
    runtime.credential.onLanded({ username: identity.username, host: identity.hostname });
    this.applyPromptIdentity(runtime, identity.username, identity.hostname);
  }

  /**
   * Applies the `user@host` of the prompt on screen to the chain.
   *
   * The decision itself is `adoptPrompt()`; what happens here is only the
   * consequence: a move that changes machine throws away what the probe learned
   * about the one just left and asks the new one, once, in the background.
   */
  private applyPromptIdentity(runtime: Runtime, username: string, hostname: string): void {
    if (!this.options.getSettings().probe.nestedDetection) return;
    const loggedIn = runtime.loginSignalAt > 0 && nowMs() - runtime.loginSignalAt < LOGIN_SIGNAL_TTL_MS;
    const update = adoptPrompt(
      runtime.info.metadata.endpoint.chain,
      { username, hostname, at: nowMs(), ttlMs: LOGIN_SIGNAL_TTL_MS },
      { loggedIn, candidate: runtime.candidate },
    );
    if (update.move === 'none') return;
    if (update.move === 'entered' || update.move === 'cancelled') runtime.candidate = null;
    if (loggedIn) runtime.loginSignalAt = 0;
    if (update.machineChanged) {
      this.forgetHostData(runtime);
      runtime.info.metadata.endpoint.source = 'nested';
      runtime.info.metadata.extra['nested.at'] = String(nowMs());
    }
    this.recomputeEndpoint(runtime);
    // A login that just landed is the one moment a typed password can be known
    // to be the right one: this is where keeping it gets asked.
    runtime.credential.onLanded();
    this.emitMetadata(runtime);
    if (update.machineChanged) this.scheduleShellProbe(runtime);
  }

  /**
   * Collects what the current host printed about itself.
   *
   * The shell probe answers precisely, but it needs a quiet shell that can be
   * typed into. This path costs nothing at all and covers the rest: a host with
   * `Banner none`, a session that cannot be typed into, a probe that never got
   * its moment — and it is what notices a login banner at all.
   */
  private collectBanner(runtime: Runtime, chunk: string): void {
    runtime.bannerText = `${runtime.bannerText}${chunk}`.slice(-8000);
    if (runtime.promptLabel && LOGIN_SIGNATURE.test(chunk)) runtime.loginSignalAt = nowMs();
    if (!BANNER_HINT.test(chunk)) return;
    if (runtime.info.metadata.endpoint.chain.length <= 1) return;

    const facts = parseLoginBanner(runtime.bannerText);
    const known = Object.keys(facts.os).length > 0 || Object.keys(facts.extra).length > 0;
    if (!known) return;

    runtime.info.metadata.os = { ...runtime.info.metadata.os, ...facts.os, probedAt: nowMs() };
    runtime.info.metadata.extra = { ...runtime.info.metadata.extra, ...facts.extra };
    this.adoptCurrentAddress(runtime);
    if (runtime.info.metadata.extra['probe.via'] !== 'shell') {
      runtime.info.metadata.extra['probe.via'] = 'banner';
    }
    this.emitMetadata(runtime);
  }

  /**
   * Asks the shell on the current host, invisibly.
   *
   * The side channel still points at the outer machine, so the inner one can
   * only be asked by typing there. Everything about that is arranged so the user
   * never notices: one line per hop, never while a line is half-typed, never in
   * a full-screen program, echo and prompt repaint swallowed, and the line
   * removes its own history entry.
   */
  private scheduleShellProbe(runtime: Runtime, delayMs = SHELL_PROBE_DELAY_MS): void {
    const depth = runtime.info.metadata.endpoint.chain.length;
    if (runtime.closed || depth <= 1) return;
    if (runtime.shellProbeDepth >= depth) return;
    if (runtime.shellProbeTimer) {
      // A timer armed for an older hop wakes up, notices the chain moved on and
      // returns — leaving the hop the user is on without a probe for the rest of
      // the session. Re-arm it for the hop that is current now.
      if (runtime.shellProbeTimerDepth === depth) return;
      clearTimeout(runtime.shellProbeTimer);
      runtime.shellProbeTimer = null;
    }
    runtime.shellProbeTimerDepth = depth;
    runtime.shellProbeTimer = setTimeout(() => {
      runtime.shellProbeTimer = null;
      if (runtime.closed || !runtime.backend?.posixShell) return;
      void this.runShellProbe(runtime, depth);
    }, Math.max(200, delayMs));
  }

  private async runShellProbe(runtime: Runtime, depth: number, force = false): Promise<void> {
    if (runtime.closed || runtime.altScreen) return;
    if (runtime.info.metadata.endpoint.chain.length !== depth) return;
    if (!runtime.backend?.posixShell) return;
    // Another line is already in the shell, or the user has a half-typed command
    // on screen: wait for a better moment instead of typing over them. Giving up
    // here instead of retrying is what left a hop unprobed for good.
    if (runtime.injection || (!force && runtime.pendingInput.trim().length > 0)) {
      this.retryShellProbe(runtime, depth);
      return;
    }

    const result = await this.execViaShell(runtime.info.id, posixProbeScript(), 8000);
    const info = result.timedOut || !result.stdout ? {} : parseProbeOutput(result.stdout);
    if (!probeLooksValid(info)) {
      // Busy shell, no prompt to speak of, no answer in time: the banner already
      // said what it could, and there are a few more tries.
      this.retryShellProbe(runtime, depth);
      return;
    }

    runtime.shellProbeDepth = depth;
    runtime.shellProbeAttempts = 0;
    runtime.info.metadata.os = { ...info };
    this.adoptCurrentAddress(runtime);
    runtime.info.metadata.extra['probe.via'] = 'shell';
    runtime.info.probe.channel = 'shell';
    runtime.info.probe.lastAt = info.probedAt;
    runtime.info.probe.lastError = undefined;
    this.emitMetadata(runtime);
  }

  private retryShellProbe(runtime: Runtime, depth: number): void {
    if (runtime.closed || runtime.info.metadata.endpoint.chain.length !== depth) return;
    runtime.shellProbeAttempts += 1;
    if (runtime.shellProbeAttempts > SHELL_PROBE_MAX_TOTAL) return;
    // Quick retries first. Someone actively working in the shell gets asked again
    // later instead — and a shell that cannot answer at all is not typed to
    // forever, which is the one thing a probe must never do.
    const delay =
      runtime.shellProbeAttempts <= SHELL_PROBE_MAX_ATTEMPTS
        ? SHELL_PROBE_RETRY_MS * runtime.shellProbeAttempts
        : SHELL_PROBE_SLOW_RETRY_MS;
    this.scheduleShellProbe(runtime, delay);
  }

  private scheduleProbe(runtime: Runtime, delayMs: number): void {
    if (runtime.timer) clearTimeout(runtime.timer);
    const settings = this.options.getSettings();
    runtime.info.probe.enabled = settings.probe.enabled;
    runtime.info.probe.intervalMs = settings.probe.intervalMs;
    if (!settings.probe.enabled) return;
    runtime.timer = setTimeout(() => {
      void this.runProbe(runtime).finally(() => {
        if (runtime.closed) return;
        // A session that just started may still be booting (WSL especially), so
        // the first failures are retried quickly instead of waiting a full round.
        const retry = runtime.probeFailures > 0 && runtime.probeFailures < 4;
        const nextDelay = retry
          ? Math.min(15_000, 2_000 * runtime.probeFailures)
          : this.options.getSettings().probe.intervalMs;
        this.scheduleProbe(runtime, nextDelay);
      });
    }, Math.max(200, delayMs));
  }

  private async runProbe(runtime: Runtime): Promise<void> {
    if (runtime.probeBusy || runtime.closed || !runtime.info.probe.enabled) return;
    if (!runtime.backend) return;
    if (runtime.info.metadata.endpoint.chain.length > 1) {
      // The side channel still points at the outer host. Answering from it would
      // label the machine the user is on with another machine's data, so the
      // shell is asked instead — but only until it has answered once, because a
      // line typed into the user's shell is a probe, and two are noise.
      runtime.info.probe.lastError = 'the side channel points at the outer host';
      this.scheduleShellProbe(runtime, 500);
      return;
    }
    runtime.probeBusy = true;
    try {
      const attempts = this.probeAttempts(runtime);
      let info = {};
      let error: string | undefined;

      for (const shell of attempts) {
        const result = await runtime.backend.exec(
          shell === 'posix' ? posixProbeScript() : windowsProbeScript(),
          { shell, timeoutMs: 15_000 },
        );
        const parsed = parseProbeOutput(result.stdout);
        if (probeLooksValid(parsed)) {
          info = parsed;
          runtime.info.probe.channel = runtime.info.kind === 'ssh' ? 'exec-channel' : 'child';
          error = undefined;
          break;
        }
        error = result.stderr || 'probe returned no usable data';
      }

      if (probeLooksValid(info as never)) {
        const previous = runtime.info.metadata.os;
        runtime.info.metadata.os = { ...previous, ...(info as object), probeError: undefined } as SessionInfo['metadata']['os'];
        runtime.info.probe.lastAt = runtime.info.metadata.os.probedAt;
        runtime.info.probe.lastError = undefined;
        runtime.probeFailures = 0;
        this.updateEndpointFromProbe(runtime);
        this.emitMetadata(runtime);
      } else {
        runtime.info.probe.lastError = error;
        runtime.info.metadata.os.probeError = error;
        runtime.probeFailures += 1;
        this.emitMetadata(runtime);
      }
    } finally {
      runtime.probeBusy = false;
    }
  }

  /**
   * Which interpreters may run the probe for this session.
   *
   * A WSL or SSH session must never fall back to the host's PowerShell: that
   * would label a Linux box with the Windows machine's metadata.
   */
  private probeAttempts(runtime: Runtime): Array<'posix' | 'powershell'> {
    if (runtime.info.kind === 'wsl') return ['posix'];
    if (runtime.info.kind === 'ssh') return ['posix', 'powershell'];
    const knownWindows =
      runtime.info.metadata.os.os?.toLowerCase().includes('windows') === true ||
      runtime.info.metadata.os.kernel?.toLowerCase().includes('windows') === true;
    if (this.options.platform === 'win32' || knownWindows) return ['powershell', 'posix'];
    return ['posix'];
  }

  /** Forces a full repaint of the terminal, which re-draws the shell prompt. */
  private nudgeRepaint(runtime: Runtime, delayMs: number): void {
    setTimeout(() => {
      if (runtime.closed) return;
      const { cols, rows } = runtime.info;
      try {
        runtime.backend?.resize(Math.max(2, cols - 1), rows);
        setTimeout(() => {
          if (!runtime.closed) runtime.backend?.resize(cols, rows);
        }, 120);
      } catch {
        // A pty that refuses a resize has nothing to repaint.
      }
    }, delayMs);
  }

  /**
   * Names the first hop with what the probe learned.
   *
   * A local or WSL hop is only labelled by its shell, so `user@hostname` is an
   * improvement. An SSH hop is labelled by the address it dialed, and the probe
   * cannot improve that — but the name the machine calls itself is new
   * information, and it belongs next to the address, not instead of it.
   */
  private updateEndpointFromProbe(runtime: Runtime): void {
    const { os } = runtime.info.metadata;
    const { chain } = runtime.info.metadata.endpoint;
    const base = chain[0];
    if (!base || chain.length > 1) return;
    if (!os.hostname && !os.user) return;
    base.hostname ??= os.hostname;
    if (runtime.info.kind !== 'ssh') {
      const label =
        os.user && os.hostname ? `${os.user}@${os.hostname}` : os.hostname ?? os.user ?? base.label;
      if (base.label !== label) {
        base.label = label;
        base.detectedBy = 'probe';
      }
      base.username = os.user ?? base.username;
    }
    this.recomputeEndpoint(runtime);
  }

  private flushInitialCommand(runtime: Runtime): void {
    const command = runtime.initialCommandPending;
    if (!command) return;
    runtime.initialCommandPending = null;
    setTimeout(() => {
      if (runtime.closed) return;
      // Route it like a typed line: a bastion `-newtab "ssh …"` command can move
      // the session, and the detector has to see it.
      this.write(runtime.info.id, `${command}\r`);
    }, 400);
  }

  /**
   * Types the saved login commands into the shell, one line at a time.
   *
   * A login command is the user's own instruction for a machine they just
   * reached, so each line travels the path a typed line travels — `write()`,
   * the nested-login detector, the display — and only the timing is the app's
   * idea: a line waits for the previous one to stop printing, because a command
   * that is still running has not finished with the shell yet.
   *
   * Two things stop the queue: the tab going away, and a shell that is asking a
   * question (`password:`, `[y/n]`). The next line typed into one of those would
   * answer it with a command, which is the one thing an app must never do.
   */
  private flushLoginCommands(runtime: Runtime, index = 0): void {
    if (runtime.closed || index >= runtime.loginCommandsPending.length) return;
    const startedAt = nowMs();
    const send = () => {
      const queue = runtime.loginCommandsPending;
      if (runtime.closed || index >= queue.length) return;
      if (looksLikeCredentialPrompt(runtime.tailText)) {
        queue.length = 0;
        return;
      }
      const quietFor = nowMs() - runtime.lastOutputAt;
      if (quietFor < LOGIN_COMMAND_QUIET_MS && nowMs() - startedAt < LOGIN_COMMAND_QUIET_MAX_MS) {
        setTimeout(send, 100);
        return;
      }
      this.write(runtime.info.id, `${queue[index]}\r`);
      setTimeout(() => this.flushLoginCommands(runtime, index + 1), LOGIN_COMMAND_STEP_MS);
    };
    // The shell paints its prompt before anything may be typed over it.
    setTimeout(send, index === 0 ? LOGIN_COMMAND_FIRST_DELAY_MS : 0);
  }

  /**
   * True when a line may be typed into the shell without answering anything.
   *
   * Four ways for it to be false, and every one of them has been the difference
   * between a probe and a password:
   *
   *  - a full-screen program owns the screen;
   *  - the user has a half-typed line in front of the cursor;
   *  - the shell is waiting for an answer (`password:`, `(yes/no/…)`), which
   *    nothing echoes and which the app must never supply;
   *  - a submitted line has not yet returned fresh prompt output.
   *
   * The tail has to be prompt-shaped and non-empty, which is also what a stale
   * tail cannot be: `abortInjection()` clears it on purpose.
   */
  private injectionSafe(runtime: Runtime): boolean {
    if (runtime.closed) return false;
    if (runtime.altScreen) return false;
    if (runtime.pendingInput.length > 0) return false;
    if (runtime.injection) return false;
    if (runtime.awaitingLineBreak) return false;
    if (!looksLikePromptTail(runtime.tailText)) return false;
    if (looksLikeCredentialPrompt(runtime.tailText)) return false;
    return true;
  }

  private async waitForIdle(runtime: Runtime, timeoutMs: number, inputVersion: number): Promise<boolean> {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      if (runtime.closed || inputVersion !== runtime.inputVersion) return false;
      const idleFor = nowMs() - runtime.lastOutputAt;
      if (idleFor > 400 && this.injectionSafe(runtime)) return true;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return false;
  }

  /**
   * Reads the directory the shell prints about itself.
   *
   * A sequence split across two chunks is kept as a tail and looked at again
   * with the next one, because a lost OSC 7 is a panel that silently stops
   * following. Only a change is announced: `cd` inside a loop must not turn
   * into a flood of session updates.
   */
  private trackCwd(runtime: Runtime, chunk: string): void {
    const combined = `${runtime.oscScan}${chunk}`;
    const start = combined.lastIndexOf('\x1b]');
    const end = Math.max(combined.lastIndexOf('\x07'), combined.lastIndexOf('\x1b\\'));
    runtime.oscScan = start > end && combined.length - start < 2048 ? combined.slice(start) : '';

    // A nested shell's paths belong to another machine, not this file channel.
    if (runtime.info.metadata.endpoint.chain.length > 1 || runtime.candidate) return;

    let next: string | null = null;
    for (const match of combined.matchAll(OSC_CWD)) {
      const raw = match[1] ?? match[2];
      if (!raw) continue;
      const value = match[1] === undefined ? raw.trim() : decodeCwd(raw);
      if (value) next = value;
    }
    if (!next) {
      // No shell integration: a Windows prompt still names its directory.
      next = WINDOWS_PROMPT.exec(promptOnScreen(runtime.tailText))?.[1]?.trim() ?? null;
    }
    if (!next) return;
    runtime.cwdReportedVersion = runtime.inputVersion;
    if (next === runtime.cwd) return;
    runtime.cwd = next;
    this.emitUpdate(runtime);
  }
}
