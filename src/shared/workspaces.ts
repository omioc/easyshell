/**
 * Workspaces: named groups of saved SSH connections.
 *
 * A workspace never owns a session by itself; it groups connections so a set of
 * hosts can be opened together. The rules live here so the renderer, the host
 * process and the unit tests agree on what a workspace is.
 */

import type { SshProfile, WorkspaceGroup } from './types';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const id = text(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function createWorkspace(partial: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return {
    id: text(partial.id) || `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: text(partial.name),
    profileIds: uniqueIds(partial.profileIds),
  };
}

/** Repairs whatever is in `settings.json` into a usable list. */
export function normalizeWorkspaces(input: unknown): WorkspaceGroup[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: WorkspaceGroup[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const workspace = createWorkspace(item as Partial<WorkspaceGroup>);
    let id = workspace.id;
    while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    seen.add(id);
    result.push({ ...workspace, id });
  }
  return result;
}

/** Every saved profile that belongs to the workspace, in stored order. */
export function workspaceProfiles(
  workspace: WorkspaceGroup | null | undefined,
  profiles: SshProfile[],
): SshProfile[] {
  if (!workspace) return [];
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return workspace.profileIds
    .map((id) => byId.get(id))
    .filter((profile): profile is SshProfile => Boolean(profile));
}

export function appendProfilesToWorkspace(
  workspaces: WorkspaceGroup[],
  id: string,
  profileIds: string[],
): WorkspaceGroup[] {
  return workspaces.map((workspace) =>
    workspace.id === id
      ? { ...workspace, profileIds: uniqueIds([...workspace.profileIds, ...profileIds]) }
      : workspace,
  );
}

export function updateWorkspace(
  workspaces: WorkspaceGroup[],
  id: string,
  patch: Partial<Omit<WorkspaceGroup, 'id'>>,
): WorkspaceGroup[] {
  return workspaces.map((workspace) =>
    workspace.id === id
      ? {
          ...workspace,
          ...patch,
          name: patch.name !== undefined ? text(patch.name) : workspace.name,
          profileIds:
            patch.profileIds !== undefined ? uniqueIds(patch.profileIds) : workspace.profileIds,
        }
      : workspace,
  );
}

export function removeWorkspace(workspaces: WorkspaceGroup[], id: string): WorkspaceGroup[] {
  return workspaces.filter((workspace) => workspace.id !== id);
}

/** Drops a profile from every workspace, used when a connection is deleted. */
export function detachProfileFromWorkspaces(
  workspaces: WorkspaceGroup[],
  profileId: string,
): WorkspaceGroup[] {
  return workspaces.map((workspace) =>
    workspace.profileIds.includes(profileId)
      ? { ...workspace, profileIds: workspace.profileIds.filter((id) => id !== profileId) }
      : workspace,
  );
}

/** Drops profile ids that no longer exist so the UI never renders a phantom row. */
export function pruneWorkspaces(workspaces: WorkspaceGroup[], profiles: SshProfile[]): WorkspaceGroup[] {
  const known = new Set(profiles.map((profile) => profile.id));
  return workspaces.map((workspace) => {
    const profileIds = workspace.profileIds.filter((id) => known.has(id));
    return profileIds.length === workspace.profileIds.length
      ? workspace
      : { ...workspace, profileIds };
  });
}

/** A name that does not collide with the existing workspaces. */
export function nextWorkspaceName(workspaces: WorkspaceGroup[], base: string): string {
  const taken = new Set(workspaces.map((workspace) => workspace.name));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 999; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}
