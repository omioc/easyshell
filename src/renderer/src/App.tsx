import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SCHEME_ID, resolveScheme } from '@shared/themes';
import {
  buildSshSpecFromProfile,
  removeSshProfile,
  sshProfileTitle,
  upsertSshProfile,
} from '@shared/profiles';
import {
  appendProfilesToWorkspace,
  createWorkspace,
  detachProfileFromWorkspaces,
  nextWorkspaceName,
  removeWorkspace,
  updateWorkspace,
} from '@shared/workspaces';
import type {
  AgentApprovalRequest,
  AgentEvent,
  AgentMessage,
  AgentPermissionMode,
  AgentTaskInfo,
  AgentTaskOptions,
  AgentToolCallInfo,
  BootstrapPayload,
  ConnectionTestResult,
  CredentialRequest,
  DeepPartial,
  Locale,
  SessionEvent,
  SessionInfo,
  SessionSpec,
  Settings,
  SshProfile,
} from '@shared/types';
import { getBridge, isMockBridge } from './bridge';
import { LocaleProvider, tWith } from './i18n';
import type { TFn } from './i18n';
import { copyText } from './lib/clipboard';
import { errorMessage } from './lib/format';
import { mergeSettings } from './lib/settings';
import { activeScheme, applyScheme } from './lib/theme';
import { AgentPanel } from './components/AgentPanel';
import { ConnectionEditor } from './components/ConnectionManager';
import { CredentialPromptBar } from './components/CredentialPromptBar';
import {
  IconArrowRight,
  IconClose,
  IconFolder,
  IconInfo,
  IconPencil,
  IconPlus,
  IconTrash,
  IconPanelLeft,
} from './components/Icons';
import { MenuFlyout, MenuItem, MenuSection, MenuSeparator, Popover } from './components/Overlay';
import type { PopoverAnchor } from './components/Overlay';
import { NewMenu } from './components/NewMenu';
import { PasteConfirm } from './components/PasteConfirm';
import { SessionInfoPanel } from './components/SessionInfoPanel';
import { SettingsPage } from './components/SettingsPage';
import { SftpPanel } from './components/SftpPanel';
import { SidePanel, SidePanelTabs } from './components/SidePanel';
import type { SidePanelTab } from './components/SidePanel';
import { Sidebar } from './components/Sidebar';
import type { SidebarMenuTarget } from './components/Sidebar';
import { TabStrip } from './components/TabStrip';
import { TerminalPane } from './components/TerminalPane';
import type { TerminalHandle } from './components/TerminalPane';
import { TitleBar } from './components/TitleBar';
import { Toasts } from './components/Toasts';
import type { ToastItem, ToastLevel } from './components/Toasts';
import { TooltipLayer } from './components/Tooltip';
import { Welcome } from './components/Welcome';

/** Paint the default scheme before React mounts so there is no white flash. */
applyScheme(resolveScheme(DEFAULT_SCHEME_ID, window.matchMedia('(prefers-color-scheme: dark)').matches));

/**
 * The sidebar opens menus for workspaces and saved hosts; the tab strip opens
 * the session menu. They share one popover, so they share one target type.
 */
type RowMenuTarget = SidebarMenuTarget | { kind: 'session'; sessionId: string };

interface RowMenuState {
  target: RowMenuTarget;
  anchor: PopoverAnchor;
}

interface ConnectionRequest {
  /** `create` starts a blank form, `edit` opens the host with `profileId`. */
  mode: 'create' | 'edit';
  profileId?: string;
  /** When set, the connection saved here also joins this workspace. */
  workspaceId?: string;
}

/**
 * Merges a fetched transcript into what already streamed in: the live copy of
 * a message id wins, so a slow snapshot can never roll back text on screen.
 */
function mergeById<T extends { id: string }>(snapshot: T[], live: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of snapshot) merged.set(item.id, item);
  for (const item of live) merged.set(item.id, item);
  return [...merged.values()];
}

/**
 * How long the conversation may keep saying "loading" while a restored task's
 * agent session is reopened.
 *
 * `session/load` replays the whole conversation back through the event stream,
 * so this covers that wait - and caps it, because an agent that never answers
 * must not pin a skeleton to the sheet for the two minutes its own timeout
 * allows.
 */
const TRANSCRIPT_HOLD_MS = 15_000;

