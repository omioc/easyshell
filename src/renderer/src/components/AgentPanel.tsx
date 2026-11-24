import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ComponentType,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from 'react';
import { AGENT_PERMISSION_MODES } from '@shared/agent';
import type {
  AgentApprovalRequest,
  AgentMessage,
  AgentPermissionMode,
  AgentSettings,
  AgentTaskInfo,
  AgentTaskMode,
  AgentTaskOptions,
  AgentTaskStatus,
  AgentToolCallInfo,
  AgentToolCallStatus,
  SessionInfo,
} from '@shared/types';
import { getBridge } from '../bridge';
import { useT } from '../i18n';
import type { TFn } from '../i18n';
import { tabNumber } from '../lib/sessions';
import {
  IconAgent,
  IconAlert,
  IconArrowDown,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconEllipsis,
  IconEye,
  IconFile,
  IconFolder,
  IconHand,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconSend,
  IconShieldCheck,
  IconStop,
  IconTerminal,
  IconTrash,
} from './Icons';
import type { IconProps } from './Icons';
import { MarkdownText } from './MarkdownText';
import { MenuItem, Popover } from './Overlay';
import type { PopoverAnchor } from './Overlay';

/** Last path segment: a project directory's name, or an attached file's. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Short clock stamp: the task list needs "when", not a full date. */
function clockTime(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

const DOT_STATUS: Record<AgentTaskStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  running: 'running',
  waiting: 'waiting',
  error: 'error',
  closed: 'closed',
};

function StatusDot({ status }: { status: AgentTaskStatus }) {
  return <span className="agent-dot" data-status={DOT_STATUS[status]} aria-hidden="true" />;
}

/**
 * words are read: an eye only looks, a hand asks for a person, a shield approves
 * on its own within what the gate allows, and a warning is the one that asks
 * nothing.
 */
const MODE_ICONS: Record<AgentPermissionMode, ComponentType<IconProps>> = {
  'read-only': IconEye,
  ask: IconHand,
  auto: IconShieldCheck,
  unrestricted: IconAlert,
};

/** The glyph for one permission mode, for both the trigger and its menu. */
function ModeGlyph({ mode, size = 13 }: { mode: AgentPermissionMode; size?: number }) {
  const Icon = MODE_ICONS[mode];
  return <Icon size={size} />;
}

/* --------------------------------------------------------------- task list */

function TaskRow({
  task,
  onOpen,
  onRequestClose,
}: {
  task: AgentTaskInfo;
  onOpen: () => void;
  /** The trash only asks: the confirm is a popover anchored to it. */
  onRequestClose: (anchor: PopoverAnchor) => void;
}) {
  const t = useT();
  const title = task.title.trim() || t('agent.taskFallbackTitle');
  const project = task.mode === 'project';
  return (
    <li className="agent-task">
      <button type="button" className="agent-task-open" data-tip={title} onClick={onOpen}>
        {/* One line of identity, one of context: the dot says how it is going,
            the chip says what kind of session it is. */}
        <span className="agent-task-head">
          <StatusDot status={task.status} />
          <span className="agent-task-title">{title}</span>
        </span>
        <span className="agent-task-meta">
          <span
            className="agent-task-mode"
            data-project={project ? 'true' : undefined}
            data-tip={project ? task.cwd : undefined}
          >
            {project ? <IconFolder size={11} /> : null}
            {project ? baseName(task.cwd) : t('agent.taskMode.temp')}
          </span>
          <span>{t(`agent.status.${task.status}`)}</span>
          {task.commandCount > 0 ? (
            <span className="tnum">{t('agent.commandCount', { count: task.commandCount })}</span>
          ) : null}
        </span>
      </button>

      {/* The right column: when it last spoke, and how to get rid of it. The two
          share a left edge and a column, so the trash appears under the time
          instead of pushing the whole row sideways when the row is hovered. */}
      <span className="agent-task-side">
        <span className="agent-task-time tnum">{clockTime(task.updatedAt)}</span>
        <button
          type="button"
          className="agent-task-close"
          aria-label={t('agent.removeTask')}
          data-tip={t('agent.removeTask')}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onRequestClose({ x: rect.right - 236, y: rect.bottom + 6, origin: 'top right' });
          }}
        >
          <IconTrash size={13} />
        </button>
      </span>
    </li>
  );
}

/** One entry of a composer dropdown: a name, and the sentence that explains it. */
interface PickItem {
  id: string;
  title: string;
  hint?: string;
  /** Shown in front of the title: a tab number, never anything wider. */
  lead?: string;
  /** A glyph on the item's own left edge, for options that are told apart by kind. */
  icon?: ReactNode;
  active: boolean;
  disabled?: boolean;
}

/**
 * A dropdown inside the composer: a quiet pill that names the current choice,
 * and a menu where every option explains itself.
 *
 * It opens upward, because the composer sits at the bottom edge of the sheet and
 * there is only one direction with room in it. Escape is captured on the
 * document while it is open, so it closes this menu and not the whole sheet.
 */
