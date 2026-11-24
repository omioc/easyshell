import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type {
  SftpEntry,
  SftpListing,
  SftpOrigin,
  SftpTransfer,
  SessionInfo,
} from '@shared/types';
import { getBridge } from '../bridge';
import { useT } from '../i18n';
import type { TFn } from '../i18n';
import { errorMessage } from '../lib/format';
import {
  IconArrowUp,
  IconCopy,
  IconClose,
  IconDownload,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconFolderSync,
  IconPencil,
  IconRefresh,
  IconServer,
  IconTerminal,
  IconTrash,
  IconUpload,
} from './Icons';
import { MenuItem, MenuSeparator, Popover } from './Overlay';
import type { PopoverAnchor } from './Overlay';
import type { ToastLevel } from './Toasts';

export interface SftpPanelProps {
  /** The active terminal tab, or null when no terminal is open. */
  session: SessionInfo | null;
  onToast: (text: string, level?: ToastLevel) => void;
  onNewTerminal: () => void;
  onCopy: (text: string) => void;
}

/** A row that is being created, or one that is being renamed. */
type Editor =
  | { kind: 'folder' | 'file' }
  | { kind: 'rename'; entry: SftpEntry };

interface MenuState {
  anchor: PopoverAnchor;
  /** The rows the menu acts on; empty when it belongs to the folder itself. */
  paths: string[];
  page: 'main' | 'delete';
}

/** How many transfer bars the sheet shows at once before the older ones go. */
const TRANSFER_SLOTS = 2;
/** How long a finished transfer keeps its bar before it disappears. */
const TRANSFER_LINGER_MS = 2600;

function separatorOf(style: SftpOrigin['style']): string {
  return style === 'win32' ? '\\' : '/';
}

