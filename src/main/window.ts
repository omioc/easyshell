import { BrowserWindow, app, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/types';

/**
 * Path of the window / taskbar icon.
 *
 * Packaged builds carry `resources/icon.png` (copied from `build/icon.png` by
 * electron-builder); dev runs point at the repo copy. Windows itself takes the
 * icon from the executable, but Linux, the taskbar entry and the macOS dock use
 * this path when the app is not packaged.
 */
export function resolveAppIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [
        join(__dirname, '../../build/icon.png'),
        join(process.cwd(), 'build/icon.png'),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

/*
 * The narrowest shell the layout still works in.
 *
 * The renderer owns these numbers - `--shell-gap`, `--sidebar-width`,
 * `--work-column-min-width` and `--sheet-width` in `tokens.css` - and the main
 * process owns the window, so the two cannot read each other's copy. They are
 * mirrored here on purpose: the window stops shrinking at exactly the width
 * where the working column reaches its own floor, with the sheet docked beside
 * it.
 */
const SHELL_GAP = 10;
const SIDEBAR_WIDTH = 268;
const WORK_COLUMN_MIN_WIDTH = 560;
const SHEET_WIDTH = 400;
const MIN_WINDOW_WIDTH =
  SHELL_GAP * 2 + // the pad the shell keeps around everything
  SIDEBAR_WIDTH +
  SHELL_GAP + // the gutter between the sidebar and the stage
  WORK_COLUMN_MIN_WIDTH +
  SHELL_GAP + // the gutter between the working column and the sheet
  SHEET_WIDTH;

/**
 * macOS only: where the traffic lights sit inside the band the renderer keeps
 * free at the top of the window. Top-left origin, measured from the window's
 * top-left corner; the buttons are 12px tall and the band is 28px, so 8px
 * centres them and leaves the logo below untouched.
 */
const MAC_TRAFFIC_LIGHTS = { x: 16, y: 8 };

export function createWindow(settings: Settings, isDev: boolean): BrowserWindow {
  const dark = settings.appearance.theme !== 'light';
  // A default or persisted size can be wider than the screen it wakes up on; a
  // window larger than the work area opens partly off-screen with no way back.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  // The floor never wins over the screen: a display too small for the whole
  // shell still gets a window that fits it, and the resize stops there.
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width);
  const window = new BrowserWindow({
    width: Math.max(minWidth, Math.min(settings.window.width, workArea.width)),
    height: Math.max(400, Math.min(settings.window.height, workArea.height)),
    x: settings.window.x,
    y: settings.window.y,
    minWidth,
    minHeight: 400,
    show: false,
    backgroundColor: dark ? '#0f1116' : '#eef2fa',
    /*
     * macOS keeps its own frame but hides the title bar, so the traffic lights
     * float over the page. They are the other half of the renderer's
     * `--titlebar-strip`: the shell leaves the top band free for them, so the
     * logo and the title never sit under them. The numbers are the native ones -
     * a 28px title bar with 12px buttons, 8px down from the top edge.
     */
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? MAC_TRAFFIC_LIGHTS : undefined,
    autoHideMenuBar: true,
    title: 'EasyShell',
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (settings.window.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}