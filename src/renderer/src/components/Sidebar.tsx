import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { sshProfileTitle } from '@shared/profiles';
import type { ShellProfile, SshProfile, WorkspaceGroup } from '@shared/types';
import { workspaceProfiles } from '@shared/workspaces';
import { useT } from '../i18n';
import { shellBrand } from '../lib/sessions';
import type { PopoverAnchor } from './Overlay';
import { RenameField } from './RenameField';
import { listIdOfWorkspace, SESSIONS_LIST_ID, useInventoryDrag } from '../lib/inventoryDrag';
import type { InventoryArrangement } from '../lib/inventoryDrag';
import { DistroIcon, SshHostIcon } from './DistroIcon';
import {
  BrandMark,
  IconChevronDown,
  IconCmd,
  IconEllipsis,
  IconFolder,
  IconPlus,
  IconPowershell,
  IconSettings,
  IconTerminal,
} from './Icons';

/**
 * What a row's `…` menu acts on. Sessions are not in this list: the sidebar is
 * an inventory of entry points, the tab strip is the list of running sessions.
 */
export type SidebarMenuTarget =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'profile'; workspaceId?: string; profileId: string };

/**
 * One row of the Sessions list: a local shell profile, a WSL distribution or a
 * saved host without a workspace. The key is what survives a drag.
 */
type SessionEntry =
  | { key: string; kind: 'local'; profile: ShellProfile }
  | { key: string; kind: 'wsl'; distribution: string }
  | { key: string; kind: 'ssh'; profile: SshProfile };

export interface SidebarProps {
  /** True when the renderer runs against the in-memory demo bridge. */
  demo: boolean;
  /** Local shell profiles from settings: one launcher each. */
  shells: ShellProfile[];
  /** WSL distributions detected on this machine. */
  wslDistributions: string[];
  /** Saved SSH connections. Those without a workspace show up ungrouped. */
  profiles: SshProfile[];
  workspaces: WorkspaceGroup[];
  /** Sessions order the user arranged by dragging, as entry keys. */
  sessionOrder: string[];
  renamingWorkspaceId: string | null;
  /** The row menu that is open right now, so its trigger can stay lit. */
  menuTarget: SidebarMenuTarget | null;
  newSessionMenuOpen: boolean;
  onNewSession: (anchor: PopoverAnchor) => void;
  onOpenLocal: (profileId: string) => void;
  /** Persists a new Sessions order once a dragged row has landed. */
  /** Applies the arrangement a drag produced: Sessions order and workspaces. */
  onInventoryDrop: (next: InventoryArrangement) => void;
  onOpenWsl: (distribution: string) => void;
  onOpenSsh: (profile: SshProfile) => void;
  onOpenMenu: (target: SidebarMenuTarget, anchor: PopoverAnchor) => void;
  onNewWorkspace: () => void;
  onCommitWorkspaceRename: (id: string, name: string) => void;
  onCancelWorkspaceRename: () => void;
  onOpenSettings: () => void;
}

/** Menu surface that grows out of a row's ⋯ button, to its right. */
function menuAnchor(element: HTMLElement): PopoverAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.right + 8, y: rect.top - 4, origin: 'top left' };
}

/**
 * One launcher row. A single click selects it, a double click opens a new tab;
 * Enter opens too, so the list is usable without a mouse.
 */
function EntryRow({
  icon,
  label,
  badge,
  selected,
  testId,
  dragKey,
  menuOpen,
  onSelect,
  onOpen,
  onOpenMenu,
}: {
  icon: ReactNode;
  label: string;
  badge: string;
  selected: boolean;
  testId: string;
  /** Key used by the inventory drag; the row is not draggable without it. */
  dragKey?: string;
  /** This row's menu is the one currently open. */
  menuOpen?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onOpenMenu?: (anchor: PopoverAnchor) => void;
}) {
  const t = useT();

  return (
    <div
      className="side-row-wrap"
      data-drag-key={dragKey}
      data-selected={selected ? 'true' : undefined}
    >
      <button
        type="button"
        className="side-row"
        data-testid={testId}
        data-tip={label}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onOpen();
          }
        }}
        onContextMenu={(event) => {
          if (!onOpenMenu) return;
          event.preventDefault();
          onOpenMenu({ x: event.clientX, y: event.clientY, origin: 'top left' });
        }}
      >
        <span className="side-row-icon">{icon}</span>
        <span className="side-row-title">{label}</span>
        <span className="side-badge">{badge}</span>
      </button>
      {onOpenMenu ? (
        <button
          type="button"
          className="side-more"
          data-no-drag
          data-open={menuOpen ? 'true' : undefined}
          aria-label={t('sidebar.more')}
          data-tip={t('sidebar.more')}
          onClick={(event) => {
            event.stopPropagation();
            onOpenMenu(menuAnchor(event.currentTarget));
          }}
        >
          <IconEllipsis size={14} />
        </button>
      ) : null}
    </div>
  );
}

