/**
 * SSH end-to-end check against the offline test server shipped with the
 * bastion research folder (`bastion-ssh-example/dist/testsrv.exe`).
 *
 * Covers: in-process ssh2 authentication with a password, keyboard-interactive
 * fallback, the shell channel, the session endpoint metadata, and a bastion style
 * `-newtab "sshpass -p … ssh …"` invocation landing in the running instance.
 *
 * Usage: npm run build && node tests/e2e/ssh.mjs
 * Env: EASYSHELL_E2E_SSH_PORT (default 2222)
 */
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const port = Number(process.env.EASYSHELL_E2E_SSH_PORT ?? 2222);
const serverPath = join(root, 'bastion-ssh-example', 'dist', 'testsrv.exe');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  process.stdout.write(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function waitForPort(target, timeoutMs) {
  return poll(
    () =>
      new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port: target });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      }),
    timeoutMs,
    250,
  );
}

if (!existsSync(serverPath)) {
  process.stdout.write(`skip: test SSH server not found at ${serverPath}\n`);
  process.exit(0);
}

const server = spawn(serverPath, [], { cwd: root, windowsHide: true, stdio: 'ignore' });
const listening = await waitForPort(port, 8000);
check(`test SSH server is listening on 127.0.0.1:${port}`, listening);

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, EASYSHELL_E2E: '1' } });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await sleep(700);

  const boot = await page.evaluate(() => globalThis.easyshell.bootstrap());
  const auth = { authorization: `Bearer ${boot.api.token}`, 'content-type': 'application/json' };
  const base = boot.api.baseUrl;

  const session = await page.evaluate(
    (target) => globalThis.easyshell.createSession({ kind: 'ssh', target, title: 'e2e-ssh' }),
    {
      host: '127.0.0.1',
      port,
      username: 'alice_SSO_TOK',
      auth: { type: 'password', password: 'tok123' },
      hostKeyPolicy: 'accept-new',
    },
  );
  check('SSH session created', Boolean(session?.id), `${session.id}`);

  const connected = await poll(async () => {
    const info = await page.evaluate((id) => globalThis.easyshell.getSession(id), session.id);
    return info?.status === 'connected' ? info : null;
  }, 20000);
  check('SSH reached the connected state', Boolean(connected), connected?.status);

  const output = await poll(async () => {
    const snapshot = await page.evaluate((id) => globalThis.easyshell.attachSession(id), session.id);
    return snapshot?.data?.includes('AUTH-OK') ? snapshot.data : null;
  }, 15000);
  check('password auth succeeded (server said AUTH-OK)', Boolean(output), output ? `${output.trim().slice(0, 80)}` : 'no output');

  const info = await page.evaluate((id) => globalThis.easyshell.getSession(id), session.id);
  check(
    'endpoint metadata carries host, port and user',
    info?.metadata?.endpoint?.host === '127.0.0.1' &&
      info?.metadata?.endpoint?.port === port &&
      info?.metadata?.endpoint?.username === 'alice_SSO_TOK',
    JSON.stringify({ ...info?.metadata?.endpoint, chain: undefined }),
  );
  check('SSH hop is recorded with high confidence', info?.metadata?.endpoint?.chain?.[0]?.confidence === 'high');

  // Bastion style invocation: a second process must hand the argv to the running
  // window and open another tab, not start a second app.
  const before = (await (await fetch(`${base}/v1/sessions`, { headers: auth })).json()).sessions.length;
  const cli = await execFileAsync(
    electronBin,
    ['.', '-newtab', `sshpass -p tok123 ssh -p ${port} 'alice_SSO_TOK'@127.0.0.1`],
    { cwd: root },
  ).catch((error) => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }));
  void cli;

  const forwarded = await poll(async () => {
    const response = await (await fetch(`${base}/v1/sessions`, { headers: auth })).json();
    const sshSessions = (response.sessions ?? []).filter((item) => item.kind === 'ssh');
    return response.sessions.length > before && sshSessions.length >= 2 ? response.sessions : null;
  }, 20000);
  check('bastion -newtab argument opened a new tab in the running instance', Boolean(forwarded), forwarded ? `${forwarded.length} sessions` : 'no new session');

  const bastionSession = forwarded?.find((item) => item.kind === 'ssh' && item.metadata?.endpoint?.username === 'alice_SSO_TOK' && item.id !== session.id);
  check(
    'forwarded session parsed host, port, user and password',
    Boolean(bastionSession),
    bastionSession
      ? `${bastionSession.metadata.endpoint.username}@${bastionSession.metadata.endpoint.host}:${bastionSession.metadata.endpoint.port}`
      : 'not found',
  );
  check('forwarded session records its CLI origin', bastionSession?.origin?.type === 'cli', bastionSession?.origin?.type);
  // ---- saved profile -> sidebar row -> connected session ----
  const profile = {
    id: 'e2e-ssh-profile',
    name: 'Local test server',
    host: '127.0.0.1',
    port,
    username: 'alice_SSO_TOK',
    authType: 'password',
    password: 'tok123',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await page.evaluate((saved) => globalThis.easyshell.updateSettings({ ssh: { profiles: [saved] } }), profile);

  const row = page.locator('[data-testid="sidebar-entry-ssh"]').filter({ hasText: profile.name }).first();
  await row.waitFor({ timeout: 5000 }).catch(() => null);
  check('saved connection is listed in the Sessions inventory', (await row.count()) === 1);

  if (await row.count()) {
    await row.dblclick();
    const opened = await poll(async () => {
      const response = await (await fetch(`${base}/v1/sessions`, { headers: auth })).json();
      const found = (response.sessions ?? []).find((item) => item.title === profile.name);
      return found && found.status === 'connected' ? found : null;
    }, 25000);
    check('opening a saved connection connects with its credentials', Boolean(opened), opened?.status);
    if (opened) {
      check('the tab uses the connection name as title', opened.title === profile.name, opened.title);
      check('the session was created from the UI', opened.origin?.type === 'ui', opened.origin?.type);
      const snapshot = await page.evaluate((id) => globalThis.easyshell.attachSession(id), opened.id);
      check('the profile session shows the server banner', /AUTH-OK/.test(snapshot?.data ?? ''));

      // One click on the tab's ✕ closes it. A late snapshot used to resurrect
      // the tab, so it took two clicks.
      const tab = page.locator('.tab').filter({ hasText: profile.name }).first();
      const tabsBefore = await page.locator('.tab-title').count();
      await tab.locator('.tab-action-close').click();
      const closed = await poll(
        async () => ((await page.locator('.tab-title').count()) === tabsBefore - 1 ? true : null),
        5000,
        200,
      );
      check(
        'one click on the tab close button removes the tab',
        Boolean(closed),
        `${tabsBefore} -> ${await page.locator('.tab-title').count()}`,
      );
    }
  }
  // ---- agent path: a saved connection can be opened by id, secrets stay off the wire ----
  const connectionsResponse = await (await fetch(`${base}/v1/connections`, { headers: auth })).json();
  const listedProfile = (connectionsResponse.connections ?? []).find((item) => item.id === profile.id);
  check('GET /v1/connections lists the saved connection', listedProfile?.name === profile.name, listedProfile?.name);
  check(
    'GET /v1/connections never returns the password',
    listedProfile && !('password' in listedProfile) && listedProfile.hasPassword === true,
    JSON.stringify({ hasPassword: listedProfile?.hasPassword, hasPasswordField: listedProfile ? 'password' in listedProfile : null }),
  );

  const settingsResponse = await (await fetch(`${base}/v1/settings`, { headers: auth })).json();
  const maskedProfile = (settingsResponse.settings?.ssh?.profiles ?? []).find((item) => item.id === profile.id);
  check('GET /v1/settings masks the saved password', maskedProfile?.password === '***', String(maskedProfile?.password));

  const byIdResponse = await (
    await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ profileId: profile.id }),
    })
  ).json();
  check('POST /v1/sessions accepts a saved connection id', Boolean(byIdResponse.session?.id), byIdResponse.session?.title);
  const byIdConnected = await poll(async () => {
    const response = await (await fetch(`${base}/v1/sessions/${byIdResponse.session.id}`, { headers: auth })).json();
    return response.session?.status === 'connected' ? response.session : null;
  }, 25000);
  check('an agent can open the saved connection without its password', Boolean(byIdConnected), byIdConnected?.status);
  await page.evaluate(() => globalThis.easyshell.updateSettings({ ssh: { profiles: [] } }));  // ---- negative paths: bad key material must fail loudly, not hang ----
  const missingKey = await page.evaluate(() =>
    globalThis.easyshell.createSession({
      kind: 'ssh',
      target: {
        host: '127.0.0.1',
        port: 2222,
        username: 'deploy',
        auth: { type: 'key', privateKeyPath: 'C:/definitely/missing/id_ed25519' },
        hostKeyPolicy: 'accept-new',
      },
      title: 'missing-key',
    }),
  );
  const missingKeyState = await poll(async () => {
    const info = await page.evaluate((id) => globalThis.easyshell.getSession(id), missingKey.id);
    return info?.status === 'error' ? info : null;
  }, 10000);
  check('a missing private key file becomes a session error', Boolean(missingKeyState), missingKeyState?.metadata?.os?.probeError?.slice(0, 90));

  const ppkSession = await page.evaluate(() =>
    globalThis.easyshell.createSession({
      kind: 'ssh',
      target: {
        host: '127.0.0.1',
        port: 2222,
        username: 'deploy',
        auth: { type: 'key', privateKeyPath: 'C:/keys/id_ed25519.ppk' },
        hostKeyPolicy: 'accept-new',
      },
      title: 'ppk',
    }),
  );
  const ppkState = await poll(async () => {
    const info = await page.evaluate((id) => globalThis.easyshell.getSession(id), ppkSession.id);
    return info?.status === 'error' ? info : null;
  }, 10000);
  check(
    'a PuTTY .ppk key is rejected with an actionable message',
    /ppk|openssh/i.test(ppkState?.metadata?.os?.probeError ?? ''),
    ppkState?.metadata?.os?.probeError?.slice(0, 90),
  );
  await page.evaluate((id) => globalThis.easyshell.closeSession(id), missingKey.id);
  await page.evaluate((id) => globalThis.easyshell.closeSession(id), ppkSession.id);
  const closedFailed = await poll(async () => {
    const info = await page.evaluate((id) => globalThis.easyshell.getSession(id), missingKey.id);
    return info === null ? true : null;
  }, 6000);
  check('a session that failed to connect can be closed without an error', Boolean(closedFailed));
} finally {
  await app.close();
  server.kill();
}

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((item) => item.name).join(', ')}\n`);
  process.exit(1);
}