/**
 * Command risk classifier.
 *
 * The app does not carry a rule list of dangerous commands and never decides a
 * verdict itself. It opens a *second* ACP session — same agent CLI, separate
 * conversation, an instruction that talks about nothing but commands — and asks
 * it to classify one command line. That session has no terminal and no file
 * access, so it can only answer.
 *
 * Any doubt resolves to `destructive`: a classifier that is down, slow or
 * chatty can only make the gate stricter.
 */
import { mkdirSync } from 'node:fs';
import { CONSERVATIVE_VERDICT, buildClassifierPrompt, parseRiskVerdict } from '../../shared/agent';
import type { AgentRiskVerdict, Locale, Settings } from '../../shared/types';
import { AcpConnection, denyAllHost } from './acp';
import type { AcpSessionUpdate } from './acp';

const CACHE_LIMIT = 256;

export interface CommandClassifierOptions {
  getSettings(): Settings;
  /**
   * The language the reason comes back in. The verdict is quoted in the approval
   * card, so it is interface text and follows the UI, not the command.
   */
  getLocale?(): Locale;
  /**
   * Where the classifier process runs. A classification has no project context,
   * so this is the app's scratch directory rather than a task's working dir.
   */
  workDir: string;
  /** Called once per degrade, so the UI can say the gate is running blind. */
  onDegrade(reason: string): void;
}

export class CommandClassifier {
  private connection: AcpConnection | null = null;
  private sessionId = '';
  private answer = '';
  private starting: Promise<void> | null = null;
  private readonly cache = new Map<string, AgentRiskVerdict>();
  /** One prompt at a time: a second turn on the same session would interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private degradedNoticeShown = false;

  constructor(private readonly options: CommandClassifierOptions) {}

  /**
   * @param command the exact command line about to run
   * @param target where it would run, e.g. `root@198.18.0.7 via ssh`
   */
  async classify(command: string, target: string): Promise<AgentRiskVerdict> {
    const key = command.trim();
    if (!key) return CONSERVATIVE_VERDICT;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const run = async (): Promise<AgentRiskVerdict> => {
      const settings = this.options.getSettings();
      try {
        await this.ensure();
        this.answer = '';
        const timeoutMs = settings.agent.classifyTimeoutMs;
        const stopReason = await this.withTimeout(
          this.connection!.prompt(
            this.sessionId,
            buildClassifierPrompt(command, target, this.options.getLocale?.() ?? 'en'),
          ),
          timeoutMs,
        );
        if (stopReason === 'cancelled') return this.degrade('classifier-cancelled');
        const verdict = parseRiskVerdict(this.answer);
        if (verdict.degraded) return this.degrade('classifier-unreadable');
        this.remember(key, verdict);
        return verdict;
      } catch (error) {
        this.reset();
        return this.degrade(error instanceof Error ? error.message : String(error));
      }
    };

    // Serialise: the classifier session handles one command at a time.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.reset();
    this.cache.clear();
  }

  private remember(key: string, verdict: AgentRiskVerdict): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, verdict);
  }

  private degrade(reason: string): AgentRiskVerdict {
    if (!this.degradedNoticeShown) {
      this.degradedNoticeShown = true;
      this.options.onDegrade(reason);
    }
    return CONSERVATIVE_VERDICT;
  }

  private reset(): void {
    this.connection?.dispose();
    this.connection = null;
    this.sessionId = '';
    this.starting = null;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`classification timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async ensure(): Promise<void> {
    if (this.connection && this.sessionId) return;
    if (this.starting) return this.starting;
    const settings = this.options.getSettings();
    const agent = settings.agent;
    if (!agent.enabled || !agent.command) {
      throw new Error('no agent command configured');
    }
    const cwd = this.options.workDir;
    // A missing directory makes spawn fail, and the classifier is the gate's
    // only source of verdicts: create it rather than degrade on first use.
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      /* if this fails, spawn reports why a moment later */
    }
    const connection = new AcpConnection({
      command: agent.command,
      args: agent.args,
      cwd,
      env: agent.env,
      host: denyAllHost((_sessionId, update) => this.absorb(update)),
    });
    this.starting = (async () => {
      await connection.start();
      this.sessionId = await connection.newSession(cwd);
      this.connection = connection;
    })().catch((error: unknown) => {
      this.starting = null;
      connection.dispose();
      throw error;
    });
    await this.starting;
  }

  /** Only the plain text of an answer matters; everything else is ignored. */
  private absorb(update: AcpSessionUpdate): void {
    if (update.sessionUpdate !== 'agent_message_chunk') return;
    const content = update.content as { type?: string; text?: unknown } | undefined;
    if (content && content.type === 'text' && typeof content.text === 'string') {
      this.answer += content.text;
    }
  }
}
