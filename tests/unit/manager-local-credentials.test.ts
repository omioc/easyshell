import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../../src/main/settings';
import type { SessionEvent, Settings, SshCredential } from '../../src/shared/types';

/**
 * The password vault, driven from a local tab.
 *
 * A Windows PowerShell or `cmd` tab is where a login is usually typed first, and
 * its own prompt (`PS C:\Users\alice> `) names no account: the first
 * `user@host` prompt painted in that tab is the machine the user just logged in
 * to. Nothing about that login is on the chain, but the password that got
 * through it is worth offering to keep — which is what these cases watch.
 *
 * There is no pty here: `startLocalSession` is replaced by a backend that lets
 * the test play both sides of the terminal.
 */
const hoisted = vi.hoisted(() => ({
  events: [] as SessionEvent[],
  writes: [] as string[],
  handlers: null as null | { onData: (chunk: string) => void; onStatus: (status: string) => void },
  /** What the app asked the settings store to remember. */
  saved: [] as SshCredential[],
}));

vi.mock('../../src/main/session/local', () => ({
  planSession: () => ({
    kind: 'local',
    label: 'pwsh.exe',
    file: 'pwsh.exe',
    args: [],
    cwd: 'C:\\Users\\alice',
    env: {},
    posix: false,
  }),
  startLocalSession: async (_plan: unknown, handlers: unknown) => {
    hoisted.handlers = handlers as never;
    (handlers as { onStatus: (status: 'connected') => void }).onStatus('connected');
    return {
      kind: 'local',
      posixShell: false,
      write: (data: string) => hoisted.writes.push(data),
      resize: () => undefined,
      kill: () => undefined,
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    };
  },
}));

const { SessionManager } = await import('../../src/main/session/manager');

const settings = {
  probe: { enabled: false, intervalMs: 60_000, nestedDetection: true },
  ssh: { keepAliveSeconds: 0, hostKeyPolicy: 'accept-new', profiles: [] },
  appearance: {},
  vault: { credentials: [] },
} as unknown as Settings;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOCAL_PROMPT = 'PS C:\\Users\\alice> ';
/** What `ssh` prints when the host answers with the `password` method. */
const POSSESSIVE = "\r\nalice@203.0.113.13's password: ";
/** What it prints when the host offers keyboard-interactive auth instead. */
const KEYBOARD_INTERACTIVE = '\r\n(alice@203.0.113.13) Password: ';
const INNER_PROMPT = '\r\n[alice@203.0.113.13 ~]$ ';

let opened: InstanceType<typeof SessionManager> | null = null;

async function open(vault: SshCredential[] = []): Promise<{ manager: InstanceType<typeof SessionManager>; id: string }> {
  opened?.shutdown();
  hoisted.events = [];
  hoisted.writes = [];
  hoisted.saved = [];
  hoisted.handlers = null;
  settings.vault = { credentials: vault };
  const manager = new SessionManager({
    getSettings: () => settings,
    platform: 'win32',
    homeDir: 'C:\\Users\\alice',
    knownHosts: {} as never,
    emit: (event) => hoisted.events.push(event),
    replaceCredentials: (next) => {
      hoisted.saved = next;
      // What the settings store does: the vault the rest of the app reads is the
      // list the desk just wrote.
      settings.vault = { credentials: next };
    },
  });
  const info = await manager.create({ kind: 'local', command: 'pwsh.exe', args: [] } as never);
  opened = manager;
  return { manager, id: info.id };
}

/** The pty printed something. */
function output(chunk: string): void {
  hoisted.handlers?.onData(chunk);
}

/** The user typed something. */
async function type(manager: InstanceType<typeof SessionManager>, id: string, data: string) {
  manager.write(id, data);
  await sleep(0);
}

/** Every question the app asked the user, in order. */
function questions() {
  return hoisted.events.flatMap((event) =>
    event.type === 'session-credential' && event.request ? [event.request] : [],
  );
}

