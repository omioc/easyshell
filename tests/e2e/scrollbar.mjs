/**
 * The terminal's scrollbar has to agree with the screen, always.
 *
 * It is painted by the pane from xterm's buffer position rather than from the
 * DOM scroll offset, so these checks compare the rendered thumb against that
 * position: a thumb at the bottom after a burst of output, a thumb that moves
 * with the wheel and the drag, and no native bar left over behind it.
 *
 * Usage: npm run build && npm run e2e:scrollbar
 */
import { _electron as electron } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const artifacts = join(root, '.e2e');
mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Enough output to fill the scrollback well past one screen, in any shell. */
const FLOOD =
  process.platform === 'win32'
    ? '1..400|%{"line $_ veth2@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP"}'
    : 'i=0; while [ $i -lt 400 ]; do i=$((i+1)); echo "line $i veth2@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500"; done';

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  process.stdout.write(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/*
 * The user's own EasyShell may be running, and the app allows one instance at a
 * time: `EASYSHELL_E2E_PROFILE` points the test at a throwaway profile so it can
 * run beside it, with its own settings and its own empty session list.
 */
const profile = process.env.EASYSHELL_E2E_PROFILE;
const app = await electron.launch({
  args: profile ? ['.', `--user-data-dir=${profile}`] : ['.'],
  cwd: root,
  env: { ...process.env, EASYSHELL_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await sleep(700);

  /** Everything the bar claims, and everything the screen is showing. */
  const read = () =>
    page.evaluate(() => {
      const host = document.querySelector('.terminal-host');
      if (!host) return null;
      const track = host.querySelector('.term-scroll');
      const thumb = host.querySelector('.term-scroll-thumb');
      const viewport = host.querySelector('.xterm-viewport');
      const area = host.querySelector('.xterm-scroll-area');
      const trackBox = track.getBoundingClientRect();
      const thumbBox = thumb.getBoundingClientRect();
      return {
        idle: track.dataset.idle,
        dragging: track.dataset.dragging ?? null,
        hostHeight: Math.round(host.getBoundingClientRect().height),
        trackTop: Math.round(trackBox.top),
        trackHeight: Math.round(trackBox.height),
        thumbTop: Math.round(thumbBox.top),
        thumbHeight: Math.round(thumbBox.height),
        gapBottom: Math.round(trackBox.bottom - thumbBox.bottom),
        gapTop: Math.round(thumbBox.top - trackBox.top),
        position: Number(track.getAttribute('aria-valuenow')),
        extent: Number(track.getAttribute('aria-valuemax')),
        scrollTop: Math.round(viewport.scrollTop),
        scrollTopMax: Math.round(viewport.scrollHeight - viewport.clientHeight),
        nativeBar: Math.round(viewport.offsetWidth - area.offsetWidth),
      };
    });

  const settle = async (ms = 700) => {
    await sleep(ms);
    return read();
  };

  const type = async (text) => {
    await page.locator('.xterm').first().click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };

  // ---- a shell with nothing scrolled out of view has no bar ----
  await page.locator('[data-testid="welcome-new-terminal"]').click();
  await page.locator('.xterm').first().waitFor({ timeout: 20000 });
  await sleep(2500);
  const empty = await settle(300);
  check('an idle shell shows no scrollbar', empty?.idle === 'true', `idle=${empty?.idle}`);

  // ---- the first burst of output ----
  await type(FLOOD);
  await sleep(7000);
  const first = await settle();
  check(
    'the first burst leaves the thumb at the bottom',
    first.gapBottom <= 1 && first.position === first.extent && first.extent > 0,
    `gap=${first.gapBottom}px ${first.position}/${first.extent}`,
  );
  check('the native scrollbar is gone', first.nativeBar === 0, `${first.nativeBar}px still reserved`);

  // ---- the wheel moves the buffer, and the thumb follows it ----
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -600);
  const wheeled = await settle(500);
  const travel = wheeled.trackHeight - wheeled.thumbHeight;
  const expected = Math.round((wheeled.position / Math.max(1, wheeled.extent)) * travel);
  check(
    'the wheel lifts the thumb off the bottom',
    wheeled.gapBottom > 1 && wheeled.position < wheeled.extent,
    `gap=${wheeled.gapBottom}px ${wheeled.position}/${wheeled.extent}`,
  );
  check(
    'the thumb sits where the buffer says it should',
    Math.abs(wheeled.thumbTop - wheeled.trackTop - expected) <= 2,
    `painted=${wheeled.thumbTop - wheeled.trackTop}px expected=${expected}px`,
  );

  // ---- dragging the thumb scrolls the terminal ----
  const trackBox = await page.locator('.term-scroll').boundingBox();
  const thumbBox = await page.locator('.term-scroll-thumb').boundingBox();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + 2, { steps: 8 });
  const held = await read();
  await page.mouse.up();
  const dragged = await settle(400);
  check(
    'dragging the thumb scrolls the terminal to the top of the buffer',
    dragged.gapTop <= 1 && dragged.position === 0,
    `gapTop=${dragged.gapTop}px position=${dragged.position}`,
  );
  check('the thumb reports being held', held.dragging === 'true', `data-dragging=${held.dragging}`);

  // ---- output that arrives while the pane has no layout ----
  await type(FLOOD);
  await page.locator('.sidebar-foot .foot-button').click();
  await sleep(6000);
  await page.locator('.settings-page-head .icon-button').click();
  const hidden = await settle(1200);
  check(
    'output behind the settings page still ends at the bottom',
    hidden.hostHeight > 100 && hidden.gapBottom <= 1 && hidden.position === hidden.extent,
    `host=${hidden.hostHeight}px gap=${hidden.gapBottom}px ${hidden.position}/${hidden.extent}`,
  );
  check(
    'the scroll region left behind can still scroll',
    Math.abs(hidden.scrollTop - hidden.scrollTopMax) <= 1,
    `scrollTop=${hidden.scrollTop}/${hidden.scrollTopMax}`,
  );
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -300);
  const afterHidden = await settle(500);
  check(
    'the first wheel after that scrolls instead of jumping',
    afterHidden.position > 0 && afterHidden.position < afterHidden.extent,
    `position=${afterHidden.position}/${afterHidden.extent}`,
  );

  // ---- a burst while parked at the bottom ----
  await type('echo back-to-bottom');
  await type(FLOOD);
  await sleep(7000);
  const second = await settle();
  check(
    'a later burst also ends at the bottom',
    second.gapBottom <= 1 && second.position === second.extent,
    `gap=${second.gapBottom}px ${second.position}/${second.extent}`,
  );

  await page.screenshot({ path: join(artifacts, 'scrollbar.png') });
} finally {
  await app.close();
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