function WorkspaceBlock({
  workspace,
  profiles,
  renaming,
  selectedKey,
  onSelectKey,
  menuTarget,
  onOpenSsh,
  onOpenMenu,
  onCommitRename,
  onCancelRename,
}: {
  workspace: WorkspaceGroup;
  profiles: SshProfile[];
  renaming: boolean;
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
  onOpenSsh: (profile: SshProfile) => void;
  onOpenMenu: (target: SidebarMenuTarget, anchor: PopoverAnchor) => void;
  /** The row menu that is open right now, so its trigger can stay lit. */
  menuTarget: SidebarMenuTarget | null;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const rows = workspaceProfiles(workspace, profiles);

  return (
    <div className="ws" data-open={open ? 'true' : 'false'}>
      <div className="side-row-wrap ws-head-wrap" data-drag-target={listIdOfWorkspace(workspace.id)}>
        {renaming ? (
          <RenameField
            className="side-rename ws-rename"
            value={workspace.name}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <button
            type="button"
            className="side-row ws-head"
            aria-expanded={open}
            data-tip={workspace.name}
            onClick={() => setOpen((current) => !current)}
            onContextMenu={(event) => {
              event.preventDefault();
              onOpenMenu(
                { kind: 'workspace', workspaceId: workspace.id },
                { x: event.clientX, y: event.clientY, origin: 'top left' },
              );
            }}
          >
            <span className="ws-chevron" aria-hidden="true">
              <IconChevronDown size={12} />
            </span>
            <span className="side-row-icon">
              <IconFolder size={15} />
            </span>
            <span className="side-row-title">{workspace.name}</span>
          </button>
        )}
        <div className="ws-actions">
          <button
            type="button"
            className="side-more"
            data-open={
              menuTarget?.kind === 'workspace' && menuTarget.workspaceId === workspace.id ? 'true' : undefined
            }
            aria-label={t('workspace.menu')}
            data-tip={t('workspace.menu')}
            onClick={(event) => {
              event.stopPropagation();
              onOpenMenu({ kind: 'workspace', workspaceId: workspace.id }, menuAnchor(event.currentTarget));
            }}
          >
            <IconEllipsis size={14} />
          </button>
        </div>
      </div>

      {open ? (
        rows.length === 0 ? (
          <p className="side-empty side-empty-child">{t('workspace.empty')}</p>
        ) : (
          <div className="ws-body" data-drag-list={listIdOfWorkspace(workspace.id)}>
            {rows.map((profile) => (
              <EntryRow
                key={profile.id}
                testId="sidebar-entry-ssh"
                dragKey={`ssh:${profile.id}`}
                icon={<SshHostIcon profile={profile} size={15} terminalSize={14} />}
                label={sshProfileTitle(profile)}
                badge="SSH"
                selected={selectedKey === `ssh:${workspace.id}:${profile.id}`}
                menuOpen={
                  menuTarget?.kind === 'profile' &&
                  menuTarget.workspaceId === workspace.id &&
                  menuTarget.profileId === profile.id
                }
                onSelect={() => onSelectKey(`ssh:${workspace.id}:${profile.id}`)}
                onOpen={() => onOpenSsh(profile)}
                onOpenMenu={(anchor) =>
                  onOpenMenu({ kind: 'profile', workspaceId: workspace.id, profileId: profile.id }, anchor)
                }
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Left rail: an inventory of entry points, not a list of running sessions.
 *
 * "Sessions" holds everything that is not grouped - local shells, WSL
 * distributions and saved hosts without a workspace. "Workspaces" holds named
 * groups of saved hosts. Both are launchers: a row opens a new tab when double
 * clicked, while the tab strip stays the only place that shows what is actually
 * running. A Sessions row can also be dragged: the order is the user's.
 * the tab strip stays the only place that shows what is actually running.
 */
export function Sidebar({
  demo,
  shells,
  wslDistributions,
  profiles,
  workspaces,
  sessionOrder,
  renamingWorkspaceId,
  menuTarget,
  newSessionMenuOpen,
  onNewSession,
  onOpenLocal,
  onInventoryDrop,
  onOpenWsl,
  onOpenSsh,
  onOpenMenu,
  onNewWorkspace,
  onCommitWorkspaceRename,
  onCancelWorkspaceRename,
  onOpenSettings,
}: SidebarProps) {
  const t = useT();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  /*
   * One list, three sources. The user's order names rows by key; anything it
   * does not name keeps the natural order (shells, then WSL, then hosts) and
   * lands after the arranged rows, so a new entry never displaces an order the
   * user built by hand.
   */
  const entries = useMemo<SessionEntry[]>(() => {
    const grouped = new Set(workspaces.flatMap((workspace) => workspace.profileIds));
    const natural: SessionEntry[] = [
      ...shells.map(
        (profile): SessionEntry => ({ key: `local:${profile.id}`, kind: 'local', profile }),
      ),
      ...wslDistributions.map(
        (distribution): SessionEntry => ({ key: `wsl:${distribution}`, kind: 'wsl', distribution }),
      ),
      ...profiles
        .filter((profile) => !grouped.has(profile.id))
        .map((profile): SessionEntry => ({ key: `ssh:${profile.id}`, kind: 'ssh', profile })),
    ];
    if (sessionOrder.length === 0) return natural;
    const rank = new Map(sessionOrder.map((key, index) => [key, index]));
    const unranked = Number.MAX_SAFE_INTEGER;
    return natural.sort(
      (left, right) => (rank.get(left.key) ?? unranked) - (rank.get(right.key) ?? unranked),
    );
  }, [profiles, sessionOrder, shells, wslDistributions, workspaces]);

  /*
   * Every workspace's host list, as keys, for the drag. Collapsed workspaces
   * still appear here: their header is a drop target even with no rows to show.
   */
  const inventoryWorkspaces = useMemo(
    () =>
      workspaces.map((workspace) => ({
        id: workspace.id,
        keys: workspaceProfiles(workspace, profiles).map((profile) => `ssh:${profile.id}`),
      })),
    [profiles, workspaces],
  );

  const drag = useInventoryDrag({
    sessions: entries.map((entry) => entry.key),
    workspaces: inventoryWorkspaces,
    // Only saved hosts belong in a workspace; a local shell or a WSL
    // distribution stays in Sessions, where it was launched from.
    accepts: (listId, dragKey) => listId === SESSIONS_LIST_ID || dragKey.startsWith('ssh:'),
    // Blocks that change position when a list above them grows or shrinks.
    flipSelector: '.ws, .side-head',
    onDrop: onInventoryDrop,
  });

  const sessionsEmpty = entries.length === 0;

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="titlebar sidebar-brand">
          <span className="brand-tile" aria-hidden="true">
            <BrandMark size={20} />
          </span>
          <span className="brand-name">{t('app.name')}</span>
          {demo ? (
            <span className="demo-badge" data-tip={t('demo.badge')}>
              {t('demo.badge')}
            </span>
          ) : null}
        </div>
      </header>

      <div className="sidebar-scroll" onPointerDown={drag.onPointerDown}>
        <section className="side-section" data-section="sessions">
          <div className="side-head">
            <h2 className="side-title">{t('sidebar.sessions')}</h2>
            <button
              type="button"
              className="side-add"
              data-testid="sidebar-new-session"
              aria-label={t('sidebar.newSession')}
              data-tip={t('sidebar.newSession')}
              aria-haspopup="menu"
              aria-expanded={newSessionMenuOpen}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onNewSession({ x: rect.right + 10, y: rect.top - 6, origin: 'top right' });
              }}
            >
              <IconPlus size={15} />
            </button>
          </div>

          {sessionsEmpty ? (
            <div className="side-empty">
              <p className="side-empty-title">{t('sidebar.sessionsEmpty')}</p>
              <p className="side-empty-hint">{t('sidebar.sessionsEmptyHint')}</p>
            </div>
          ) : (
            <div className="side-list" data-drag-list={SESSIONS_LIST_ID}>
              {entries.map((entry) => {
                if (entry.kind === 'local') {
                  const brand = shellBrand(entry.profile);
                  return (
                    <EntryRow
                      key={entry.key}
                      testId="sidebar-entry-local"
                      dragKey={entry.key}
                      icon={
                        brand === 'powershell' ? (
                          <IconPowershell size={16} />
                        ) : brand === 'cmd' ? (
                          <IconCmd size={16} />
                        ) : (
                          <IconTerminal size={15} />
                        )
                      }
                      label={entry.profile.label}
                      badge={brand === 'powershell' ? 'PowerShell' : brand === 'cmd' ? 'CMD' : 'Local'}
                      selected={selectedKey === entry.key}
                      onSelect={() => setSelectedKey(entry.key)}
                      onOpen={() => onOpenLocal(entry.profile.id)}
                    />
                  );
                }
                if (entry.kind === 'wsl') {
                  return (
                    <EntryRow
                      key={entry.key}
                      testId="sidebar-entry-wsl"
                      dragKey={entry.key}
                      icon={<DistroIcon distribution={entry.distribution} size={16} />}
                      label={entry.distribution}
                      badge="WSL"
                      selected={selectedKey === entry.key}
                      onSelect={() => setSelectedKey(entry.key)}
                      onOpen={() => onOpenWsl(entry.distribution)}
                    />
                  );
                }
                const profile = entry.profile;
                return (
                  <EntryRow
                    key={entry.key}
                    testId="sidebar-entry-ssh"
                      dragKey={entry.key}
                    icon={<SshHostIcon profile={profile} size={16} terminalSize={15} />}
                    label={sshProfileTitle(profile)}
                    badge="SSH"
                    selected={selectedKey === entry.key}
                    menuOpen={
                      menuTarget?.kind === 'profile' &&
                      !menuTarget.workspaceId &&
                      menuTarget.profileId === profile.id
                    }
                    onSelect={() => setSelectedKey(entry.key)}
                    onOpen={() => onOpenSsh(profile)}
                    onOpenMenu={(anchor) =>
                      onOpenMenu({ kind: 'profile', profileId: profile.id }, anchor)
                    }
                  />
                );
              })}
            </div>
          )}
        </section>

        <section className="side-section" data-section="workspaces">
          <div className="side-head">
            <h2 className="side-title">{t('sidebar.workspaces')}</h2>
            <button
              type="button"
              className="side-add"
              data-testid="sidebar-new-workspace"
              aria-label={t('sidebar.newWorkspace')}
              data-tip={t('sidebar.newWorkspace')}
              onClick={onNewWorkspace}
            >
              <IconPlus size={15} />
            </button>
          </div>

          {workspaces.length === 0 ? (
            <div className="side-empty">
              <p className="side-empty-title">{t('sidebar.workspacesEmpty')}</p>
              <p className="side-empty-hint">{t('sidebar.workspacesEmptyHint')}</p>
            </div>
          ) : (
            <div className="side-list">
              {workspaces.map((workspace) => (
                <WorkspaceBlock
                  key={workspace.id}
                  workspace={workspace}
                  profiles={profiles}
                  renaming={workspace.id === renamingWorkspaceId}
                  selectedKey={selectedKey}
                  menuTarget={menuTarget}
                  onSelectKey={setSelectedKey}
                  onOpenSsh={onOpenSsh}
                  onOpenMenu={onOpenMenu}
                  onCommitRename={(name) => onCommitWorkspaceRename(workspace.id, name)}
                  onCancelRename={onCancelWorkspaceRename}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <footer className="sidebar-foot">
        <button type="button" className="foot-button" onClick={onOpenSettings}>
          <IconSettings size={16} />
          <span className="foot-label">{t('sidebar.settings')}</span>
        </button>
      </footer>
    </aside>
  );
}