describe('a password typed at a login in a local tab', () => {
  it('is offered for keeping when the prompt is the keyboard-interactive one', async () => {
    const { manager, id } = await open();
    output(LOCAL_PROMPT);
    await type(manager, id, 'ssh alice@203.0.113.13\r');
    // Debian, Ubuntu and most appliances offer this method, and `ssh` prefers
    // it: the prompt names the login in brackets rather than with an apostrophe.
    output(KEYBOARD_INTERACTIVE);
    expect(questions()).toEqual([]);

    await type(manager, id, 'correct-pass\r');
    output(INNER_PROMPT);
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({
      kind: 'save',
      username: 'alice',
      host: '203.0.113.13',
      label: 'alice@203.0.113.13',
    });

    manager.respondCredential(id, 'accept');
    expect(hoisted.saved).toHaveLength(1);
    expect(hoisted.saved[0]).toMatchObject({ username: 'alice', host: '203.0.113.13', password: 'correct-pass' });
  });

  it('is offered for keeping when the line came from the history', async () => {
    const { manager, id } = await open();
    output(LOCAL_PROMPT);
    // `↑` and Enter: the app watched the recall but could not read the line back,
    // so the prompt is the only witness of which login this is.
    await type(manager, id, '\x1b[A\r');
    output(POSSESSIVE);
    await type(manager, id, 'correct-pass\r');
    output(INNER_PROMPT);
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ kind: 'save', label: 'alice@203.0.113.13' });
  });

  it('is never offered when the login never landed', async () => {
    const { manager, id } = await open();
    output(LOCAL_PROMPT);
    await type(manager, id, 'ssh alice@203.0.113.13\r');
    output(KEYBOARD_INTERACTIVE);
    await type(manager, id, 'wrong-pass\r');
    // Refused, and the tab is back at its own prompt: nothing got through, so
    // nothing is worth keeping.
    output('\r\nPermission denied, please try again.' + KEYBOARD_INTERACTIVE);
    output('\r\n' + LOCAL_PROMPT);
    await sleep(0);

    expect(questions()).toEqual([]);
    expect(hoisted.saved).toEqual([]);
  });

  it('is answered from the vault at a prompt that names the login', async () => {
    const { manager, id } = await open([
      { id: 'cred-1', username: 'alice', host: '203.0.113.13', password: 'saved-pass', createdAt: 1, updatedAt: 1 },
    ]);
    output(LOCAL_PROMPT);
    await type(manager, id, 'ssh alice@203.0.113.13\r');
    output(KEYBOARD_INTERACTIVE);
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ kind: 'fill', label: 'alice@203.0.113.13' });

    manager.respondCredential(id, 'accept');
    expect(hoisted.writes).toEqual(['ssh alice@203.0.113.13\r', 'saved-pass\r']);
  });

  it('is offered when only the title confirms the login', async () => {
    const { manager, id } = await open();
    output(LOCAL_PROMPT);
    // `↑` and Enter: the app watched the recall and could not read the line back,
    // so no candidate exists — nothing on the chain says where this login goes.
    await type(manager, id, '\x1b[A\r');
    output(KEYBOARD_INTERACTIVE);
    await type(manager, id, 'correct-pass\r');
    // The shell on the other side paints its title, then a prompt whose `PS1`
    // names no account. The title is the only evidence that somebody got in.
    output('\x1b]0;alice@inner-host: ~\x07');
    output('\r\ninner-host:~$ ');
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ kind: 'save', label: 'alice@203.0.113.13' });
  });
});

describe('a password kept from one tab', () => {
  it('answers the prompt of the next tab', async () => {
    const { manager, id } = await open();
    output(LOCAL_PROMPT);
    await type(manager, id, 'ssh alice@203.0.113.13\r');
    output(KEYBOARD_INTERACTIVE);
    await type(manager, id, 'correct-pass\r');
    output(INNER_PROMPT);
    await sleep(0);
    expect(questions()).toHaveLength(1);

    manager.respondCredential(id, 'accept');
    expect(hoisted.saved).toHaveLength(1);
    expect(hoisted.saved[0]).toMatchObject({ username: 'alice', host: '203.0.113.13', password: 'correct-pass' });

    // A second tab, the same login: the vault is keyed by `user@host`, so the
    // prompt is answered there too.
    hoisted.events = [];
    hoisted.writes = [];
    const second = await manager.create({ kind: 'local', command: 'pwsh.exe', args: [] } as never);
    output(LOCAL_PROMPT);
    await type(manager, second.id, 'ssh alice@203.0.113.13\r');
    output(KEYBOARD_INTERACTIVE);
    await sleep(0);

    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({ kind: 'fill', label: 'alice@203.0.113.13' });
  });
});