function joinPath(style: SftpOrigin['style'], base: string, name: string): string {
  if (style === 'win32') {
    return base.endsWith('\\') ? `${base}${name}` : `${base}\\${name}`;
  }
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function nameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** The clickable trail from the root of the tree to `path`. */
function crumbsOf(path: string, style: SftpOrigin['style']): Array<{ name: string; path: string }> {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  const crumbs: Array<{ name: string; path: string }> = [];
  if (style === 'win32') {
    let acc = '';
    for (const [index, part] of parts.entries()) {
      acc = index === 0 ? `${part}\\` : joinPath(style, acc, part);
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }
  crumbs.push({ name: '/', path: '/' });
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit] ?? 'KB'}`;
}

function transferLabel(transfer: SftpTransfer, t: TFn): string {
  if (transfer.total && transfer.total > 0) {
    const percent = Math.min(100, Math.round((transfer.bytes / transfer.total) * 100));
    return `${percent}%`;
  }
  return formatSize(transfer.bytes) || t('sftp.transferring');
}

/**
 * The file sheet of one terminal tab.
 *
 * It follows the terminal until the user goes somewhere else: `cd` in the shell
 * moves the sheet, a click on a folder does not move it back. The follow button
 * in the path bar is the way back, and it is the only chrome that announces the
 * mode at all — a sheet that says "following" all the time would be saying
 * nothing.
 */
export function SftpPanel({ session, onToast, onNewTerminal, onCopy }: SftpPanelProps) {
  const t = useT();
  const sessionId = session?.id ?? null;
  const cwd = session?.cwd ?? null;

  const [origin, setOrigin] = useState<SftpOrigin | null>(null);
  /** `noChannel` is not an error: an SSH tab that is still dialing has none. */
  const [originIssue, setOriginIssue] = useState<'noChannel' | string | null>(null);
  const [listing, setListing] = useState<SftpListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [follow, setFollow] = useState(true);
  const [manualPath, setManualPath] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [transfers, setTransfers] = useState<SftpTransfer[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [staging, setStaging] = useState(false);

  const requestSeq = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Editors and menus read the draft on commit; a ref keeps them current. */
  const draftRef = useRef('');
  draftRef.current = draft;
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const tRef = useRef(t);
  tRef.current = t;
  const path = listing?.path ?? null;
  const pathRef = useRef<string | null>(path);
  pathRef.current = path;
  const sessionRef = useRef<string | null>(sessionId);
  sessionRef.current = sessionId;
  const reloadRef = useRef<() => void>(() => undefined);

  /** Where the sheet shows: the terminal's directory, or the folder clicked. */
  const target = follow ? (cwd ?? origin?.home ?? null) : (manualPath ?? origin?.home ?? null);

  const load = useCallback(
    async (next: string) => {
      if (!sessionId) return;
      requestSeq.current += 1;
      const ticket = requestSeq.current;
      setLoading(true);
      try {
        const result = await getBridge().sftpList(sessionId, next);
        if (ticket !== requestSeq.current) return;
        setListing(result);
        setError(null);
        setSelection([]);
        setAnchorPath(null);
      } catch (failure) {
        if (ticket !== requestSeq.current) return;
        setError(errorMessage(failure));
      } finally {
        if (ticket === requestSeq.current) setLoading(false);
      }
    },
    [sessionId],
  );

  reloadRef.current = () => {
    const current = pathRef.current;
    if (current) void load(current);
  };

  // A new tab is a new machine: nothing from the previous one may survive.
  useEffect(() => {
    setOrigin(null);
    setOriginIssue(null);
    setListing(null);
    setError(null);
    setSelection([]);
    setEditor(null);
    setMenu(null);
    setFollow(true);
    setManualPath(null);
    if (!sessionId) return undefined;
    let alive = true;
    void getBridge()
      .sftpOrigin(sessionId)
      .then((value) => {
        if (!alive) return;
        if (!value) setOriginIssue('noChannel');
        else setOrigin(value);
      })
      .catch((failure: unknown) => {
        if (alive) setOriginIssue(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // Every navigation — a click, a `cd`, the follow button — arrives here.
  useEffect(() => {
    if (!origin || !target) return;
    void load(target);
  }, [origin, target, load]);

  // Main queries on terminal output and announces the directory as a session
  // update, which moves `target` and reloads the list.
  useEffect(() => {
    if (!sessionId || !origin?.canFollow || !follow) return undefined;
    const bridge = getBridge();
    void bridge.sftpFollowCwd(sessionId, true).catch(() => undefined);
    return () => {
      void bridge.sftpFollowCwd(sessionId, false).catch(() => undefined);
    };
  }, [sessionId, origin?.canFollow, follow]);

  useEffect(() => {
    const bridge = getBridge();
    return bridge.onSftpEvent((event) => {
      if (event.type === 'sftp-notice') {
        toastRef.current(
          tRef.current(event.notice.key, event.notice.params),
          event.notice.level === 'warn' ? 'warn' : event.notice.level,
        );
        return;
      }
      const transfer = event.transfer;
      if (transfer.sessionId !== sessionRef.current) return;
      setTransfers((previous) => {
        const index = previous.findIndex((item) => item.id === transfer.id);
        const next =
          index === -1
            ? [...previous, transfer]
            : previous.map((item) => (item.id === transfer.id ? transfer : item));
        return next.slice(-TRANSFER_SLOTS);
      });
      if (!transfer.done) return;
      if (transfer.error) {
        toastRef.current(
          tRef.current('sftp.failed', { name: transfer.name, message: transfer.error }),
          'error',
        );
      } else if (transfer.direction === 'upload') {
        // The destination may be the folder on screen, or any folder inside it.
        const current = pathRef.current;
        if (current && transfer.target.startsWith(current)) reloadRef.current();
      }
      window.setTimeout(() => {
        setTransfers((previous) => previous.filter((item) => item.id !== transfer.id));
      }, TRANSFER_LINGER_MS);
    });
  }, []);

  // Escape belongs to the sheet's own layers while one of them is open; the app
  // would otherwise close the whole panel on the first Escape.
  useEffect(() => {
    if (!menu && !editor) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      setEditor(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [menu, editor]);

  const entries = listing?.entries ?? [];
  const selected = useMemo(() => new Set(selection), [selection]);
  const crumbs = useMemo(
    () => (path && origin ? crumbsOf(path, origin.style) : []),
    [path, origin],
  );

  /* ------------------------------------------------------------- navigation */

  const navigate = useCallback((next: string) => {
    setFollow(false);
    setManualPath(next);
  }, []);

  const goUp = useCallback(() => {
    if (!listing?.parent) return;
    navigate(listing.parent);
  }, [listing?.parent, navigate]);

  const resumeFollow = useCallback(() => {
    setFollow(true);
    setManualPath(null);
  }, []);

  const refreshOrigin = useCallback(() => {
    const id = sessionRef.current;
    if (!id) return;
    setOriginIssue(null);
    void getBridge()
      .sftpOrigin(id)
      .then((value) => {
        if (!value) setOriginIssue('noChannel');
        else setOrigin(value);
      })
      .catch((failure: unknown) => setOriginIssue(errorMessage(failure)));
  }, []);

  /* -------------------------------------------------------------- selection */

  const selectRow = useCallback(
    (entry: SftpEntry, event: ReactMouseEvent) => {
      const additive = event.metaKey || event.ctrlKey;
      if (event.shiftKey && anchorPath) {
        const anchorIndex = entries.findIndex((item) => item.path === anchorPath);
        const targetIndex = entries.findIndex((item) => item.path === entry.path);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const [from, to] = anchorIndex <= targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
          setSelection(entries.slice(from, to + 1).map((item) => item.path));
          return;
        }
      }
      if (additive) {
        setSelection((previous) =>
          previous.includes(entry.path)
            ? previous.filter((item) => item !== entry.path)
            : [...previous, entry.path],
        );
        setAnchorPath(entry.path);
        return;
      }
      setSelection([entry.path]);
      setAnchorPath(entry.path);
    },
    [anchorPath, entries],
  );

  /* --------------------------------------------------------------- actions */

  const download = useCallback(
    async (paths: string[]) => {
      const id = sessionRef.current;
      if (!id || paths.length === 0) return;
      try {
        const destination = await getBridge().sftpDownload(id, paths);
        if (destination) {
          toastRef.current(tRef.current('sftp.downloaded', { path: destination }), 'success');
        }
      } catch (failure) {
        toastRef.current(
          tRef.current('error.unknown', { message: errorMessage(failure) }),
          'error',
        );
      }
    },
    [],
  );

  /** Double click and Enter: a folder is entered, a file is downloaded. */
  const openEntry = useCallback(
    (entry: SftpEntry) => {
      if (entry.dir) {
        navigate(entry.path);
        return;
      }
      void download([entry.path]);
    },
    [download, navigate],
  );

  const upload = useCallback(async (paths: string[], destination: string | null) => {
    const id = sessionRef.current;
    if (!id || !destination || paths.length === 0) return;
    try {
      await getBridge().sftpUpload(id, destination, paths);
      toastRef.current(tRef.current('sftp.uploaded', { path: destination }), 'success');
      reloadRef.current();
    } catch (failure) {
      toastRef.current(
        tRef.current('error.unknown', { message: errorMessage(failure) }),
        'error',
      );
    }
  }, []);

  const pickAndUpload = useCallback(async () => {
    const destination = pathRef.current;
    if (!destination) return;
    try {
      const picked = await getBridge().sftpPickFiles();
      await upload(picked, destination);
    } catch (failure) {
      toastRef.current(
        tRef.current('error.unknown', { message: errorMessage(failure) }),
        'error',
      );
    }
  }, [upload]);

  const removeEntries = useCallback(async (paths: string[]) => {
    const id = sessionRef.current;
    const destination = pathRef.current;
    if (!id || paths.length === 0) return;
    try {
      await getBridge().sftpRemove(id, paths);
      const label = paths.length === 1 ? nameOf(paths[0] ?? '') : String(paths.length);
      toastRef.current(tRef.current('sftp.deleted', { name: label }), 'success');
      if (destination) void load(destination);
    } catch (failure) {
      toastRef.current(
        tRef.current('error.unknown', { message: errorMessage(failure) }),
        'error',
      );
    }
  }, [load]);

  const commitEditor = useCallback(async () => {
    const id = sessionRef.current;
    const current = pathRef.current;
    const active = editor;
    const name = draftRef.current.trim();
    if (!id || !active || !origin) return;
    setEditor(null);
    setDraft('');
    if (!name) return;
    try {
      if (active.kind === 'rename') {
        const destination = current ? joinPath(origin.style, current, name) : name;
        if (destination === active.entry.path) return;
        await getBridge().sftpRename(id, active.entry.path, destination);
        toastRef.current(tRef.current('sftp.renamed', { name }), 'success');
      } else {
        const destination = current ? joinPath(origin.style, current, name) : name;
        if (active.kind === 'folder') await getBridge().sftpMkdir(id, destination);
        else await getBridge().sftpCreateFile(id, destination);
        toastRef.current(tRef.current('sftp.created', { name }), 'success');
      }
      if (current) await load(current);
    } catch (failure) {
      toastRef.current(
        tRef.current('error.unknown', { message: errorMessage(failure) }),
        'error',
      );
    }
  }, [editor, load, origin]);

  /* -------------------------------------------------------------- handlers */

  const openMenu = useCallback(
    (event: ReactMouseEvent, paths: string[]) => {
      event.preventDefault();
      event.stopPropagation();
      setEditor(null);
      setMenu({
        anchor: { x: event.clientX, y: event.clientY, origin: 'top left' },
        paths,
        page: 'main',
      });
    },
    [],
  );

  const onRowContextMenu = useCallback(
    (event: ReactMouseEvent, entry: SftpEntry) => {
      const paths = selected.has(entry.path) ? selection : [entry.path];
      if (!selected.has(entry.path)) {
        setSelection([entry.path]);
        setAnchorPath(entry.path);
      }
      openMenu(event, paths);
    },
    [openMenu, selected, selection],
  );

  const onListContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      // A right click on a row is that row's menu, wherever the handler lands.
      if ((event.target as HTMLElement).closest('.sftp-row')) return;
      setSelection([]);
      openMenu(event, []);
    },
    [openMenu],
  );

  const onDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault();
      setDropActive(false);
      const destination = pathRef.current;
      if (!destination) return;
      const bridge = getBridge();
      const files = Array.from(event.dataTransfer.files);
      const paths = files
        .map((file) => bridge.pathForFile(file))
        .filter((value) => value.length > 0);
      if (paths.length === 0) {
        toastRef.current(tRef.current('sftp.noLocalPath'), 'error');
        return;
      }
      void upload(paths, destination);
    },
    [upload],
  );

  const onRowDragStart = useCallback(
    (event: ReactDragEvent, entry: SftpEntry) => {
      const id = sessionRef.current;
      if (!id) return;
      // The OS drag has to start with files that already exist on disk, so the
      // HTML drag is cancelled and main takes over once the copy is done.
      event.preventDefault();
      const paths = selected.has(entry.path) ? selection : [entry.path];
      setStaging(true);
      void getBridge()
        .sftpStage(id, paths)
        .then((localPaths) => getBridge().sftpStartDrag(localPaths))
        .catch((failure: unknown) => {
          toastRef.current(
            tRef.current('error.unknown', { message: errorMessage(failure) }),
            'error',
          );
        })
        .finally(() => setStaging(false));
    },
    [selected, selection],
  );

  const onListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editor) return;
      if (event.key === 'Delete' && selection.length > 0) {
        event.preventDefault();
        // The keyboard takes the same road as the menu: a delete is confirmed,
        // never performed on a stray key press.
        const row = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
        const box = (row ?? listRef.current)?.getBoundingClientRect();
        setMenu({
          anchor: {
            x: Math.round((box?.x ?? 0) + 12),
            y: Math.round((box?.y ?? 0) + (box?.height ?? 0) + 2),
            origin: 'top left',
          },
          paths: selection,
          page: 'delete',
        });
        return;
      }
      if ((event.key === 'F2' || event.key === 'F5') && selection.length === 1) {
        event.preventDefault();
        const entry = entries.find((item) => item.path === selection[0]);
        if (event.key === 'F2' && entry) {
          setDraft(entry.name);
          setEditor({ kind: 'rename', entry });
        } else if (event.key === 'F5') {
          reloadRef.current();
        }
        return;
      }
      if (event.key === 'Enter' && selection.length === 1) {
        const entry = entries.find((item) => item.path === selection[0]);
        if (entry) {
          event.preventDefault();
          openEntry(entry);
        }
      }
    },
    [editor, entries, openEntry, removeEntries, selection],
  );

  /* ----------------------------------------------------------------- render */

  if (!session) {
    return (
      <div className="info-empty-wrap">
        <div className="info-empty-card">
          <span className="info-empty-icon" aria-hidden="true">
            <IconFolderSync size={26} />
          </span>
          <h3 className="info-empty-title">{t('sftp.noSession')}</h3>
          <p className="info-empty-hint">{t('sftp.noSessionHint')}</p>
          <button type="button" className="button button-primary info-empty-action" onClick={onNewTerminal}>
            <IconTerminal size={14} />
            {t('welcome.newTerminal')}
          </button>
        </div>
      </div>
    );
  }

  if (originIssue) {
    const noChannel = originIssue === 'noChannel';
    return (
      <div className="info-empty-wrap">
        <div className="info-empty-card">
          <span className="info-empty-icon" aria-hidden="true">
            <IconFolderSync size={26} />
          </span>
          <h3 className="info-empty-title">
            {noChannel ? t('sftp.noChannel') : t('error.unknown', { message: originIssue })}
          </h3>
          <p className="info-empty-hint">{noChannel ? t('sftp.noChannelHint') : ''}</p>
          <button type="button" className="button info-empty-action" onClick={refreshOrigin}>
            <IconRefresh size={14} />
            {t('sftp.retry')}
          </button>
        </div>
      </div>
    );
  }

  const menuEntry =
    menu && menu.paths.length === 1
      ? entries.find((item) => item.path === menu.paths[0]) ?? null
      : null;
  const menuSelection = menu?.paths ?? [];

  return (
    <>
      <div className="sftp-head">
        <div className="sftp-host">
          <span className="sftp-host-icon" aria-hidden="true">
            <IconServer size={12} />
          </span>
          <span className="sftp-host-name" data-tip={t('sftp.hostLabel')}>
            {origin?.label ?? session.title}
          </span>
          {origin?.nested ? (
            <span className="sftp-host-badge" data-tip={t('sftp.nestedNote')}>
              {t('sessionInfo.source.nested')}
            </span>
          ) : null}
        </div>

        <div className="sftp-path">
          <button
            type="button"
            className="icon-button"
            aria-label={t('sftp.up')}
            data-tip={t('sftp.up')}
            disabled={!listing?.parent}
            onClick={goUp}
          >
            <IconArrowUp size={14} />
          </button>
          <div className="sftp-crumbs">
            {crumbs.map((crumb, index) => {
              // The POSIX root crumb *is* the slash, so the segment right after
              // it must not add a second one: `/root`, never `//root`.
              const previous = crumbs[index - 1];
              const separator =
                index > 0 && previous?.name !== '/' ? separatorOf(origin?.style ?? 'posix') : null;
              return (
                <span key={crumb.path} className="sftp-crumb-item">
                  {separator ? (
                    <span className="sftp-crumb-sep" aria-hidden="true">
                      {separator}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="sftp-crumb"
                    data-current={index === crumbs.length - 1 ? 'true' : undefined}
                    onClick={() => navigate(crumb.path)}
                    title={crumb.path}
                  >
                    {crumb.name}
                  </button>
                </span>
              );
            })}
          </div>
          {origin?.canFollow ? (
            <button
              type="button"
              className="icon-button sftp-follow"
              aria-pressed={follow}
              aria-label={follow ? t('sftp.followOn') : t('sftp.followOff')}
              data-tip={follow ? t('sftp.followOn') : t('sftp.followOff')}
              onClick={() => {
                if (follow) {
                  // Leaving the mode keeps the user where they are looking.
                  setManualPath(path ?? origin.home);
                  setFollow(false);
                } else {
                  resumeFollow();
                }
              }}
            >
              <IconFolderSync size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={listRef}
        className="sftp-list"
        role="listbox"
        aria-label={t('sidePanel.sftp')}
        aria-busy={loading ? 'true' : undefined}
        tabIndex={0}
        data-drop={dropActive ? 'true' : undefined}
        onKeyDown={onListKeyDown}
        onContextMenu={onListContextMenu}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropActive(false);
        }}
        onDrop={onDrop}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('.sftp-row')) return;
          setSelection([]);
          setAnchorPath(null);
        }}
      >
        {editor && editor.kind !== 'rename' ? (
          <div className="sftp-row sftp-row-editor">
            <span className="sftp-row-icon" aria-hidden="true">
              {editor.kind === 'folder' ? <IconFolder size={14} /> : <IconFile size={14} />}
            </span>
            <input
              className="sftp-input"
              autoFocus
              value={draft}
              placeholder={t('sftp.namePlaceholder')}
              aria-label={t('sftp.namePlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commitEditor()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void commitEditor();
                }
              }}
            />
          </div>
        ) : null}

        {entries.map((entry) => (
          <div
            key={entry.path}
            className="sftp-row"
            role="option"
            aria-selected={selected.has(entry.path)}
            data-dir={entry.dir ? 'true' : undefined}
            data-selected={selected.has(entry.path) ? 'true' : undefined}
            draggable
            onDragStart={(event) => onRowDragStart(event, entry)}
            onClick={(event) => selectRow(entry, event)}
            onDoubleClick={() => openEntry(entry)}
            onContextMenu={(event) => onRowContextMenu(event, entry)}
          >
            <span className="sftp-row-icon" aria-hidden="true">
              {entry.dir ? <IconFolder size={14} /> : <IconFile size={14} />}
            </span>
            {editor && editor.kind === 'rename' && editor.entry.path === entry.path ? (
              <input
                className="sftp-input"
                autoFocus
                value={draft}
                aria-label={t('sftp.rename')}
                onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => void commitEditor()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitEditor();
                  }
                }}
              />
            ) : (
              <>
                <span className="sftp-row-name" title={entry.name}>
                  {entry.name}
                </span>
                {!entry.dir ? (
                  <span className="sftp-row-size tnum">{formatSize(entry.size)}</span>
                ) : null}
              </>
            )}
          </div>
        ))}

        {entries.length === 0 && !loading ? (
          <div className="sftp-empty">
            <IconFolderSync size={20} />
            <p className="sftp-empty-title">{t('sftp.empty')}</p>
            <p className="sftp-empty-hint">{t('sftp.emptyHint')}</p>
          </div>
        ) : null}

        {error ? (
          <div className="sftp-error">
            <p>{error}</p>
            <button type="button" className="button" onClick={() => void reloadRef.current()}>
              <IconRefresh size={14} />
              {t('sftp.retry')}
            </button>
          </div>
        ) : null}

        {dropActive ? (
          <div className="sftp-drop" aria-hidden="true">
            <IconUpload size={18} />
            <span>{t('sftp.dropHere')}</span>
          </div>
        ) : null}
      </div>

      {transfers.length > 0 || staging ? (
        <div className="sftp-transfers">
          {staging ? (
            <div className="sftp-transfer" data-done="false">
              <span className="sftp-transfer-name">{t('sftp.staging')}</span>
              <span className="sftp-transfer-bar" aria-hidden="true">
                <span className="sftp-transfer-fill" style={{ width: '100%' }} />
              </span>
            </div>
          ) : null}
          {transfers.map((transfer) => {
            const percent =
              transfer.total && transfer.total > 0
                ? Math.min(100, (transfer.bytes / transfer.total) * 100)
                : 100;
            return (
              <div
                key={transfer.id}
                className="sftp-transfer"
                data-done={transfer.done ? 'true' : 'false'}
                data-error={transfer.error ? 'true' : undefined}
                title={`${transfer.name} → ${transfer.target}`}
              >
                <span className="sftp-transfer-icon" aria-hidden="true">
                  {transfer.direction === 'upload' ? (
                    <IconUpload size={12} />
                  ) : (
                    <IconDownload size={12} />
                  )}
                </span>
                <span className="sftp-transfer-name">{transfer.name}</span>
                <span className="sftp-transfer-value tnum">{transferLabel(transfer, t)}</span>
                <span className="sftp-transfer-bar" aria-hidden="true">
                  <span className="sftp-transfer-fill" style={{ width: `${percent}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <footer className="sftp-foot">
        <button
          type="button"
          className="icon-button"
          aria-label={t('sftp.refresh')}
          data-tip={t('sftp.refresh')}
          onClick={() => reloadRef.current()}
        >
          <IconRefresh size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('sftp.newFolder')}
          data-tip={t('sftp.newFolder')}
          onClick={() => {
            setDraft('');
            setEditor({ kind: 'folder' });
          }}
        >
          <IconFolderPlus size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('sftp.upload')}
          data-tip={t('sftp.uploadHint')}
          onClick={() => void pickAndUpload()}
        >
          <IconUpload size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('sftp.download')}
          data-tip={t('sftp.download')}
          disabled={selection.length === 0}
          onClick={() => void download(selection)}
        >
          <IconDownload size={14} />
        </button>
        <span className="sftp-foot-status">
          {selection.length > 0
            ? t('sftp.selected', { count: selection.length })
            : t('sftp.count', { count: entries.length })}
        </span>
      </footer>

      <Popover
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        label={menuSelection.length > 0 ? t('sftp.itemActions') : t('sftp.folderActions')}
      >
        {menu && menu.paths.length === 0 ? (
          <>
            <MenuItem
              icon={<IconFolderPlus size={14} />}
              onSelect={() => {
                setMenu(null);
                setDraft('');
                setEditor({ kind: 'folder' });
              }}
            >
              {t('sftp.newFolder')}
            </MenuItem>
            <MenuItem
              icon={<IconFile size={14} />}
              onSelect={() => {
                setMenu(null);
                setDraft('');
                setEditor({ kind: 'file' });
              }}
            >
              {t('sftp.newFile')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<IconUpload size={14} />}
              onSelect={() => {
                setMenu(null);
                void pickAndUpload();
              }}
            >
              {t('sftp.upload')}
            </MenuItem>
            <MenuItem
              icon={<IconRefresh size={14} />}
              onSelect={() => {
                setMenu(null);
                reloadRef.current();
              }}
            >
              {t('sftp.refresh')}
            </MenuItem>
          </>
        ) : null}

        {menu && menuSelection.length > 0 ? (
          menu.page === 'delete' ? (
            <>
              <p className="menu-confirm">
                {menuSelection.length === 1
                  ? t('sftp.deleteOne', { name: nameOf(menuSelection[0] ?? '') })
                  : t('sftp.deleteMany', { count: menuSelection.length })}
              </p>
              <MenuItem
                icon={<IconTrash size={14} />}
                danger
                onSelect={() => {
                  setMenu(null);
                  void removeEntries(menuSelection);
                }}
              >
                {t('sftp.delete')}
              </MenuItem>
              <MenuItem icon={<IconClose size={14} />} onSelect={() => setMenu((current) => (current ? { ...current, page: 'main' } : current))}>
                {t('common.cancel')}
              </MenuItem>
            </>
          ) : (
            <>
              {menuEntry?.dir ? (
                <MenuItem
                  icon={<IconFolder size={14} />}
                  onSelect={() => {
                    setMenu(null);
                    navigate(menuEntry.path);
                  }}
                >
                  {t('sftp.open')}
                </MenuItem>
              ) : null}
              <MenuItem
                icon={<IconDownload size={14} />}
                onSelect={() => {
                  setMenu(null);
                  void download(menuSelection);
                }}
              >
                {t('sftp.download')}
              </MenuItem>
              <MenuItem
                icon={<IconPencil size={14} />}
                disabled={menuSelection.length !== 1}
                onSelect={() => {
                  const entry = menuEntry;
                  setMenu(null);
                  if (!entry) return;
                  setDraft(entry.name);
                  setEditor({ kind: 'rename', entry });
                }}
              >
                {t('sftp.rename')}
              </MenuItem>
              <MenuItem
                icon={<IconCopy size={14} />}
                disabled={menuSelection.length !== 1}
                onSelect={() => {
                  setMenu(null);
                  const first = menuSelection[0];
                  if (first) onCopy(first);
                }}
              >
                {t('sftp.copyPath')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<IconTrash size={14} />}
                danger
                onSelect={() => setMenu((current) => (current ? { ...current, page: 'delete' } : current))}
              >
                {t('sftp.delete')}
              </MenuItem>
            </>
          )
        ) : null}
      </Popover>
    </>
  );
}