export function App() {
  const [boot, setBoot] = useState<BootstrapPayload | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * Which right-hand sheet is open, if any. It is docked from the start on the
   * first tab - what the terminal you are looking at actually is - because an
   * empty panel that has to be found before it can be used is a panel nobody
   * uses. `null` still means "closed": the toggle and Escape put it there.
   */
  const [sidePanel, setSidePanel] = useState<SidePanelTab | null>('terminal');
  /** The tab the sheet reopens on: the last one the user was looking at. */
  const lastPanelTab = useRef<SidePanelTab>('terminal');

  useEffect(() => {
    if (sidePanel) lastPanelTab.current = sidePanel;
  }, [sidePanel]);
  /** Agent mirror: tasks, their transcripts and every pending approval. */
  const [tasks, setTasks] = useState<AgentTaskInfo[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [messagesByTask, setMessagesByTask] = useState<Record<string, AgentMessage[]>>({});
  const [toolCallsByTask, setToolCallsByTask] = useState<Record<string, AgentToolCallInfo[]>>({});
  const [approvals, setApprovals] = useState<AgentApprovalRequest[]>([]);
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);
  /**
   * The terminal the agent treats as its target. It follows the front tab until
   * the composer picks one by hand, and a pinned tab that closes simply falls
   * back to the front tab instead of pointing at a session that is gone.
   */
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  /** Which page a saved-host row menu is on: the item list or a delete confirm. */
  const [menuStep, setMenuStep] = useState<'main' | 'delete'>('main');
  /** Screen point of the "move to workspace" item, when its submenu is open. */
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null);
  const [newMenu, setNewMenu] = useState<PopoverAnchor | null>(null);
  const [connections, setConnections] = useState<ConnectionRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  /** A multi-line paste waiting for the user to look at it before it is sent. */
  const [pasteRequest, setPasteRequest] = useState<{ sessionId: string; text: string } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** Per terminal: the credential question on screen, if any. */
  const [credentialRequests, setCredentialRequests] = useState<Record<string, CredentialRequest>>({});
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  /*
   * macOS hides the title bar and draws its traffic lights in the top-left
   * corner, so the shell keeps a band free for them. Fullscreen has no traffic
   * lights and no reason to waste the height: the band collapses there. Nothing
   * pushes this state, and a resize is the only signal a fullscreen toggle
   * gives, so the host is asked on resize rather than through an event channel.
   */
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => {
      void getBridge()
        .getWindowState()
        .then((state) => setFullscreen(state.fullscreen))
        .catch(() => undefined);
    };
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  /*
   * Settings and the connection editor are both pages in the main area, so only
   * one of them can be on screen: opening either retires the other.
   */
  const openSettingsPage = useCallback(() => {
    setConnections(null);
    setSettingsOpen(true);
  }, []);

  const openConnectionEditor = useCallback((request: ConnectionRequest) => {
    setSettingsOpen(false);
    setConnections(request);
  }, []);

  /* ------------------------------------------------------------ references */

  const terminals = useRef(new Map<string, TerminalHandle>());
  const sessionsRef = useRef<SessionInfo[]>(sessions);
  sessionsRef.current = sessions;
  const settingsRef = useRef<Settings | null>(settings);
  settingsRef.current = settings;
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  const connectionsRef = useRef<ConnectionRequest | null>(connections);
  connectionsRef.current = connections;
  const settingsSeq = useRef(0);
  const toastSeq = useRef(0);
  const openTaskIdRef = useRef<string | null>(openTaskId);
  openTaskIdRef.current = openTaskId;
  /** Transcripts are fetched once per task per run; later turns arrive as events. */
  const loadedTranscripts = useRef(new Set<string>());

  const locale: Locale = useMemo(() => {
    const requested = settings?.locale ?? 'auto';
    if (requested !== 'auto') return requested;
    return boot?.platform.locale ?? 'en';
  }, [settings?.locale, boot?.platform.locale]);

  const tRef = useRef<TFn>(tWith(locale));
  tRef.current = tWith(locale);

  const scheme = useMemo(
    () => (settings ? activeScheme(settings, systemDark) : resolveScheme(DEFAULT_SCHEME_ID, systemDark)),
    [settings, systemDark],
  );

  useEffect(() => {
    applyScheme(scheme);
  }, [scheme]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  /* ---------------------------------------------------------------- toasts */

  const pushToast = useCallback((text: string, level: ToastLevel = 'info') => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((prev) => [...prev, { id, level, text }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /* --------------------------------------------------------------- session */

  const upsertSession = useCallback((session: SessionInfo) => {
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === session.id);
      if (index === -1) return [...prev, session];
      const next = prev.slice();
      next[index] = session;
      return next;
    });
  }, []);

  const removeSession = useCallback((id: string) => {
    const next = sessionsRef.current.filter((session) => session.id !== id);
    sessionsRef.current = next;
    setSessions(next);
    setActiveId((current) => (current === id ? next[next.length - 1]?.id ?? null : current));
    setRenamingId((current) => (current === id ? null : current));
  }, []);

  const registerTerminal = useCallback((id: string, handle: TerminalHandle | null) => {
    if (handle) terminals.current.set(id, handle);
    else terminals.current.delete(id);
  }, []);

  /**
   * The clipboard, reached from the terminal itself: a right-click copy reports
   * nothing when it worked (the selection clearing is the receipt), and a paste
   * of more than one line comes here to be looked at first.
   */
  const requestPaste = useCallback((sessionId: string, text: string) => {
    setPasteRequest({ sessionId, text });
  }, []);

  const cancelPaste = useCallback(() => setPasteRequest(null), []);

  const confirmPaste = useCallback(() => {
    const request = pasteRequest;
    setPasteRequest(null);
    if (!request) return;
    terminals.current.get(request.sessionId)?.paste(request.text);
  }, [pasteRequest]);

  const reportCopyFailed = useCallback(
    () => pushToast(tRef.current('common.copyFailed'), 'error'),
    [pushToast],
  );

  /** The popover's answer, and the bar goes away as soon as it is given. */
  const respondCredential = useCallback(
    (sessionId: string, decision: 'accept' | 'dismiss') => {
      setCredentialRequests((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      void getBridge().respondCredential(sessionId, decision);
    },
    [],
  );

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case 'session-created':
          upsertSession(event.session);
          setActiveId(event.session.id);
          break;
        case 'session-updated':
          // Update-only: a late snapshot must not bring back a tab the user
          // already closed. Only `session-created` may add a session.
          setSessions((prev) =>
            prev.map((session) => (session.id === event.session.id ? event.session : session)),
          );
          break;
        case 'session-title':
          setSessions((prev) =>
            prev.map((session) =>
              session.id === event.id ? { ...session, title: event.title } : session,
            ),
          );
          break;
        case 'session-metadata':
          setSessions((prev) =>
            prev.map((session) =>
              session.id === event.id
                ? { ...session, metadata: event.metadata, lastActivityAt: Date.now() }
                : session,
            ),
          );
          break;
        case 'session-output':
          terminals.current.get(event.id)?.write(event.data);
          break;
        case 'session-focus':
          // The agent runs inside the user's own terminals, so what it does has
          // to be the thing on screen while it happens. Only a tab that still
          // exists may be brought forward: a focus that arrives for a session
          // the user already closed must not resurrect it.
          if (sessionsRef.current.some((session) => session.id === event.id)) {
            setActiveId(event.id);
          }
          break;
        case 'session-credential': {
          // What the terminal should ask, straight from main: the popover is a
          // view of one decision, never a second source of truth about it.
          setCredentialRequests((current) => {
            const next = { ...current };
            if (event.request) next[event.id] = event.request;
            else delete next[event.id];
            return next;
          });
          break;
        }
        case 'session-closed': {
          removeSession(event.id);
          if (event.code !== null && event.code !== 0) {
            pushToast(tRef.current('notice.sessionClosed', { code: event.code }), 'warn');
          }
          break;
        }
        case 'settings-updated':
          setSettings(event.settings);
          break;
        case 'notice':
          pushToast(
            tRef.current(event.notice.key, event.notice.params),
            event.notice.level === 'warn' ? 'warn' : event.notice.level,
          );
          break;
        default:
          break;
      }
    },
    [pushToast, removeSession, upsertSession],
  );

  useEffect(() => {
    const off = getBridge().onEvent(handleEvent);
    return off;
  }, [handleEvent]);

  useEffect(() => {
    let alive = true;
    void getBridge()
      .bootstrap()
      .then((payload) => {
        if (!alive) return;
        setBoot(payload);
        setSettings(payload.settings);
        setSessions(payload.sessions);
        setActiveId(payload.sessions[0]?.id ?? null);
        setTasks(payload.agentTasks ?? []);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        pushToast(tRef.current('error.unknown', { message: errorMessage(error) }), 'error');
      });
    return () => {
      alive = false;
    };
  }, [pushToast]);

  /* -------------------------------------------------------------- settings */

  const patchSettings = useCallback(
    async (patch: DeepPartial<Settings>) => {
      setSettings((prev) => (prev ? mergeSettings(prev, patch) : prev));
      settingsSeq.current += 1;
      const seq = settingsSeq.current;
      try {
        const next = await getBridge().updateSettings(patch);
        if (seq === settingsSeq.current) setSettings(next);
      } catch (error) {
        pushToast(tRef.current('error.unknown', { message: errorMessage(error) }), 'error');
      }
    },
    [pushToast],
  );

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await getBridge().getSettings());
    } catch {
      /* the next settings event will resync */
    }
  }, []);

  /* ----------------------------------------------------------------- agent */

  const upsertTask = useCallback((task: AgentTaskInfo) => {
    setTasks((prev) => {
      const index = prev.findIndex((item) => item.id === task.id);
      if (index === -1) return [...prev, task];
      const next = prev.slice();
      next[index] = task;
      return next;
    });
  }, []);

  /** Same replace-by-id rule for messages and tool calls: streaming grows one id. */
  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'agent-task':
          upsertTask(event.task);
          break;
        case 'agent-task-removed':
          setTasks((prev) => prev.filter((task) => task.id !== event.taskId));
          setOpenTaskId((current) => (current === event.taskId ? null : current));
          setApprovals((prev) => prev.filter((item) => item.taskId !== event.taskId));
          break;
        case 'agent-message': {
          const { message } = event;
          setMessagesByTask((prev) => {
            const list = prev[message.taskId] ?? [];
            const index = list.findIndex((item) => item.id === message.id);
            const next =
              index === -1
                ? [...list, message]
                : list.map((item, position) => (position === index ? message : item));
            return { ...prev, [message.taskId]: next };
          });
          break;
        }
        case 'agent-tool-call': {
          const { toolCall } = event;
          setToolCallsByTask((prev) => {
            const list = prev[toolCall.taskId] ?? [];
            const index = list.findIndex((item) => item.id === toolCall.id);
            const next =
              index === -1
                ? [...list, toolCall]
                : list.map((item, position) => (position === index ? toolCall : item));
            return { ...prev, [toolCall.taskId]: next };
          });
          break;
        }
        case 'agent-approval': {
          const { request } = event;
          setApprovals((prev) => [...prev.filter((item) => item.id !== request.id), request]);
          break;
        }
        case 'agent-approval-resolved':
          setApprovals((prev) => prev.filter((item) => item.id !== event.requestId));
          break;
        case 'agent-notice':
          pushToast(
            tRef.current(event.notice.key, event.notice.params),
            event.notice.level === 'warn' ? 'warn' : event.notice.level,
          );
          break;
        default:
          break;
      }
    },
    [pushToast, upsertTask],
  );

  useEffect(() => {
    const off = getBridge().onAgentEvent(handleAgentEvent);
    return off;
  }, [handleAgentEvent]);

  // A pinned terminal that is closed releases the pin: the target goes back to
  // whatever tab is in front, which is the only tab the user is looking at.
  const agentSessionId =
    pinnedSessionId && sessions.some((session) => session.id === pinnedSessionId)
      ? pinnedSessionId
      : activeId;

  // The gate routes agent commands into the target terminal, so it has to know
  // which one that is. A failure here is not worth a toast.
  useEffect(() => {
    void getBridge()
      .setAgentFocus(agentSessionId)
      .catch(() => undefined);
  }, [agentSessionId]);

  /*
   * Opening a task loads its transcript once; everything after arrives live.
   *
   * A layout effect, because the flag it raises is what puts the skeleton on
   * screen: from a passive effect that flag lands after the first paint, and the
   * conversation shows an empty sheet for a frame before admitting it is busy.
   *
   * The flag stays up until both halves are done. The stored transcript is the
   * fast one; for a task restored from disk the slow one is `session/load`,
   * which replays the whole conversation back through the event stream. Releasing
   * the flag after the first half is what made the sheet read "no messages yet"
   * and then fill in all at once.
   */
  useLayoutEffect(() => {
    if (!openTaskId || loadedTranscripts.current.has(openTaskId)) return;
    const id = openTaskId;
    let alive = true;
    setTranscriptLoadingId(id);

    const stored = getBridge()
      .getAgentTranscript(id)
      .then((transcript) => {
        if (!alive) return;
        // Marked read only once it has actually arrived: a fetch that was
        // cancelled mid-flight (a re-open, a dev remount) is not a transcript.
        loadedTranscripts.current.add(id);
        setMessagesByTask((prev) => ({
          ...prev,
          [id]: mergeById(transcript.messages, prev[id] ?? []),
        }));
        setToolCallsByTask((prev) => ({
          ...prev,
          [id]: mergeById(transcript.toolCalls, prev[id] ?? []),
        }));
      })
      .catch((error: unknown) => {
        if (!alive) return;
        pushToast(tRef.current('error.unknown', { message: errorMessage(error) }), 'error');
      });

    // The session comes back here, and the replay streams in while it runs. A
    // no-op for a task that never had one, and for a task still running.
    const replay = getBridge()
      .resumeAgentTask(id)
      .catch(() => undefined);

    const release = () => {
      if (alive) setTranscriptLoadingId((current) => (current === id ? null : current));
    };
    const hold = window.setTimeout(release, TRANSCRIPT_HOLD_MS);

    void Promise.allSettled([stored, replay]).then(() => {
      window.clearTimeout(hold);
      release();
    });

    return () => {
      alive = false;
      window.clearTimeout(hold);
    };
  }, [openTaskId, pushToast]);

  const createAgentTask = useCallback(async (options?: AgentTaskOptions) => {
    try {
      const task = await getBridge().createAgentTask(undefined, options);
      upsertTask(task);
      setOpenTaskId(task.id);
      setSidePanel('tasks');
    } catch (error) {
      pushToast(tRef.current('agent.actionFailed', { message: errorMessage(error) }), 'error');
      throw error;
    }
  }, [pushToast, upsertTask]);

  const closeAgentTask = useCallback(
    (id: string) => {
      setTasks((prev) => prev.filter((task) => task.id !== id));
      setOpenTaskId((current) => (current === id ? null : current));
      setApprovals((prev) => prev.filter((item) => item.taskId !== id));
      void getBridge()
        .closeAgentTask(id)
        .catch((error: unknown) =>
          pushToast(tRef.current('agent.actionFailed', { message: errorMessage(error) }), 'error'),
        );
    },
    [pushToast],
  );

  const promptAgent = useCallback(
    async (text: string) => {
      const id = openTaskIdRef.current;
      if (!id) return;
      try {
        await getBridge().promptAgent(id, text);
      } catch (error) {
        pushToast(tRef.current('agent.actionFailed', { message: errorMessage(error) }), 'error');
        throw error;
      }
    },
    [pushToast],
  );

  const cancelAgent = useCallback(() => {
    const id = openTaskIdRef.current;
    if (!id) return;
    void getBridge()
      .cancelAgent(id)
      .catch((error: unknown) =>
        pushToast(tRef.current('agent.actionFailed', { message: errorMessage(error) }), 'error'),
      );
  }, [pushToast]);

  const respondApproval = useCallback(
    (requestId: string, optionId: string | null) => {
      // Resolve locally first: the card must leave the screen the moment the
      // user answers, whatever the event channel does afterwards.
      setApprovals((prev) => prev.filter((item) => item.id !== requestId));
      void getBridge()
        .respondAgentApproval(requestId, optionId)
        .catch((error: unknown) =>
          pushToast(tRef.current('agent.actionFailed', { message: errorMessage(error) }), 'error'),
        );
    },
    [pushToast],
  );

  const setAgentMode = useCallback(
    (mode: AgentPermissionMode) => {
      void patchSettings({ agent: { permissionMode: mode } });
    },
    [patchSettings],
  );

  /**
   * One toggle for the sheet: an open sheet closes, a closed one comes back on
   * the tab it was left on. Reopening on a fixed tab would throw away the
   * choice the user just made.
   */
  const togglePanel = useCallback(() => {
    setSidePanel((current) => (current ? null : lastPanelTab.current));
  }, []);

  const sidebarCollapsed = settings?.layout.sidebarCollapsed ?? false;
  const toggleSidebar = useCallback(() => {
    const current = settingsRef.current;
    if (!current) return;
    void patchSettings({ layout: { sidebarCollapsed: !current.layout.sidebarCollapsed } });
  }, [patchSettings]);

  /* ---------------------------------------------------------- session acts */

  const createSession = useCallback(
    async (spec: SessionSpec) => {
      try {
        const session = await getBridge().createSession(spec);
        upsertSession(session);
        setActiveId(session.id);
        // Opening a terminal leaves whichever page was covering it: settings and
        // the connection editor are views, not modals.
        setSettingsOpen(false);
        setConnections(null);
        return true;
      } catch (error) {
        pushToast(tRef.current('error.connect', { message: errorMessage(error) }), 'error');
        return false;
      }
    },
    [pushToast, upsertSession],
  );

  const closeSession = useCallback(
    async (id: string) => {
      try {
        await getBridge().closeSession(id);
      } catch (error) {
        pushToast(tRef.current('error.unknown', { message: errorMessage(error) }), 'error');
      }
      removeSession(id);
    },
    [pushToast, removeSession],
  );

  const closeOtherSessions = useCallback(
    async (id: string) => {
      for (const other of sessionsRef.current.filter((session) => session.id !== id)) {
        try {
          await getBridge().closeSession(other.id);
        } catch {
          /* ignore: the row is removed locally below */
        }
        removeSession(other.id);
      }
    },
    [removeSession],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      setRenamingId(null);
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        await getBridge().renameSession(id, trimmed);
      } catch (error) {
        pushToast(tRef.current('error.unknown', { message: errorMessage(error) }), 'error');
      }
    },
    [pushToast],
  );

  const refreshMetadata = useCallback(
    async (id: string) => {
      try {
        await getBridge().probeSession(id);
        pushToast(tRef.current('notice.probeRefreshed'), 'info');
      } catch (error) {
        pushToast(tRef.current('error.unknown', { message: errorMessage(error) }), 'error');
      }
    },
    [pushToast],
  );

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      pushToast(tRef.current(ok ? 'common.copied' : 'common.copyFailed'), ok ? 'success' : 'error');
    },
    [pushToast],
  );

  const openLocal = useCallback(
    (profileId?: string) => {
      const current = settingsRef.current;
      if (!current) return;
      const profile =
        (profileId ? current.shell.profiles.find((item) => item.id === profileId) : undefined) ??
        current.shell.profiles.find((item) => item.id === current.shell.defaultProfileId) ??
        current.shell.profiles[0];
      if (!profile) return;
      void createSession({
        kind: 'local',
        profileId: profile.id,
        command: profile.command,
        args: profile.args,
      });
    },
    [createSession],
  );

  const openWsl = useCallback(
    (distribution: string) => {
      void createSession({ kind: 'wsl', distribution });
    },
    [createSession],
  );

  /**
   * Opens a saved host in a new tab. Entry rows never reuse a running session:
   * the list is a set of launchers, and the tab strip owns what is running.
   */
  const openProfile = useCallback(
    (profile: SshProfile) => {
      const current = settingsRef.current;
      if (!current) return;
      const spec = buildSshSpecFromProfile(profile, { hostKeyPolicy: current.ssh.hostKeyPolicy });
      if (!spec) {
        // An incomplete profile is fixed in the editor instead of failing silently.
        openConnectionEditor({ mode: 'edit', profileId: profile.id });
        return;
      }
      void createSession(spec);
      void patchSettings({
        ssh: {
          ...current.ssh,
          profiles: upsertSshProfile(current.ssh.profiles, { ...profile, lastUsedAt: Date.now() }),
        },
      });
    },
    [createSession, openConnectionEditor, patchSettings],
  );

  /**
   * The editor's test button: build the request a tab would get, ask main to open
   * the connection and hang up, and turn the answer into a toast. The spec comes
   * from the draft, so nothing has to be saved before a host can be tried.
   */
  const testConnection = useCallback(
    async (profile: SshProfile): Promise<ConnectionTestResult> => {
      const current = settingsRef.current;
      const spec = current
        ? buildSshSpecFromProfile(profile, { hostKeyPolicy: current.ssh.hostKeyPolicy })
        : null;
      if (spec?.kind !== 'ssh') {
        const message = tRef.current('notice.connectionTestFailed');
        pushToast(message, 'error');
        return { ok: false, error: message };
      }
      try {
        const result = await getBridge().testConnection(spec);
        pushToast(
          result.ok
            ? tRef.current('notice.connectionTestOk')
            : result.error || tRef.current('notice.connectionTestFailed'),
          result.ok ? 'success' : 'error',
        );
        return result;
      } catch (error) {
        const message = errorMessage(error);
        pushToast(message, 'error');
        return { ok: false, error: message };
      }
    },
    [pushToast],
  );

  /* ------------------------------------------------------------ workspaces */

  const workspaces = settings?.workspaces ?? [];
  const profiles = settings?.ssh.profiles ?? [];

  const createWorkspaceGroup = useCallback(() => {
    const current = settingsRef.current;
    if (!current) return;
    const name = nextWorkspaceName(current.workspaces, tRef.current('workspace.newName'));
    const workspace = createWorkspace({ name });
    setRenamingWorkspaceId(workspace.id);
    void patchSettings({ workspaces: [...current.workspaces, workspace] });
  }, [patchSettings]);

  const commitWorkspaceRename = useCallback(
    (id: string, name: string) => {
      setRenamingWorkspaceId(null);
      const current = settingsRef.current;
      const trimmed = name.trim();
      if (!current || !trimmed) return;
      void patchSettings({ workspaces: updateWorkspace(current.workspaces, id, { name: trimmed }) });
    },
    [patchSettings],
  );

  const deleteWorkspaceGroup = useCallback(
    (id: string) => {
      const current = settingsRef.current;
      if (!current) return;
      void patchSettings({ workspaces: removeWorkspace(current.workspaces, id) });
      pushToast(tRef.current('notice.workspaceRemoved'), 'success');
    },
    [patchSettings, pushToast],
  );

  const startWorkspaceSession = useCallback(
    (workspaceId: string) => {
      openConnectionEditor({ mode: 'create', workspaceId });
    },
    [openConnectionEditor],
  );

  /** Moves an ungrouped host into a workspace from its row menu. */
  const attachProfileToWorkspace = useCallback(
    (workspaceId: string, profileId: string) => {
      const current = settingsRef.current;
      if (!current) return;
      void patchSettings({
        workspaces: appendProfilesToWorkspace(current.workspaces, workspaceId, [profileId]),
      });
    },
    [patchSettings],
  );

  /** Opens the workspace picker next to the item that asked for it. */
  const openMoveMenu = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setMoveMenu({ x: rect.right + 8, y: rect.top - 5 });
  }, []);

  /**
   * Persists the connection list. A connection created from a workspace's row
   * menu joins that workspace, and deleting a connection removes it from all of
   * them.
   */
  const persistProfiles = useCallback(
    (next: SshProfile[]) => {
      const current = settingsRef.current;
      if (!current) return;
      const before = new Set(current.ssh.profiles.map((profile) => profile.id));
      const after = new Set(next.map((profile) => profile.id));
      const added = next.filter((profile) => !before.has(profile.id)).map((profile) => profile.id);
      let nextWorkspaces = current.workspaces;
      for (const profile of current.ssh.profiles) {
        if (!after.has(profile.id)) {
          nextWorkspaces = detachProfileFromWorkspaces(nextWorkspaces, profile.id);
        }
      }
      const target = connectionsRef.current?.workspaceId;
      if (target && added.length > 0) {
        nextWorkspaces = appendProfilesToWorkspace(nextWorkspaces, target, added);
      }
      void patchSettings({ ssh: { ...current.ssh, profiles: next }, workspaces: nextWorkspaces });
    },
    [patchSettings],
  );

  /**
   * Deletes a saved host from the row menu. Going through `persistProfiles`
   * keeps one code path for the workspace cleanup.
   */
  const deleteProfile = useCallback(
    (profileId: string) => {
      const current = settingsRef.current;
      if (!current) return;
      persistProfiles(removeSshProfile(current.ssh.profiles, profileId));
      pushToast(tRef.current('notice.connectionDeleted'), 'success');
    },
    [persistProfiles, pushToast],
  );

  // Nested menu pages only live while their menu is open.
  useEffect(() => {
    if (!rowMenu) setMenuStep('main');
    if (!rowMenu) setMoveMenu(null);
  }, [rowMenu]);

  /* -------------------------------------------------------------- keyboard */

  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inTerminal = Boolean(target?.closest('.xterm'));
    const typing = !inTerminal && Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));

    if (event.key === 'Escape') {
      // The paste gate is the innermost layer: Escape backs out of it first.
      if (pasteRequest) {
        cancelPaste();
      } else if (connections) setConnections(null);
      else if (rowMenu) setRowMenu(null);
      else if (newMenu) setNewMenu(null);
      else if (renamingId) setRenamingId(null);
      else if (renamingWorkspaceId) setRenamingWorkspaceId(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (sidePanel) setSidePanel(null);
      else return;
      event.preventDefault();
      return;
    }

    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey || typing) return;

    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      openLocal();
      return;
    }
    if (event.key === 'w' || event.key === 'W') {
      const id = activeIdRef.current;
      if (!id) return;
      event.preventDefault();
      void closeSession(id);
      return;
    }
    // Ctrl+J is a newline in a shell, so the terminal keeps it.
    if (event.key === 'j' || event.key === 'J') {
      if (inTerminal) return;
      event.preventDefault();
      togglePanel();
      return;
    }
    if (event.key === ',') {
      event.preventDefault();
      openSettingsPage();
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const tab = sessionsRef.current[Number(event.key) - 1];
      if (!tab) return;
      event.preventDefault();
      setActiveId(tab.id);
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  /* ----------------------------------------------------------------- render */

  if (!boot || !settings) {
    return <div className="boot" aria-hidden="true" />;
  }

  const t = tRef.current;
  // The info panel always describes the active tab, so switching tabs moves it.
  const activeSession = sessions.find((session) => session.id === activeId) ?? null;

  const menuTarget = rowMenu?.target ?? null;
  const menuSession =
    menuTarget && menuTarget.kind === 'session'
      ? sessions.find((session) => session.id === menuTarget.sessionId) ?? null
      : null;
  const menuWorkspace =
    menuTarget && menuTarget.kind === 'workspace'
      ? workspaces.find((workspace) => workspace.id === menuTarget.workspaceId) ?? null
      : null;
  const menuProfile =
    menuTarget && menuTarget.kind === 'profile'
      ? profiles.find((profile) => profile.id === menuTarget.profileId) ?? null
      : null;

  return (
    <LocaleProvider locale={locale}>
      <div
        className="app-shell"
        data-platform={boot.platform.os}
        data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
        data-fullscreen={fullscreen ? 'true' : undefined}
      >
        {/* macOS: the traffic lights sit here, so the band is also the title bar. */}
        {boot.platform.os === 'darwin' ? (
          <div className="titlebar-band" data-testid="titlebar-band" aria-hidden="true" />
        ) : null}

        <Sidebar
          demo={isMockBridge()}
          shells={settings.shell.profiles}
          wslDistributions={boot.wslDistributions}
          profiles={profiles}
          workspaces={workspaces}
          sessionOrder={settings.layout.sessionOrder}
          onInventoryDrop={(next) => {
            const current = settingsRef.current;
            if (!current) return;
            // The drag works in sidebar keys; a workspace stores profile ids, so
            // the translation happens here, in one settings write.
            const workspaces = current.workspaces.map((workspace) => {
              const arranged = next.workspaces.find((item) => item.id === workspace.id);
              if (!arranged) return workspace;
              return {
                ...workspace,
                profileIds: arranged.keys.map((key) => key.replace(/^ssh:/, '')),
              };
            });
            void patchSettings({ layout: { sessionOrder: next.sessions }, workspaces });
          }}
          renamingWorkspaceId={renamingWorkspaceId}
          menuTarget={rowMenu && rowMenu.target.kind !== 'session' ? rowMenu.target : null}
          newSessionMenuOpen={newMenu !== null}
          onNewSession={setNewMenu}
          onOpenLocal={(profileId) => openLocal(profileId)}
          onOpenWsl={(distribution) => openWsl(distribution)}
          onOpenSsh={openProfile}
          onOpenMenu={(target, anchor) => setRowMenu({ target, anchor })}
          onNewWorkspace={createWorkspaceGroup}
          onCommitWorkspaceRename={commitWorkspaceRename}
          onCancelWorkspaceRename={() => setRenamingWorkspaceId(null)}
          onOpenSettings={openSettingsPage}
        />

        <main className="stage">
          <header className="stage-head" data-sheet={sidePanel ? 'true' : undefined}>
            <button
              type="button"
              className="rail-toggle"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              data-tip={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              onClick={toggleSidebar}
            >
              <IconPanelLeft size={15} />
            </button>
            <TabStrip
              sessions={sessions}
              activeId={activeId}
              renamingId={renamingId}
              menuOpen={newMenu !== null}
              onNewTab={() => openLocal()}
              onActivate={setActiveId}
              onOpenMenu={(sessionId, anchor) =>
                setRowMenu({ target: { kind: 'session', sessionId }, anchor })
              }
              onOpenNewMenu={(anchor) => setNewMenu(anchor)}
              onBeginRename={setRenamingId}
              onCommitRename={(id, title) => void renameSession(id, title)}
              onCancelRename={() => setRenamingId(null)}
              onClose={(id) => void closeSession(id)}
            />
            <TitleBar
              platform={boot.platform}
              panelOpen={sidePanel !== null}
              onTogglePanel={togglePanel}
              panelTabs={
                sidePanel ? <SidePanelTabs tab={sidePanel} onSelectTab={setSidePanel} /> : undefined
              }
            />
          </header>

          <div
            className="workspace"
            data-view={connections ? 'connection' : settingsOpen ? 'settings' : 'terminal'}
          >
            <div className="terminal-stage" data-empty={sessions.length === 0 ? 'true' : undefined}>
              {sessions.length === 0 ? (
                <Welcome
                  version={boot.platform.appVersion}
                  onNewTerminal={() => openLocal()}
                  onOpenConnections={() => openConnectionEditor({ mode: 'create' })}
                  onOpenSettings={openSettingsPage}
                />
              ) : null}
              {sessions.map((session) => {
                const active = session.id === activeId;
                const credentialRequest = credentialRequests[session.id];
                return (
                  <div key={session.id} className="terminal-slot" data-active={active ? 'true' : undefined}>
                    <TerminalPane
                      sessionId={session.id}
                      active={active}
                      settings={settings}
                      scheme={scheme}
                      register={registerTerminal}
                      onPasteRequest={requestPaste}
                      onCopyFailed={reportCopyFailed}
                    />
                    {credentialRequest ? (
                      <CredentialPromptBar
                        request={credentialRequest}
                        onRespond={(decision) => respondCredential(session.id, decision)}
                      />
                    ) : null}
                    {session.status !== 'connected' ? (
                      <div className="terminal-state" data-status={session.status}>
                        <span className="status-dot" data-status={session.status} aria-hidden="true" />
                        {t(`status.${session.status}`)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {/* Notices sit on the terminal they talk about, inset from its corner. */}
              <Toasts items={toasts} onDismiss={dismissToast} />
            </div>
            {/* Settings takes the main area; the terminal stays mounted behind it. */}
            {settingsOpen ? (
              <SettingsPage
                settings={settings}
                systemDark={systemDark}
                platform={boot.platform}
                wslDistributions={boot.wslDistributions}
                onClose={() => setSettingsOpen(false)}
                patch={(patch) => void patchSettings(patch)}
                onApplyIdentity={() => getBridge().applyIdentity()}
                onRevealIdentity={() => getBridge().revealIdentity()}
                onRefreshSettings={refreshSettings}
              />
            ) : null}
            {/* One saved host at a time: a page, exactly like settings. */}
            {connections ? (
              <ConnectionEditor
                mode={connections.mode}
                profileId={connections.profileId}
                profiles={profiles}
                defaultPort={settings.ssh.defaultPort}
                secretsEncrypted={boot.secrets.encrypted}
                onClose={() => setConnections(null)}
                onPersist={persistProfiles}
                onConnect={openProfile}
                onSaved={() => pushToast(t('notice.connectionSaved'), 'success')}
                onDeleted={() => pushToast(t('notice.connectionDeleted'), 'success')}
                onPickKey={() => getBridge().pickPrivateKeyFile()}
                onTestConnection={testConnection}
              />
            ) : null}
            {sidePanel ? (
              <SidePanel tab={sidePanel}>
                {sidePanel === 'tasks' ? (
                  <AgentPanel
                    settings={settings.agent}
                    tasks={tasks}
                    sessions={sessions}
                    focusSessionId={agentSessionId}
                    onFocusSession={(id) => setPinnedSessionId(id)}
                    activeTaskId={openTaskId}
                    messages={openTaskId ? messagesByTask[openTaskId] ?? [] : []}
                    toolCalls={openTaskId ? toolCallsByTask[openTaskId] ?? [] : []}
                    approvals={
                      openTaskId ? approvals.filter((item) => item.taskId === openTaskId) : []
                    }
                    loadingTranscript={openTaskId !== null && transcriptLoadingId === openTaskId}
                    onNewTask={createAgentTask}
                    onOpenTask={setOpenTaskId}
                    onBack={() => setOpenTaskId(null)}
                    onCloseTask={closeAgentTask}
                    onSend={promptAgent}
                    onCancel={cancelAgent}
                    onRespondApproval={respondApproval}
                    onSetMode={setAgentMode}
                    onOpenSettings={openSettingsPage}
                  />
                ) : sidePanel === 'sftp' ? (
                  <SftpPanel
                    session={activeSession}
                    onToast={pushToast}
                    onNewTerminal={() => openLocal()}
                    onCopy={(text) => void copy(text)}
                  />
                ) : (
                  <SessionInfoPanel
                    session={activeSession}
                    onRefresh={refreshMetadata}
                    onCopyJson={(session) => void copy(JSON.stringify(session, null, 2))}
                    onNewTerminal={() => openLocal()}
                  />
                )}
              </SidePanel>
            ) : null}
          </div>
        </main>

        {/* Row menus: a session, a workspace or a saved host in a workspace. */}
        <Popover
          open={rowMenu !== null}
          anchor={rowMenu?.anchor ?? null}
          onClose={() => setRowMenu(null)}
          label={t('sidebar.more')}
          keepOpenWithin="[data-menu-layer]"
        >
          {menuSession ? (
            <>
              <MenuItem
                icon={<IconInfo size={14} />}
                onSelect={() => {
                  setActiveId(menuSession.id);
                  setSidePanel('terminal');
                  setRowMenu(null);
                }}
              >
                {t('tab.menu.sessionInfo')}
              </MenuItem>
              <MenuItem
                icon={<IconPencil size={14} />}
                onSelect={() => {
                  setRenamingId(menuSession.id);
                  setRowMenu(null);
                }}
              >
                {t('tab.menu.rename')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<IconClose size={14} />}
                danger
                onSelect={() => {
                  setRowMenu(null);
                  void closeSession(menuSession.id);
                }}
              >
                {t('tab.menu.close')}
              </MenuItem>
              <MenuItem
                icon={<IconClose size={14} />}
                onSelect={() => {
                  setRowMenu(null);
                  void closeOtherSessions(menuSession.id);
                }}
              >
                {t('tab.menu.closeOthers')}
              </MenuItem>
            </>
          ) : null}

          {menuWorkspace ? (
            menuStep === 'delete' ? (
              <>
                <p className="menu-confirm">
                  {t('workspace.removeConfirm', { name: menuWorkspace.name })}
                </p>
                <MenuItem
                  icon={<IconTrash size={14} />}
                  danger
                  onSelect={() => {
                    setRowMenu(null);
                    deleteWorkspaceGroup(menuWorkspace.id);
                  }}
                >
                  {t('workspace.remove')}
                </MenuItem>
                <MenuItem icon={<IconClose size={14} />} onSelect={() => setMenuStep('main')}>
                  {t('common.cancel')}
                </MenuItem>
              </>
            ) : (
              <>
                <MenuItem
                  icon={<IconPlus size={14} />}
                  onSelect={() => {
                    setRowMenu(null);
                    startWorkspaceSession(menuWorkspace.id);
                  }}
                >
                  {t('workspace.addSession')}
                </MenuItem>
                <MenuItem
                  icon={<IconPencil size={14} />}
                  onSelect={() => {
                    setRenamingWorkspaceId(menuWorkspace.id);
                    setRowMenu(null);
                  }}
                >
                  {t('workspace.rename')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<IconTrash size={14} />}
                  danger
                  onSelect={() => setMenuStep('delete')}
                >
                  {t('workspace.remove')}
                </MenuItem>
              </>
            )
          ) : null}

          {menuProfile ? (
            menuStep === 'delete' ? (
              <>
                <p className="menu-confirm">
                  {t('connections.deleteConfirm', { name: sshProfileTitle(menuProfile) })}
                </p>
                <MenuItem
                  icon={<IconTrash size={14} />}
                  danger
                  onSelect={() => {
                    setRowMenu(null);
                    deleteProfile(menuProfile.id);
                  }}
                >
                  {t('connections.delete')}
                </MenuItem>
                <MenuItem icon={<IconClose size={14} />} onSelect={() => setMenuStep('main')}>
                  {t('common.cancel')}
                </MenuItem>
              </>
            ) : (
              <>
                <MenuItem
                  icon={<IconArrowRight size={14} />}
                  onHover={() => setMoveMenu(null)}
                  onSelect={() => {
                    setRowMenu(null);
                    openProfile(menuProfile);
                  }}
                >
                  {t('sidebar.openInTab')}
                </MenuItem>
                <MenuItem
                  icon={<IconPencil size={14} />}
                  onHover={() => setMoveMenu(null)}
                  onSelect={() => {
                    setRowMenu(null);
                    openConnectionEditor({ mode: 'edit', profileId: menuProfile.id });
                  }}
                >
                  {t('connections.edit')}
                </MenuItem>
                {menuTarget && menuTarget.kind === 'profile' && !menuTarget.workspaceId && workspaces.length > 0 ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<IconFolder size={14} />}
                      chevron
                      onHover={openMoveMenu}
                      onSelect={openMoveMenu}
                    >
                      {t('sidebar.moveToWorkspace')}
                    </MenuItem>
                  </>
                ) : null}
                <MenuSeparator />
                <MenuItem
                  icon={<IconTrash size={14} />}
                  danger
                  onHover={() => setMoveMenu(null)}
                  onSelect={() => {
                    setMoveMenu(null);
                    setMenuStep('delete');
                  }}
                >
                  {t('sidebar.deleteConnection')}
                </MenuItem>
              </>
            )
          ) : null}
        </Popover>

        {/* Secondary menu of the "move to workspace" item: it lives outside the
            popover so it can grow to the right without clipping. */}
        <MenuFlyout anchor={moveMenu} label={t('sidebar.moveToWorkspace')}>
          <MenuSection>{t('sidebar.chooseWorkspace')}</MenuSection>
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              icon={<IconFolder size={14} />}
              onSelect={() => {
                if (!menuProfile) return;
                attachProfileToWorkspace(workspace.id, menuProfile.id);
                setMoveMenu(null);
                setRowMenu(null);
              }}
            >
              {workspace.name}
            </MenuItem>
          ))}
        </MenuFlyout>

        <Popover
          open={newMenu !== null}
          anchor={newMenu}
          onClose={() => setNewMenu(null)}
          label={t('tabs.newMenu')}
          className="popover-new"
        >
          <NewMenu
            settings={settings}
            wslDistributions={boot.wslDistributions}
            onOpenLocal={(profileId) => {
              setNewMenu(null);
              openLocal(profileId);
            }}
            onOpenWsl={(distribution) => {
              setNewMenu(null);
              openWsl(distribution);
            }}
            onNewConnection={() => {
              setNewMenu(null);
              openConnectionEditor({ mode: 'create' });
            }}
          />
        </Popover>
        {/* A right-click paste of more than one line waits here first. */}
        <PasteConfirm
          text={pasteRequest?.text ?? null}
          onCancel={cancelPaste}
          onConfirm={confirmPaste}
        />

        {/* One delegated tooltip layer for the whole app: see `data-tip`. */}
        <TooltipLayer />

      </div>
    </LocaleProvider>
  );
}
