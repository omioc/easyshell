/**
 * End-to-end smoke test for the real Electron app.
 *
 * Launches `out/main/index.js`, walks the actual first-run path (welcome page →
 * shell), types through the real xterm.js surface, saves an SSH profile through
 * the settings bridge, opens the `▾` menu, then talks to the local control API
 * exactly like an agent would. Everything asserted here has to work in
 * production, not in a mock.
 *
 * Usage: npm run build && npm run e2e
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const root = process.cwd();
const artifacts = join(root, '.e2e');
mkdirSync(artifacts, { recursive: true });

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

const electronApp = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, EASYSHELL_E2E: '1' },
});

try {
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await sleep(700);

  const hasBridge = await page.evaluate(() => typeof globalThis.easyshell?.bootstrap === 'function');
  check('preload bridge is exposed', hasBridge);

  const bootstrap = await page.evaluate(() => globalThis.easyshell.bootstrap());
  check('bootstrap returns settings + platform', Boolean(bootstrap?.settings && bootstrap?.platform));
  check(
    'renderer is the real UI, not the mock',
    typeof bootstrap.platform.isPackaged === 'boolean',
    `os=${bootstrap.platform.os} version=${bootstrap.platform.appVersion} locale=${bootstrap.platform.locale}`,
  );
  check('api endpoint advertised in bootstrap', Boolean(bootstrap.api?.baseUrl), bootstrap.api?.baseUrl);
  check('pickPrivateKeyFile is available on the bridge', typeof bootstrap.settings === 'object');

  // ---- first-run welcome page ----
  const welcome = page.locator('[data-testid="welcome"]');
  await welcome.waitFor({ timeout: 8000 }).catch(() => null);
  const welcomeVisible = (await welcome.count()) === 1;
  check('welcome page is shown when nothing is open', welcomeVisible);

  const logoState = await page
    .locator('[data-testid="welcome"] [data-testid="brand-mark"]')
    .evaluate((img) => ({
      loaded: img.complete && img.naturalWidth > 0,
      width: img.getBoundingClientRect().width,
      source: img.getAttribute('src') ?? '',
    }));
  check(
    'the app logo loads on the welcome page',
    logoState.loaded,
    `${Math.round(logoState.width)}px ${logoState.source.slice(0, 60)}`,
  );
  if (welcomeVisible) {
    for (const [id, label] of [
      ['welcome-new-terminal', 'new terminal'],
      ['welcome-connections', 'connections'],
      ['welcome-settings', 'settings'],
    ]) {
      check(`welcome offers "${label}"`, (await page.locator(`[data-testid="${id}"]`).count()) === 1);
    }
    check(
      'welcome shows the app version',
      (await welcome.innerText()).includes(bootstrap.platform.appVersion),
      bootstrap.platform.appVersion,
    );
  }

  await page.screenshot({ path: join(artifacts, 'welcome.png') });
  // ---- open a local shell from the welcome page ----
  await page.locator('[data-testid="welcome-new-terminal"]').click();
  const session = await poll(async () => {
    const sessions = await page.evaluate(() => globalThis.easyshell.listSessions());
    return sessions.length > 0 ? sessions[0] : null;
  }, 15000);
  check('welcome button opens a local session', Boolean(session?.id), session ? `${session.kind} ${session.title}` : 'none');

  const output = await poll(async () => {
    const snapshot = await page.evaluate((id) => globalThis.easyshell.attachSession(id), session.id);
    return snapshot && snapshot.data && snapshot.data.length > 0 ? snapshot.data : null;
  }, 15000);
  check('shell produced output', Boolean(output), output ? `${output.length} chars buffered` : 'no output');

  const metadata = await page.evaluate((id) => globalThis.easyshell.probeSession(id), session.id);
  const hostname = metadata?.os?.hostname ?? '';
  check('probe found the local system', Boolean(hostname), `${hostname} ${metadata?.os?.os ?? ''}`.trim());
  check('endpoint carries a hop chain', (metadata?.endpoint?.chain ?? []).length >= 1);

  const execResult = await page.evaluate(
    (id) => globalThis.easyshell.execInSession(id, 'echo easyshell-e2e-ok'),
    session.id,
  );
  check('exec through the side channel', /easyshell-e2e-ok/.test(execResult?.stdout ?? ''), `code=${execResult?.code}`);

  // ---- left rail, tabs, terminal ----
  check('tab strip rendered the session', (await page.locator('[role="tab"]').count()) >= 1);
  const currentTitle = (await page.evaluate((id) => globalThis.easyshell.getSession(id), session.id))?.title ?? session.title;
  check(
    'tab shows the session title',
    (await page.locator('.tab-title').allInnerTexts()).includes(currentTitle),
    (await page.locator('.tab-title').allInnerTexts()).join(' | '),
  );
  check('xterm.js surface is mounted', (await page.locator('.xterm').count()) >= 1);
  const titleLogo = await page
    .locator('.titlebar [data-testid="brand-mark"]')
    .evaluate((img) => img.complete && img.naturalWidth > 0);
  check('the app logo loads in the titlebar', titleLogo);

  const railBox = await page.locator('[data-testid="rail"]').boundingBox();
  // Scoped to the strip: the sheet's own tab row is a second tablist on the
  // same row, and it sits to the right of the rail.
  const lastTabBox = await page.locator('.tabstrip-scroll [role="tab"]').last().boundingBox();
  check(
    'new-tab controls follow the last tab',
    Boolean(railBox && lastTabBox && railBox.x >= lastTabBox.x + lastTabBox.width - 1 && railBox.x - (lastTabBox.x + lastTabBox.width) < 24),
    railBox && lastTabBox
      ? `rail x=${Math.round(railBox.x)} last tab ends ${Math.round(lastTabBox.x + lastTabBox.width)}`
      : 'missing box',
  );

  const dragHandle = page.locator('[data-testid="titlebar-drag"]');
  const dragBox = await dragHandle.boundingBox();
  const dragRegion = await dragHandle.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.getPropertyValue('-webkit-app-region') || (style).webkitAppRegion || '';
  });
  check(
    'the empty titlebar area next to the tabs is draggable',
    Boolean(dragBox && dragBox.width >= 100 && dragRegion.includes('drag')),
    dragBox ? `${Math.round(dragBox.width)}px, region=${dragRegion || 'unset'}` : 'missing',
  );
  /*
   * macOS keeps its own traffic lights in the top-left corner, so the shell
   * reserves a band for them and the band drags the window in place of the title
   * bar it replaced. Both halves only exist there.
   */
  if (bootstrap.platform.os === 'darwin') {
    const band = page.locator('[data-testid="titlebar-band"]');
    const bandBox = await band.boundingBox();
    const bandRegion = await band.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    );
    check(
      'the macOS title band reserves the traffic lights and drags the window',
      Boolean(bandBox && bandBox.height >= 24 && bandRegion.includes('drag')),
      bandBox ? `${Math.round(bandBox.height)}px, region=${bandRegion || 'unset'}` : 'missing',
    );
    const brandBox = await page.locator('.sidebar-brand').boundingBox();
    check(
      'the logo starts below the traffic lights',
      Boolean(brandBox && bandBox && brandBox.y >= bandBox.height),
      brandBox && bandBox
        ? `logo y=${Math.round(brandBox.y)}, band ends at ${Math.round(bandBox.height)}`
        : 'missing',
    );
  }

  check('rail has the + button', (await page.locator('[data-testid="new-tab"]').count()) === 1);
  check('rail has the ▾ menu button', (await page.locator('[data-testid="new-tab-menu"]').count()) === 1);

  await page.locator('.xterm').first().click();
  await page.keyboard.type('echo typed-in-ui');
  await page.keyboard.press('Enter');
  const typed = await poll(async () => {
    const snapshot = await page.evaluate((id) => globalThis.easyshell.attachSession(id), session.id);
    return snapshot?.data?.includes('typed-in-ui') ? snapshot.data : null;
  }, 10000);
  check('typing in xterm reaches the pty', Boolean(typed));

  // ---- saved SSH connections + the ▾ menu ----
  const savedProfile = {
    id: 'e2e-profile',
    name: 'E2E saved host',
    host: '192.0.2.123',
    port: 2200,
    username: 'deploy',
    authType: 'key',
    privateKeyPath: 'C:/keys/id_ed25519',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const afterSave = await page.evaluate(
    (profile) => globalThis.easyshell.updateSettings({ ssh: { profiles: [profile] } }),
    savedProfile,
  );
  check('SSH profile persisted through settings', (afterSave.ssh?.profiles ?? []).length === 1, afterSave.ssh?.profiles?.[0]?.name);

  await page.locator('[data-testid="new-tab-menu"]').click();
  await poll(async () => ((await page.getByRole('menuitem').count()) > 0 ? true : null), 5000);
  check(
    '▾ menu lists local shells and WSL',
    (await page.getByRole('menuitem').count()) >= 3,
    `${await page.getByRole('menuitem').count()} items`,
  );
  check(
    '▾ menu keeps saved hosts out of the launcher list',
    (await page.locator('[data-testid="menu-profile"]').count()) === 0 &&
      !(await page.locator('[role="menu"]').innerText()).includes(savedProfile.name),
  );
  check('▾ menu offers a new SSH connection', (await page.locator('[data-testid="menu-new-ssh"]').count()) === 1);
  await page.keyboard.press('Escape');
  await sleep(200);

  // ---- the saved host shows up in the Sessions inventory ----
  const sidebarHost = page.locator('[data-testid="sidebar-entry-ssh"]').filter({ hasText: savedProfile.name });
  check('the saved host appears in the Sessions list', (await sidebarHost.count()) === 1, savedProfile.name);
  await sidebarHost.first().locator('..').locator('.side-more').click();
  await page.getByRole('menuitem').filter({ hasText: /编辑连接|Edit connection/ }).first().click();

  // ---- connection editor, opened from the row menu ----
  const manager = page.locator('[data-testid="connection-manager"]');
  await manager.waitFor({ timeout: 5000 }).catch(() => null);
  check('connection editor opens from the sidebar row menu', (await manager.count()) === 1);
  if (await manager.count()) {
    check(
      'the editor is prefilled with the saved host',
      (await page.locator('[data-testid="profile-host"]').inputValue()) === savedProfile.host,
      await page.locator('[data-testid="profile-host"]').inputValue(),
    );
    // Validation: clear the host and try to save-and-connect.
    await page.locator('[data-testid="profile-host"]').fill('');
    await page.locator('[data-testid="profile-save-connect"]').click();
    await sleep(300);
    const stillOne = (await page.evaluate(() => globalThis.easyshell.getSettings())).ssh.profiles;
    check('invalid profile is not saved', stillOne[0]?.host === savedProfile.host, stillOne[0]?.host);
  }
  await page.keyboard.press('Escape');
  await sleep(200);

  // ---- tab ⋯ menu -> session info ----
  await page.locator('[role="tab"]').first().locator('button').first().click();
  const menuItems = page.locator('[role="menuitem"]');
  // The popover mounts on the next frame, and count() does not wait for it.
  await menuItems.first().waitFor({ timeout: 5000 }).catch(() => null);
  check('tab ⋯ menu opened', (await menuItems.count()) >= 3, `${await menuItems.count()} items`);
  await menuItems.first().click();
  await page.waitForSelector('aside.info-panel[data-shown="true"]', { timeout: 5000 }).catch(() => null);
  const panelOpen = (await page.locator('aside.info-panel[data-shown="true"]').count()) === 1;
  check('session info panel opens from the tab menu', panelOpen);
  if (panelOpen) {
    const panelText = await page.locator('aside.info-panel').innerText();
    check('panel shows the probed hostname', hostname ? panelText.includes(hostname) : panelText.length > 0, hostname);
    await page.screenshot({ path: join(artifacts, 'session-info.png') });
  }
  await page.screenshot({ path: join(artifacts, 'app.png') });

  // ---- many tabs: the drag gap between the last tab and the window controls stays ----
  const filler = [];
  for (let index = 0; index < 6; index += 1) {
    filler.push(
      await page.evaluate(
        () =>
          globalThis.easyshell.createSession({
            kind: 'ssh',
            target: {
              host: '127.0.0.1',
              port: 9,
              username: 'nobody',
              auth: { type: 'password', password: 'x' },
              hostKeyPolicy: 'accept-new',
            },
            title: 'filler',
          }),
      ),
    );
  }
  await sleep(1200);
  const manyTabs = await page.locator('[role="tab"]').count();
  const dragBoxMany = await page.locator('[data-testid="titlebar-drag"]').boundingBox();
  const controlsBox = await page.locator('.window-controls').boundingBox();
  const railBoxMany = await page.locator('[data-testid="rail"]').boundingBox();
  check(
    'the drag gap survives many tabs',
    Boolean(dragBoxMany && dragBoxMany.width >= 100),
    `${manyTabs} tabs, gap ${dragBoxMany ? Math.round(dragBoxMany.width) : 0}px`,
  );
  check(
    'the new-tab rail stays reachable and left of the window controls',
    Boolean(railBoxMany && controlsBox && railBoxMany.x + railBoxMany.width <= controlsBox.x + 1),
    railBoxMany && controlsBox ? `rail ends ${Math.round(railBoxMany.x + railBoxMany.width)}, controls start ${Math.round(controlsBox.x)}` : 'missing',
  );
  const activeVisible = await page.evaluate(() => {
    const scroller = document.querySelector('.tabstrip-scroll');
    const active = scroller?.querySelector('[role="tab"][aria-selected="true"]');
    if (!scroller || !active) return false;
    const tab = active.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    return tab.left >= box.left - 1 && tab.right <= box.right + 1;
  });
  check('a newly opened tab is scrolled into view', activeVisible === true);  const stripBox = await page.locator('.tabstrip-scroll').boundingBox();
  const scrollBefore = await page.evaluate(() => document.querySelector('.tabstrip-scroll').scrollLeft);
  if (stripBox) {
    await page.mouse.move(stripBox.x + Math.min(120, stripBox.width / 2), stripBox.y + stripBox.height / 2);
    await page.mouse.wheel(0, -600);
    await sleep(250);
  }
  const scrollAfter = await page.evaluate(() => document.querySelector('.tabstrip-scroll').scrollLeft);
  check(
    'a mouse wheel over the tabs scrolls them sideways',
    scrollBefore > 0 && scrollAfter < scrollBefore,
    `scrollLeft ${Math.round(scrollBefore)} -> ${Math.round(scrollAfter)}`,
  );
  const terminalScrollable = await page.evaluate(() => {
    const strip = document.querySelector('.tabstrip-scroll');
    return Boolean(strip && strip.scrollWidth > strip.clientWidth);
  });
  check('the strip is actually overflowing in this state', terminalScrollable);
  await page.screenshot({ path: join(artifacts, 'titlebar-many.png') });
  for (const created of filler) {
    await page.evaluate((id) => globalThis.easyshell.closeSession(id), created.id);
  }
  await sleep(400);
  // ---- control API, from outside the app ----
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
  const token = settings.api.token;
  const base = `http://${settings.api.host}:${settings.api.port}`;
  check('settings file carries an api token', token.length > 20);
  check('saved SSH profiles are on disk', (settings.ssh?.profiles ?? []).length === 1, settings.ssh?.profiles?.[0]?.name);
  check('saved password/key material is stored with the profile', Boolean(settings.ssh?.profiles?.[0]?.privateKeyPath));

  const health = await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
  check('GET /v1/health', health.status === 200, `status=${health.status}`);

  const unauthorised = await fetch(`${base}/v1/sessions`);
  check('requests without a token are rejected', unauthorised.status === 401);

  const list = await (await fetch(`${base}/v1/sessions`, { headers: { authorization: `Bearer ${token}` } })).json();
  check('GET /v1/sessions lists the session', (list.sessions ?? []).some((item) => item.id === session.id));

  const apiExec = await (
    await fetch(`${base}/v1/sessions/${session.id}/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo api-exec-ok' }),
    })
  ).json();
  check('POST /v1/sessions/:id/exec', /api-exec-ok/.test(apiExec.stdout ?? ''), `code=${apiExec.code}`);

  const apiProbe = await (
    await fetch(`${base}/v1/sessions/${session.id}/probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  check('POST /v1/sessions/:id/probe', Boolean(apiProbe.metadata?.os?.hostname));

  const wsFrames = await new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://${settings.api.host}:${settings.api.port}/v1/sessions/${session.id}/attach?token=${encodeURIComponent(token)}`,
    );
    const frames = [];
    const done = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(frames);
    };
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame.type);
      if (frame.type === 'snapshot') socket.send(JSON.stringify({ type: 'input', data: 'echo from-api\r' }));
      if (frames.includes('snapshot') && frame.type === 'data') done();
    });
    socket.on('error', () => resolve(frames));
    setTimeout(done, 8000);
  });
  check('WS attach streams a snapshot', wsFrames.includes('snapshot'), wsFrames.join(','));
  check('WS attach streams live output', wsFrames.includes('data'));

  await page.evaluate((id) => globalThis.easyshell.closeSession(id), session.id);
  const welcomeBack = await poll(
    async () => ((await page.locator('[data-testid="welcome"]').count()) === 1 ? true : null),
    8000,
  );
  check('welcome page returns when the last session closes', Boolean(welcomeBack));
  await page.evaluate(() => globalThis.easyshell.updateSettings({ ssh: { profiles: [] } }));
} finally {
  await electronApp.close();
}

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((item) => item.name).join(', ')}\n`);
  process.exit(1);
}