function ComposerPick({
  className,
  label,
  menuLabel,
  icon,
  value,
  items,
  onSelect,
  disabled,
}: {
  className: string;
  label: string;
  menuLabel: string;
  icon?: ReactNode;
  value: ReactNode;
  items: PickItem[];
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="agent-pick" ref={root}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {icon ? (
          <span className="agent-pick-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="agent-pick-value">{value}</span>
        <IconChevronDown size={11} className="agent-pick-caret" />
      </button>

      {open ? (
        <div className="agent-pick-menu" role="menu" aria-label={menuLabel}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.active}
              className="agent-pick-item"
              disabled={item.disabled}
              data-active={item.active ? 'true' : undefined}
              onClick={() => {
                setOpen(false);
                onSelect(item.id);
              }}
            >
              {item.lead ? (
                <span className="agent-pick-lead tnum" aria-hidden="true">
                  {item.lead}
                </span>
              ) : null}
              {item.icon ? (
                <span className="agent-pick-item-icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="agent-pick-text">
                <span className="agent-pick-title">{item.title}</span>
                {item.hint ? <span className="agent-pick-hint">{item.hint}</span> : null}
              </span>
              {item.active ? <IconCheck size={12} className="agent-pick-check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * New session: one control, two affordances.
 *
 * It is a single button - `+` and the caret are the same object, not a split
 * control with two hit areas - because the caret was never a second action.
 * Clicking it does the everyday thing without a question: a temporary session.
 * Hovering it reveals the other choice, a project session, which has to ask for
 * a directory because that directory *is* the whole point of the mode.
 *
 * The menu hangs off the same wrapper, so the pointer can travel from the
 * button into it across a 160ms grace period instead of dropping the menu in
 * the gap.
 */
function NewTaskButton({ onCreate }: { onCreate: (options?: AgentTaskOptions) => Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  /** Opening from the keyboard has to land on the first item; hovering must not. */
  const focusOnOpen = useRef(false);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const revealMenu = () => {
    cancelClose();
    setOpen(true);
  };

  // Grace period: crossing the gap from the button into the menu must not close
  // it, and neither should the pointer resting on the button.
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Escape belongs to the menu while it is open, whichever element has focus -
  // a hover-opened menu leaves focus where it was. Captured on the document so
  // it never reaches the window handler that would close the whole sheet.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const run = async (mode: AgentTaskMode) => {
    if (creating) return;
    let cwd: string | undefined;
    if (mode === 'project') {
      const picked = await getBridge()
        .pickProjectDirectory()
        .catch(() => null);
      // Cancelled the dialog: no task, and nothing to report as an error.
      if (!picked) return;
      cwd = picked;
    }
    setCreating(true);
    setOpen(false);
    try {
      await onCreate({ mode, cwd });
    } catch {
      /* the app toasts the failure */
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="agent-new-wrap"
      data-open={open ? 'true' : undefined}
      onMouseEnter={revealMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="agent-new"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('agent.newTask')}
        data-tip={t('agent.newTask')}
        disabled={creating}
        aria-busy={creating ? 'true' : undefined}
        onClick={() => void run('temp')}
        onKeyDown={(event) => {
          // Escape is handled by the menu's own listener, once it is open.
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusOnOpen.current = true;
            revealMenu();
          }
        }}
      >
        <IconPlus size={14} />
        <IconChevronDown size={11} />
      </button>

      {open ? (
        <div
          ref={menu}
          className="agent-new-menu"
          role="menu"
          aria-label={t('agent.newTaskMenu')}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <button
            type="button"
            role="menuitem"
            className="agent-new-item"
            data-mode="temp"
            onClick={() => void run('temp')}
          >
            <span className="agent-new-item-icon" aria-hidden="true">
              <IconTerminal size={14} />
            </span>
            <span className="agent-new-item-text">
              <span className="agent-new-item-name">{t('agent.taskMode.temp')}</span>
              <span className="agent-new-item-hint">{t('agent.taskMode.tempHint')}</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="agent-new-item"
            data-mode="project"
            onClick={() => void run('project')}
          >
            <span className="agent-new-item-icon" aria-hidden="true">
              <IconFolder size={14} />
            </span>
            <span className="agent-new-item-text">
              <span className="agent-new-item-name">{t('agent.taskMode.project')}</span>
              <span className="agent-new-item-hint">{t('agent.taskMode.projectHint')}</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TaskListView({
  tasks,
  onNewTask,
  onOpenTask,
  onCloseTask,
}: {
  tasks: AgentTaskInfo[];
  onNewTask: (options?: AgentTaskOptions) => Promise<void>;
  onOpenTask: (id: string) => void;
  onCloseTask: (id: string) => void;
}) {
  const t = useT();
  /** The task whose trash was pressed, and where its confirm sits. */
  const [confirming, setConfirming] = useState<{
    task: AgentTaskInfo;
    anchor: PopoverAnchor;
  } | null>(null);

  return (
    <div className="agent-list">
      {/* Title on the left, the one action on the right: the same row shape as
          every other list in the app. */}
      <div className="agent-list-head">
        <h2 className="agent-list-title">{t('agent.listTitle')}</h2>
        <NewTaskButton onCreate={onNewTask} />
      </div>

      <div className="agent-scroll">
        {tasks.length === 0 ? (
          <div className="agent-empty">
            <p className="agent-empty-title">{t('agent.tasksEmpty')}</p>
            <p className="agent-empty-hint">{t('agent.tasksEmptyHint')}</p>
          </div>
        ) : (
          <ul className="agent-tasks">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onOpen={() => onOpenTask(task.id)}
                onRequestClose={(anchor) => setConfirming({ task, anchor })}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Closing a session ends the agent behind it and drops its record, so the
          trash asks in a small menu of its own instead of acting on the first
          click. */}
      <Popover
        open={confirming !== null}
        anchor={confirming?.anchor ?? null}
        onClose={() => setConfirming(null)}
        label={t('agent.removeTask')}
      >
        {confirming ? (
          <>
            <p className="menu-confirm">
              {t('agent.confirmCloseTask', {
                name: confirming.task.title.trim() || t('agent.taskFallbackTitle'),
              })}
            </p>
            <MenuItem
              icon={<IconTrash size={14} />}
              danger
              onSelect={() => {
                const id = confirming.task.id;
                setConfirming(null);
                onCloseTask(id);
              }}
            >
              {t('agent.removeTask')}
            </MenuItem>
            <MenuItem icon={<IconClose size={14} />} onSelect={() => setConfirming(null)}>
              {t('common.cancel')}
            </MenuItem>
          </>
        ) : null}
      </Popover>
    </div>
  );
}

/* ------------------------------------------------------------- transcript */

/**
 * One message: who said it, then what they said.
 *
 * The name sits outside the bubble, on the speaker's own edge - right for the
 * user, left for the agent - so a long transcript reads as a conversation
 * between two people rather than as a stack of coloured boxes.
 */
function MessageRow({ message, agentLabel }: { message: AgentMessage; agentLabel: string }) {
  const t = useT();

  if (message.role === 'thought') {
    return (
      <details className="agent-thought">
        <summary>{t('agent.role.thought')}</summary>
        <div className="agent-text agent-thought-text">{message.text}</div>
      </details>
    );
  }

  if (message.role === 'system') {
    return (
      <p className="agent-msg" data-role="system">
        {message.text}
      </p>
    );
  }

  const caret = message.streaming ? (
    <span className="agent-caret" aria-label={t('agent.streaming')} />
  ) : null;

  if (message.role === 'user') {
    return (
      <div className="agent-msg" data-role="user">
        <span className="agent-msg-label">{t('agent.role.you')}</span>
        <div className="agent-msg-bubble agent-text">
          {message.text}
          {caret}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-msg" data-role="agent">
      <span className="agent-msg-label">{agentLabel}</span>
      {/* The agent answers in markdown, and it answers while it types. */}
      <MarkdownText text={message.text} />
      {caret}
    </div>
  );
}

/**
 * The app writes a few reasons itself, as tokens rather than prose. They are
 * translated here; anything else is the classifier's own sentence and is shown
 * exactly as it came back - rewriting it would be inventing a verdict.
 */
const REASON_UNAVAILABLE = 'verdict-unavailable';

function shownReason(t: TFn, raw: string): string {
  return raw === REASON_UNAVAILABLE ? t('agent.reasonUnavailable') : raw;
}

/**
 * The row's status as a glyph rather than a word.
 *
 * Shape carries the state at a glance and colour names it: green for a call that
 * ran, accent for one still running, danger for one that did not. The words live
 * in the tooltip, so the row itself needs no room for them.
 */
function ToolStatusIcon({ status }: { status: AgentToolCallStatus }) {
  switch (status) {
    case 'in_progress':
      return <IconRefresh size={15} className="agent-call-spin" />;
    case 'completed':
      return <IconCheck size={15} />;
    case 'failed':
      return <IconAlert size={15} />;
    case 'blocked':
      return <IconClose size={15} />;
    default:
      return <IconEllipsis size={15} />;
  }
}

/**
 * ACP tool kinds, and the word a scope label shows for one.
 *
 * The protocol may grow kinds this build has never seen; an unknown one is
 * dropped rather than printed raw, because this label is interface text.
 */
const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch'] as const;

function toolKindLabel(t: TFn, kind: string): string {
  if (!(TOOL_KINDS as readonly string[]).includes(kind)) return '';
  return t(`agent.kind.${kind}`);
}

function ToolCallRow({ toolCall }: { toolCall: AgentToolCallInfo }) {
  const t = useT();
  const statusLabel = t(`agent.tool.${toolCall.status}`);
  const hasOutput = Boolean(toolCall.output && toolCall.output.trim());
  const hasInput = Boolean(toolCall.input && toolCall.input.trim());
  // A row the app gated is one it can speak about: a verdict, a reason, or the
  // terminal the run was routed into. Everything else is a tool the agent called
  // inside itself - a search, a file read, a command in its own shell - which
  // never reaches the gate, so there is no risk and no review to report.
  const internal = !(
    toolCall.risk !== 'unknown' ||
    Boolean(toolCall.reason) ||
    Boolean(toolCall.sessionId)
  );
  const kindLabel = internal ? toolKindLabel(t, toolCall.kind) : '';
  const hasDetails =
    hasOutput ||
    hasInput ||
    toolCall.exitCode !== undefined && toolCall.exitCode !== null ||
    Boolean(toolCall.reason);

  // A title that is the command line itself would print it twice: the command
  // block under the head already says it, in the mono face commands are read in.
  const showTitle = (toolCall.title || toolCall.kind) !== toolCall.command;

  return (
    <div className="agent-call" data-status={toolCall.status}>
      <div className="agent-call-head">
        {/* The status floats to the corner, so it is first in the source: a
            float is placed at the top of the line it appears in, and only as
            the first thing in the row does it land on the first line. */}
        <span
          className="agent-call-status"
          data-status={toolCall.status}
          data-tip={statusLabel}
          aria-label={statusLabel}
          role="img"
        >
          <ToolStatusIcon status={toolCall.status} />
        </span>
        {/* The tag is either this app's verdict on a command it is about to run,
            or - for a tool the agent calls inside itself - the plain fact of what
            the row is. A tool that never reaches the gate has no risk to report
            and nothing was reviewed, so it does not borrow the verdict's place. */}
        {internal ? (
          <span className="agent-call-tool" data-tip={t('agent.tool.internalHint')}>
            {kindLabel
              ? t('agent.tool.internalKind', { tool: t('agent.tool.internal'), kind: kindLabel })
              : t('agent.tool.internal')}
          </span>
        ) : (
          <span className="agent-risk" data-risk={toolCall.risk}>
            {t(`agent.risk.${toolCall.risk}`)}
          </span>
        )}
        {showTitle ? <span className="agent-call-title">{toolCall.title || toolCall.kind}</span> : null}
      </div>
      {toolCall.command ? <pre className="agent-cmd">{toolCall.command}</pre> : null}
      {hasDetails ? (
        <details className="agent-call-more">
          <summary>{t('agent.tool.details')}</summary>
          {/* Each thing in the fold is one field: a label bound to the block it
              names. Loose labels used to sit between blocks with nothing tying
              them to either, so "input" read as part of the line above it. */}
          <div className="agent-call-fields">
            {toolCall.reason ? (
              <p className="agent-call-reason">
                <span className="agent-call-key">{t('agent.reason')}</span>
                {shownReason(t, toolCall.reason)}
              </p>
            ) : null}
            {toolCall.exitCode !== undefined && toolCall.exitCode !== null ? (
              <p className="agent-call-exit tnum">{t('agent.tool.exitCode', { code: toolCall.exitCode })}</p>
            ) : null}
            {hasInput ? (
              <div className="agent-call-field">
                <p className="agent-call-key">{t('agent.tool.input')}</p>
                <pre className="agent-call-output">{toolCall.input}</pre>
              </div>
            ) : null}
            {hasOutput ? (
              <div className="agent-call-field">
                <p className="agent-call-key">{t('agent.tool.output')}</p>
                <pre className="agent-call-output">{toolCall.output}</pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  request,
  onRespond,
}: {
  request: AgentApprovalRequest;
  onRespond: (requestId: string, optionId: string | null) => void;
}) {
  const t = useT();
  // Denying needs no option id: one allow path, one way back out.
  const allow =
    request.options.find((option) => option.kind === 'allow_once') ??
    request.options.find((option) => option.kind === 'allow_always');
  const allowLabel = allow ? t(`agent.approval.${allow.kind}`) : t('agent.approval.allow');

  return (
    <article className="agent-approval" data-risk={request.risk}>
      <header className="agent-approval-head">
        <span className="agent-risk" data-risk={request.risk}>
          {t(`agent.risk.${request.risk}`)}
        </span>
        <h3 className="agent-approval-title">{request.title || t('agent.approval.title')}</h3>
      </header>

      {request.command ? <pre className="agent-approval-cmd">{request.command}</pre> : null}

      <dl className="agent-approval-meta">
        <div className="agent-approval-row">
          <dt>{t('agent.approval.target')}</dt>
          <dd>
            {request.sessionLabel ? (
              request.sessionLabel
            ) : (
              <span className="agent-mono">{request.sessionId ?? t('common.none')}</span>
            )}
          </dd>
        </div>
        {request.reason ? (
          <div className="agent-approval-row">
            <dt>{t('agent.reason')}</dt>
            <dd>{shownReason(t, request.reason)}</dd>
          </div>
        ) : null}
        <div className="agent-approval-row">
          <dt>{t('agent.mode')}</dt>
          <dd>{t(`agent.mode.${request.mode}`)}</dd>
        </div>
      </dl>

      <div className="agent-approval-actions">
        <button
          type="button"
          className="button agent-deny"
          onClick={() => onRespond(request.id, null)}
        >
          {t('agent.approval.deny')}
        </button>
        {allow ? (
          <button
            type="button"
            className="button agent-allow"
            onClick={() => onRespond(request.id, allow.optionId)}
          >
            {allowLabel}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- composer */

/**
 * The composer: one card that holds everything a single turn needs.
 *
 * The top left names the terminal the turn is for - by the number the strip
 * shows - and the paperclip hands over files. The bottom left is the permission
 * mode with its keyboard hint, the bottom right a single round send button,
 * because sending is the only thing this card is for.
 */
function Composer({
  closed,
  running,
  mode,
  sessions,
  sessionId,
  onSetMode,
  onFocusSession,
  onSend,
  onCancel,
}: {
  closed: boolean;
  running: boolean;
  mode: AgentPermissionMode;
  sessions: SessionInfo[];
  sessionId: string | null;
  onSetMode: (mode: AgentPermissionMode) => void;
  onFocusSession: (id: string) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);

  const target = sessions.find((session) => session.id === sessionId) ?? null;

  // The picker is a native multi-file dialog; duplicates are dropped because the
  // same file handed twice is the same file.
  const attach = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await getBridge().sftpPickFiles();
      if (picked.length === 0) return;
      setFiles((current) => [...current, ...picked.filter((path) => !current.includes(path))]);
    } catch {
      /* the dialog reports its own failures; nothing to add on top */
    } finally {
      setPicking(false);
    }
  };

  const canSend = !closed && !sending && (draft.trim().length > 0 || files.length > 0);

  const send = () => {
    if (!canSend) return;
    const text = draft.trim();
    const attached = files;
    // Attachments travel as paths: the agent runs commands in a terminal, where
    // a path is the only thing that means anything. The user's own message keeps
    // the list, so the transcript says exactly what the turn carried.
    const block =
      attached.length === 0
        ? ''
        : [t('agent.composer.attachments'), ...attached.map((path) => `- ${path}`)].join('\n');

    // The words leave the composer the moment they are handed over. `onSend`
    // resolves when the *turn* is done - the whole answer later - and a draft
    // that sits there for that long reads as a message that was never sent.
    setDraft('');
    setFiles([]);
    setSending(true);
    void onSend([text, block].filter(Boolean).join('\n\n'))
      .catch(() => {
        // Nothing was accepted, so nothing is lost: give the words back - but
        // only into an empty composer, because anything typed in the meantime
        // is worth more than what was just rejected.
        setDraft((current) => (current.length > 0 ? current : text));
        setFiles((current) => (current.length > 0 ? current : attached));
      })
      .finally(() => setSending(false));
  };

  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="agent-compose">
        <div className="agent-compose-head">
          <ComposerPick
            className="agent-pick-trigger"
            label={t('agent.session')}
            menuLabel={t('agent.session.menu')}
            icon={<IconTerminal size={12} />}
            value={
              target ? (
                <>
                  <span className="agent-pick-num tnum">#{tabNumber(sessions, target.id)}</span>
                  {target.title}
                </>
              ) : (
                t('agent.session.none')
              )
            }
            items={sessions.map((session) => ({
              id: session.id,
              lead: `#${tabNumber(sessions, session.id)}`,
              title: session.title,
              hint: t(`status.${session.status}`),
              active: session.id === sessionId,
            }))}
            onSelect={onFocusSession}
            disabled={sessions.length === 0}
          />
          <button
            type="button"
            className="agent-compose-tool"
            aria-label={t('agent.composer.attach')}
            data-tip={t('agent.composer.attach')}
            aria-busy={picking ? 'true' : undefined}
            onClick={() => void attach()}
          >
            <IconPaperclip size={14} />
          </button>
        </div>

        {files.length > 0 ? (
          <ul className="agent-files">
            {files.map((path) => {
              const name = baseName(path);
              return (
                <li key={path} className="agent-file" data-tip={path}>
                  <IconFile size={11} />
                  <span className="agent-file-name">{name}</span>
                  <button
                    type="button"
                    className="agent-file-remove"
                    aria-label={t('agent.composer.detach', { name })}
                    onClick={() => setFiles((current) => current.filter((item) => item !== path))}
                  >
                    <IconClose size={10} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <textarea
          className="agent-compose-input"
          rows={2}
          value={draft}
          placeholder={t('agent.composer.placeholder')}
          aria-label={t('agent.composer.placeholder')}
          disabled={closed}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />

        <div className="agent-compose-foot">
          <ComposerPick
            className="agent-pick-trigger agent-pick-mode"
            label={t('agent.mode')}
            menuLabel={t('agent.mode.menu')}
            icon={<ModeGlyph mode={mode} />}
            value={t(`agent.mode.${mode}`)}
            items={AGENT_PERMISSION_MODES.map((item) => ({
              id: item,
              title: t(`agent.mode.${item}`),
              hint: t(`agent.mode.${item}.hint`),
              icon: <ModeGlyph mode={item} />,
              active: mode === item,
            }))}
            onSelect={(id) => onSetMode(id as AgentPermissionMode)}
          />
          <span className="agent-compose-hint">{t('agent.composer.hint')}</span>
          {/*
           * Running, the send button becomes the stop button: same circle, same
           * place, one target. A word next to it was a second button the eye had
           * to read mid-answer.
           */}
          {running ? (
            <button
              type="button"
              className="agent-send agent-send-stop"
              aria-label={t('agent.composer.stop')}
              data-tip={t('agent.composer.stop')}
              onClick={onCancel}
            >
              <IconStop size={14} />
            </button>
          ) : (
            <button
              type="submit"
              className="agent-send"
              disabled={!canSend}
              aria-label={t('agent.composer.send')}
              data-tip={t('agent.composer.send')}
              aria-busy={sending ? 'true' : undefined}
            >
              <IconSend size={14} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

type Entry =
  | { kind: 'message'; at: number; message: AgentMessage }
  | { kind: 'tool'; at: number; toolCall: AgentToolCallInfo };

/**
 * The transcript of a task that was restored from disk is read before it can be
 * shown, and that read is not instant.
 *
 * What stands in for it is the shape of the answer - a label line and three
 * lines of prose, twice - so the sheet already has the size it is about to
 * have. An empty sheet that fills in one commit later reads as the panel having
 * broken and then repainted itself.
 */
function TranscriptSkeleton() {
  const t = useT();
  return (
    <div className="agent-skeleton" role="status">
      <span className="agent-skeleton-status">{t('agent.transcriptLoading')}</span>
      {[0, 1].map((block) => (
        <div key={block} className="agent-skeleton-block" aria-hidden="true">
          <span className="agent-skeleton-line" data-width="label" />
          <span className="agent-skeleton-line" data-width="full" />
          <span className="agent-skeleton-line" data-width="wide" />
          <span className="agent-skeleton-line" data-width="short" />
        </div>
      ))}
    </div>
  );
}

function Conversation({
  task,
  mode,
  sessions,
  focusSessionId,
  messages,
  toolCalls,
  approvals,
  loading,
  onBack,
  onSend,
  onCancel,
  onRespondApproval,
  onSetMode,
  onFocusSession,
}: {
  task: AgentTaskInfo;
  mode: AgentPermissionMode;
  /** Every open terminal, in strip order: the composer numbers them the same way. */
  sessions: SessionInfo[];
  focusSessionId: string | null;
  messages: AgentMessage[];
  toolCalls: AgentToolCallInfo[];
  approvals: AgentApprovalRequest[];
  loading: boolean;
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onRespondApproval: (requestId: string, optionId: string | null) => void;
  onSetMode: (mode: AgentPermissionMode) => void;
  onFocusSession: (id: string) => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the view follows the end of the transcript.
   *
   * A ref, because the pin runs on every commit and must read the current answer
   * without waiting for a render. `stuck` mirrors it for the one thing that has
   * to be rendered: the way back down.
   */
  const stickRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  /** Where the last pin left the position, to tell our own motion from the user's. */
  const pinnedTopRef = useRef(0);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...messages
        // A user row with no words left is the other half of a replayed prompt:
        // the block was cut out and nothing of the user's own remained.
        .filter((message) => message.role !== 'user' || message.text.trim().length > 0)
        .map((message) => ({ kind: 'message' as const, at: message.at, message })),
      ...toolCalls.map((toolCall) => ({ kind: 'tool' as const, at: toolCall.startedAt, toolCall })),
    ];
    return list.sort((a, b) => a.at - b.at);
  }, [messages, toolCalls]);


  /*
   * The skeleton has to be earned.
   *
   * A task whose transcript is already in memory and whose agent session is
   * still running opens instantly; raising the placeholder on the same frame
   * would flash it for a single commit and then take it away. 120ms is below
   * the threshold where a wait is noticed, and above the one where a frame of
   * grey reads as a glitch.
   */
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!loading) {
      setWaiting(false);
      return;
    }
    const timer = window.setTimeout(() => setWaiting(true), 120);
    return () => window.clearTimeout(timer);
  }, [loading, task.id]);

  const setStick = useCallback((next: boolean) => {
    if (stickRef.current === next) return;
    stickRef.current = next;
    setStuck(next);
  }, []);

  // A different task is a different conversation: start at its end.
  useLayoutEffect(() => {
    stickRef.current = true;
    setStuck(true);
  }, [task.id]);

  /*
   * The end of the transcript is followed, not scrolled to.
   *
   * No dependency list, on purpose. A streaming answer grows on every commit,
   * and it also grows for reasons that change no prop at all - an image
   * finishing, a table reflowing, a code block gaining its scrollbar. Pinning
   * in a layout effect corrects the position before the frame is painted, so
   * the view never shows a chunk of text first and jumps to it afterwards.
   */
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
    pinnedTopRef.current = node.scrollTop;
  });

  /** How close to the end still counts as following it. */
  const atEnd = (node: HTMLDivElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= 24;

  /*
   * Reading wins over following.
   *
   * The wheel is the earliest signal available: it arrives before the browser
   * has moved anything, so a chunk landing on the same frame holds still
   * instead of fighting the user for the position. Coming back down re-arms
   * the follow on its own, without a click.
   */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      setStick(false);
      return;
    }
    const node = scrollRef.current;
    if (node && atEnd(node)) setStick(true);
  };

  // A focused scroller scrolls from the keyboard too, and PageUp means exactly
  // what one notch of the wheel means.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
      setStick(false);
      return;
    }
    if (event.key === 'PageDown' || event.key === 'End') setStick(true);
  };

  /*
   * Dragging the scrollbar throws no wheel event, so it is recognised by what
   * it does to the position instead: content only ever pushes `scrollTop`
   * down, so a position that moved *up*, past where the last pin left it, is
   * the user and nothing else.
   */
  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    if (atEnd(node)) {
      setStick(true);
      return;
    }
    if (stickRef.current && node.scrollTop < pinnedTopRef.current - 8) setStick(false);
  };

  /** Back to the end - and back to following it, if the answer is still coming. */
  const jumpToEnd = useCallback(() => {
    setStick(true);
    const node = scrollRef.current;
    if (!node) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.scrollTop = node.scrollHeight;
    } else {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }
    pinnedTopRef.current = node.scrollHeight;
  }, [setStick]);

  /** Sending is an intent to see the answer, whatever the view was doing. */
  const send = useCallback(
    async (text: string) => {
      setStick(true);
      await onSend(text);
    },
    [onSend, setStick],
  );

  const closed = task.status === 'closed';
  const running = task.status === 'running';

  const title = task.title.trim() || t('agent.taskFallbackTitle');
  /** Who the agent calls itself, when the CLI told us; the generic name otherwise. */
  const agentLabel = task.agentName?.trim() || t('agent.role.agent');

  return (
    <div className="agent-conv">
      <header className="agent-conv-head">
        <button
          type="button"
          className="icon-button agent-back"
          aria-label={t('agent.back')}
          data-tip={t('agent.back')}
          onClick={onBack}
        >
          <IconChevronRight size={14} />
        </button>
        {/* One line: the way back, what is open, and how it is going. A project
            session keeps its directory in the name's tooltip rather than
            spending a second row on it. */}
        <span className="agent-conv-name" data-tip={task.mode === 'project' ? task.cwd : title}>
          {title}
        </span>
        <span className="agent-conv-meta">
          <StatusDot status={task.status} />
          {t(`agent.status.${task.status}`)}
        </span>
      </header>

      {/* The transcript and the way back to its end share one box: the button
          has to sit over the text, not beside it. */}
      <div className="agent-body">
        <div
          className="agent-scroll"
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
        >
          {/* While the sheet is still filling, it shows the shape of an answer
              instead of claiming there is nothing: the rows a replay is pushing
              in are held back so they land in one piece, not as a shuffle. */}
          {waiting ? (
            <TranscriptSkeleton />
          ) : (
            <>
              {!loading && entries.length === 0 ? (
                <p className="agent-note">{t('agent.transcriptEmpty')}</p>
              ) : null}
              {entries.map((entry) =>
                entry.kind === 'message' ? (
                  <MessageRow
                    key={`m:${entry.message.id}`}
                    message={entry.message}
                    agentLabel={agentLabel}
                  />
                ) : (
                  <ToolCallRow key={`t:${entry.toolCall.id}`} toolCall={entry.toolCall} />
                ),
              )}
            </>
          )}
          {task.error ? (
            <p className="agent-note" data-tone="danger">
              {t('agent.taskError', { message: task.error })}
            </p>
          ) : null}
        </div>

      </div>

      <div className="agent-foot">
        {/* Both of them talk about the end of the conversation, so they share
            one stack above the composer: the way back down, then the decision
            that outranks it. Stacked, not layered - a button peeking out from
            under a panel reads as a rendering fault, not as a priority. */}
        <div className="agent-above">
          <button
            type="button"
            className="agent-jump"
            data-visible={stuck ? 'false' : 'true'}
            tabIndex={stuck ? -1 : 0}
            aria-label={t('agent.jumpToLatest')}
            data-tip={t('agent.jumpToLatest')}
            onClick={jumpToEnd}
          >
            <IconArrowDown size={14} />
          </button>

          {/* A pending command is a decision, not a row: it floats directly
              above the composer it belongs to, where the user is already
              looking, rather than pushing the transcript up and landing in the
              middle of it. */}
          {approvals.length > 0 ? (
            <div
              className="agent-approvals"
              role="group"
              aria-label={t('agent.approval.title')}
            >
              {approvals.map((request) => (
                <ApprovalCard key={request.id} request={request} onRespond={onRespondApproval} />
              ))}
            </div>
          ) : null}
        </div>

        {/* The composer is the only control surface of the conversation: which
            terminal, which files, which mode, and one round button to send. */}
        <Composer
          key={task.id}
          closed={closed}
          running={running}
          mode={mode}
          sessions={sessions}
          sessionId={focusSessionId}
          onSetMode={onSetMode}
          onFocusSession={onFocusSession}
          onSend={send}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ setup */

/**
 * The empty state: either nothing is configured yet, or the assistant is off.
 *
 * A pointer, not a form: one icon, one sentence, one way out. Centred as a whole
 * block — a single line pinned to the top of a fixed-width column reads as a defect.
 */
function NeedSetup({
  variant = 'unconfigured',
  onOpenSettings,
}: {
  variant?: 'unconfigured' | 'disabled';
  onOpenSettings: () => void;
}) {
  const t = useT();
  const disabled = variant === 'disabled';
  return (
    <div className="agent-setup-wrap">
      <div className="agent-setup">
        <span className="agent-setup-icon" aria-hidden="true">
          <IconAgent size={26} />
        </span>
        <h3 className="agent-setup-title">
          {t(disabled ? 'agent.disabled.title' : 'agent.needSetup.title')}
        </h3>
        <p className="agent-setup-hint">
          {t(disabled ? 'agent.disabled.hint' : 'agent.needSetup.hint')}
        </p>
        <button
          type="button"
          className="button button-primary agent-setup-save"
          onClick={onOpenSettings}
        >
          {t('agent.needSetup.open')}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export interface AgentPanelProps {
  settings: AgentSettings;
  tasks: AgentTaskInfo[];
  activeTaskId: string | null;
  /** Every open terminal, in strip order, and the one the agent works in. */
  sessions: SessionInfo[];
  focusSessionId: string | null;
  onFocusSession: (id: string) => void;
  /** Messages of the open task, already replaced by id while streaming. */
  messages: AgentMessage[];
  toolCalls: AgentToolCallInfo[];
  /** Pending approvals for the open task. */
  approvals: AgentApprovalRequest[];
  loadingTranscript: boolean;
  /** `options.mode` picks temp (default) or project; the panel chooses the directory. */
  onNewTask: (options?: AgentTaskOptions) => Promise<void>;
  onOpenTask: (id: string) => void;
  onBack: () => void;
  onCloseTask: (id: string) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onRespondApproval: (requestId: string, optionId: string | null) => void;
  onSetMode: (mode: AgentPermissionMode) => void;
  /** Sends the user to Settings > AI assistant to configure the agent CLI. */
  onOpenSettings: () => void;
}

/**
 * The "tasks" tab body.
 *
 * Three states share this column: the not-configured pointer (no agent CLI yet),
 * the session list, and one open conversation — where the permission mode is
 * chosen, because that is a decision made while working rather than a form field.
 */
export function AgentPanel({
  settings,
  tasks,
  sessions,
  focusSessionId,
  onFocusSession,
  activeTaskId,
  messages,
  toolCalls,
  approvals,
  loadingTranscript,
  onNewTask,
  onOpenTask,
  onBack,
  onCloseTask,
  onSend,
  onCancel,
  onRespondApproval,
  onSetMode,
  onOpenSettings,
}: AgentPanelProps) {
  const task = activeTaskId ? tasks.find((item) => item.id === activeTaskId) ?? null : null;

  // Off beats unconfigured: the switch is the first thing the user turned.
  if (!settings.enabled) {
    return <NeedSetup variant="disabled" onOpenSettings={onOpenSettings} />;
  }

  if (!settings.command.trim()) return <NeedSetup onOpenSettings={onOpenSettings} />;

  if (!task) {
    return (
      <TaskListView
        tasks={tasks}
        onNewTask={onNewTask}
        onOpenTask={onOpenTask}
        onCloseTask={onCloseTask}
      />
    );
  }

  return (
    <Conversation
      task={task}
      mode={settings.permissionMode}
      sessions={sessions}
      focusSessionId={focusSessionId}
      onFocusSession={onFocusSession}
      messages={messages}
      toolCalls={toolCalls}
      approvals={approvals}
      loading={loadingTranscript}
      onBack={onBack}
      onSend={onSend}
      onCancel={onCancel}
      onSetMode={onSetMode}
      onRespondApproval={onRespondApproval}
    />
  );
}
