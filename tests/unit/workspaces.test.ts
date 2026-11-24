import { describe, expect, it } from 'vitest';
import { createSshProfile } from '../../src/shared/profiles';
import {
  appendProfilesToWorkspace,
  createWorkspace,
  detachProfileFromWorkspaces,
  nextWorkspaceName,
  normalizeWorkspaces,
  pruneWorkspaces,
  removeWorkspace,
  updateWorkspace,
  workspaceProfiles,
} from '../../src/shared/workspaces';
import { normalizeSettings } from '../../src/main/settings';
import { createDefaultSettings } from '../../src/shared/defaults';

const profile = (id: string) => createSshProfile({ id, name: id, host: `${id}.example`, username: 'root' });

describe('normalizeWorkspaces', () => {
  it('drops junk and keeps a usable list', () => {
    const list = normalizeWorkspaces([
      null,
      'nope',
      { id: 'a', name: '  Core  ', profileIds: ['p1', 'p1', '', 42] },
      { name: '' },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'a', name: 'Core', profileIds: ['p1'] });
    expect(list[1]?.name).toBe('');
    expect(list[1]?.id).toBeTruthy();
  });

  it('returns an empty list for a missing field', () => {
    expect(normalizeWorkspaces(undefined)).toEqual([]);
  });

  it('repairs duplicate ids instead of dropping the workspace', () => {
    const list = normalizeWorkspaces([
      { id: 'same', name: 'One', profileIds: [] },
      { id: 'same', name: 'Two', profileIds: [] },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).not.toBe(list[1]?.id);
  });
});

describe('workspace helpers', () => {
  it('creates a workspace with an id', () => {
    const workspace = createWorkspace({ name: 'Lab' });
    expect(workspace.id).toMatch(/^ws-/);
    expect(workspace.profileIds).toEqual([]);
  });

  it('resolves profiles in stored order and skips unknown ids', () => {
    const workspace = createWorkspace({ name: 'Lab', profileIds: ['b', 'gone', 'a'] });
    expect(workspaceProfiles(workspace, [profile('a'), profile('b')]).map((item) => item.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('appends without duplicating', () => {
    const list = [createWorkspace({ id: 'w', name: 'W', profileIds: ['a'] })];
    const next = appendProfilesToWorkspace(list, 'w', ['b', 'a']);
    expect(next[0]?.profileIds).toEqual(['a', 'b']);
  });

  it('renames and removes', () => {
    const list = [createWorkspace({ id: 'w', name: 'W' }), createWorkspace({ id: 'v', name: 'V' })];
    expect(updateWorkspace(list, 'w', { name: '  Renamed ' })[0]?.name).toBe('Renamed');
    expect(removeWorkspace(list, 'w').map((item) => item.id)).toEqual(['v']);
  });

  it('detaches a profile from every workspace', () => {
    const list = [
      createWorkspace({ id: 'w', name: 'W', profileIds: ['a', 'b'] }),
      createWorkspace({ id: 'v', name: 'V', profileIds: ['a'] }),
    ];
    const next = detachProfileFromWorkspaces(list, 'a');
    expect(next[0]?.profileIds).toEqual(['b']);
    expect(next[1]?.profileIds).toEqual([]);
  });

  it('prunes ids that no longer exist', () => {
    const list = [createWorkspace({ id: 'w', name: 'W', profileIds: ['a', 'gone'] })];
    expect(pruneWorkspaces(list, [profile('a')])[0]?.profileIds).toEqual(['a']);
  });

  it('picks a free name', () => {
    const list = [createWorkspace({ name: 'Lab' }), createWorkspace({ name: 'Lab 2' })];
    expect(nextWorkspaceName(list, 'Lab')).toBe('Lab 3');
    expect(nextWorkspaceName(list, 'New')).toBe('New');
  });
});

describe('settings integration', () => {
  it('ships an empty workspace list by default', () => {
    expect(createDefaultSettings('win32').workspaces).toEqual([]);
  });

  it('normalizes stored workspaces and drops dangling profiles', () => {
    const settings = normalizeSettings(
      {
        ssh: {
          defaultPort: 22,
          hostKeyPolicy: 'accept-new',
          keepAliveSeconds: 30,
          profiles: [profile('kept')],
        },
        workspaces: [{ id: 'w', name: 'Core', profileIds: ['kept', 'missing'] }],
      },
      'win32',
    );
    expect(settings.workspaces).toHaveLength(1);
    expect(settings.workspaces[0]?.profileIds).toEqual(['kept']);
  });
});
