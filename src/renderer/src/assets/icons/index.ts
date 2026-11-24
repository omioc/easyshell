/**
 * Icon registry: every glyph in the app as a standalone SVG file.
 *
 * The files under `line/` (16 px grid, monochrome, `currentColor`), `solid/`
 * (24 px grid, heavier stroke) and `brand/` (full-colour tiles that bring their
 * own palette) are the single source of truth for the drawing itself. They are
 * imported with `?raw` so the markup rides along in the bundle instead of being
 * fetched: the Electron window loads the renderer from `file://`, where an
 * external `<use href>` is blocked and an `<img>` or CSS mask would drop the
 * `currentColor` theming that makes one glyph serve every theme.
 *
 * Add an icon by dropping a file next to its peers and registering it below; the
 * components in `../../components/Icons.tsx` only add sizing and
 * accessibility on top of these entries. See README.md in this folder.
 */

import agentSource from './line/agent.svg?raw';
import alertSource from './line/alert.svg?raw';
import arrowDownSource from './line/arrow-down.svg?raw';
import arrowRightSource from './line/arrow-right.svg?raw';
import arrowUpSource from './line/arrow-up.svg?raw';
import checkSource from './line/check.svg?raw';
import chevronDownSource from './line/chevron-down.svg?raw';
import chevronRightSource from './line/chevron-right.svg?raw';
import closeSource from './line/close.svg?raw';
import codeSource from './line/code.svg?raw';
import copySource from './line/copy.svg?raw';
import cubeSource from './line/cube.svg?raw';
import downloadSource from './line/download.svg?raw';
import ellipsisSource from './line/ellipsis.svg?raw';
import eyeSource from './line/eye.svg?raw';
import eyeOffSource from './line/eye-off.svg?raw';
import fileSource from './line/file.svg?raw';
import folderSource from './line/folder.svg?raw';
import folderPlusSource from './line/folder-plus.svg?raw';
import folderSyncSource from './line/folder-sync.svg?raw';
import infoSource from './line/info.svg?raw';
import maximizeSource from './line/maximize.svg?raw';
import minimizeSource from './line/minimize.svg?raw';
import monitorSource from './line/monitor.svg?raw';
import paletteSource from './line/palette.svg?raw';
import panelLeftSource from './line/panel-left.svg?raw';
import panelRightSource from './line/panel-right.svg?raw';
import pencilSource from './line/pencil.svg?raw';
import plusSource from './line/plus.svg?raw';
import refreshSource from './line/refresh.svg?raw';
import restoreSource from './line/restore.svg?raw';
import serverSource from './line/server.svg?raw';
import shieldCheckSource from './line/shield-check.svg?raw';
import slidersSource from './line/sliders.svg?raw';
import terminalSource from './line/terminal.svg?raw';
import trashSource from './line/trash.svg?raw';
import uploadSource from './line/upload.svg?raw';
import userSource from './line/user.svg?raw';
import handSource from './solid/hand.svg?raw';
import paperclipSource from './solid/paperclip.svg?raw';
import sendSource from './solid/send.svg?raw';
import stopSource from './solid/stop.svg?raw';
import settingsSource from './solid/settings.svg?raw';
import almaSource from './brand/alma.svg?raw';
import alpineSource from './brand/alpine.svg?raw';
import archSource from './brand/arch.svg?raw';
import centosSource from './brand/centos.svg?raw';
import cmdSource from './brand/cmd.svg?raw';
import debianSource from './brand/debian.svg?raw';
import dockerSource from './brand/docker.svg?raw';
import fedoraSource from './brand/fedora.svg?raw';
import kaliSource from './brand/kali.svg?raw';
import kylinSource from './brand/kylin.svg?raw';
import linuxSource from './brand/linux.svg?raw';
import opensuseSource from './brand/opensuse.svg?raw';
import powershellSource from './brand/powershell.svg?raw';
import rockySource from './brand/rocky.svg?raw';
import ubuntuSource from './brand/ubuntu.svg?raw';

/** Everything the React layer needs to draw one glyph. */
export interface IconSource {
  /** Inner markup of the root `<svg>`, ready to inline. */
  readonly inner: string;
  /** Root viewBox, e.g. `0 0 16 16`. */
  readonly viewBox: string;
  /** Root fill; brand tiles paint themselves element by element. */
  readonly fill: string;
  /** Root stroke: `currentColor` for the monochrome sets, `none` for brand tiles. */
  readonly stroke: string;
  /** Root stroke width in viewBox units, `undefined` when the file strokes nothing. */
  readonly strokeWidth?: number;
}

const DEFAULT_VIEW_BOX = '0 0 16 16';

/** Read the parts of the file the component needs, once, at import time. */
function read(raw: string): IconSource {
  const open = /<svg\b([^>]*)>/.exec(raw);
  const attrs = open?.[1] ?? '';
  const attr = (name: string): string | undefined =>
    new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
  const strokeWidth = attr('stroke-width');
  return {
    inner: raw.slice((open?.index ?? 0) + (open?.[0].length ?? 0), raw.lastIndexOf('</svg>')).trim(),
    viewBox: attr('viewBox') ?? DEFAULT_VIEW_BOX,
    fill: attr('fill') ?? 'none',
    stroke: attr('stroke') ?? 'none',
    strokeWidth: strokeWidth === undefined ? undefined : Number(strokeWidth),
  };
}

/** Every glyph, keyed by its kebab-case file name. */
export const iconSources = {
  'agent': read(agentSource),
  'alert': read(alertSource),
  'arrow-down': read(arrowDownSource),
  'arrow-right': read(arrowRightSource),
  'arrow-up': read(arrowUpSource),
  'check': read(checkSource),
  'chevron-down': read(chevronDownSource),
  'chevron-right': read(chevronRightSource),
  'close': read(closeSource),
  'code': read(codeSource),
  'copy': read(copySource),
  'cube': read(cubeSource),
  'download': read(downloadSource),
  'ellipsis': read(ellipsisSource),
  'eye': read(eyeSource),
  'eye-off': read(eyeOffSource),
  'file': read(fileSource),
  'folder': read(folderSource),
  'folder-plus': read(folderPlusSource),
  'folder-sync': read(folderSyncSource),
  'info': read(infoSource),
  'maximize': read(maximizeSource),
  'minimize': read(minimizeSource),
  'monitor': read(monitorSource),
  'palette': read(paletteSource),
  'panel-left': read(panelLeftSource),
  'panel-right': read(panelRightSource),
  'pencil': read(pencilSource),
  'plus': read(plusSource),
  'refresh': read(refreshSource),
  'restore': read(restoreSource),
  'server': read(serverSource),
  'shield-check': read(shieldCheckSource),
  'sliders': read(slidersSource),
  'terminal': read(terminalSource),
  'trash': read(trashSource),
  'upload': read(uploadSource),
  'user': read(userSource),
  'hand': read(handSource),
  'paperclip': read(paperclipSource),
  'send': read(sendSource),
  'settings': read(settingsSource),
  'stop': read(stopSource),
  'alma': read(almaSource),
  'alpine': read(alpineSource),
  'arch': read(archSource),
  'centos': read(centosSource),
  'cmd': read(cmdSource),
  'debian': read(debianSource),
  'docker': read(dockerSource),
  'fedora': read(fedoraSource),
  'kali': read(kaliSource),
  'kylin': read(kylinSource),
  'linux': read(linuxSource),
  'opensuse': read(opensuseSource),
  'powershell': read(powershellSource),
  'rocky': read(rockySource),
  'ubuntu': read(ubuntuSource),
} as const;

export type IconName = keyof typeof iconSources;
