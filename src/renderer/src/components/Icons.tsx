import logoUrl from '../assets/brand/logo.png';
import { iconSources, type IconName, type IconSource } from '../assets/icons';

export interface IconProps {
  /** Rendered square size in px. Icons are drawn on a 16px or 24px grid. */
  size?: number;
  className?: string;
}

/**
 * Draw one entry of the icon registry.
 *
 * Everything that decides how the glyph looks — the viewBox, the paint, the
 * stroke weight, the geometry itself — is read from the SVG file in
 * `assets/icons`. This component only chooses the box it is drawn in and adds
 * the accessibility plumbing every icon in the app shares, so a redrawn icon
 * never needs a matching change in React.
 */
function Glyph({ source, size = 16, className }: IconProps & { source: IconSource }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={source.viewBox}
      fill={source.fill}
      stroke={source.stroke}
      strokeWidth={source.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: source.inner }}
    />
  );
}

/** Bind one registry entry to a component so call sites can stay declarative. */
function icon(name: IconName) {
  return function Icon(props: IconProps) {
    return <Glyph source={iconSources[name]} {...props} />;
  };
}

/* ------------------------------------------------------- line, 16px grid */

export const IconAgent = icon('agent');
export const IconAlert = icon('alert');
export const IconArrowDown = icon('arrow-down');
export const IconArrowRight = icon('arrow-right');
export const IconArrowUp = icon('arrow-up');
export const IconCheck = icon('check');
export const IconChevronDown = icon('chevron-down');
export const IconChevronRight = icon('chevron-right');
export const IconClose = icon('close');
export const IconCode = icon('code');
export const IconCopy = icon('copy');
export const IconCube = icon('cube');
export const IconDownload = icon('download');
export const IconEllipsis = icon('ellipsis');
export const IconEye = icon('eye');
export const IconEyeOff = icon('eye-off');
export const IconFile = icon('file');
export const IconFolder = icon('folder');
export const IconFolderPlus = icon('folder-plus');
export const IconFolderSync = icon('folder-sync');
export const IconInfo = icon('info');
export const IconMaximize = icon('maximize');
export const IconMinimize = icon('minimize');
export const IconMonitor = icon('monitor');
export const IconPalette = icon('palette');
export const IconPanelLeft = icon('panel-left');
export const IconPanelRight = icon('panel-right');
export const IconPencil = icon('pencil');
export const IconPlus = icon('plus');
export const IconRefresh = icon('refresh');
export const IconRestore = icon('restore');
export const IconServer = icon('server');
export const IconShieldCheck = icon('shield-check');
export const IconSliders = icon('sliders');
export const IconTerminal = icon('terminal');
export const IconTrash = icon('trash');
export const IconUpload = icon('upload');
export const IconUser = icon('user');

/* ------------------------------------------------------- solid, 24px grid */

export const IconHand = icon('hand');
export const IconPaperclip = icon('paperclip');
export const IconSend = icon('send');
export const IconSettings = icon('settings');
export const IconStop = icon('stop');

/* ------------------------------------------------- full colour brand tiles */

export const IconAlma = icon('alma');
export const IconAlpine = icon('alpine');
export const IconArch = icon('arch');
export const IconCentos = icon('centos');
export const IconCmd = icon('cmd');
export const IconDebian = icon('debian');
export const IconDocker = icon('docker');
export const IconFedora = icon('fedora');
export const IconKali = icon('kali');
export const IconKylin = icon('kylin');
export const IconLinux = icon('linux');
export const IconOpensuse = icon('opensuse');
export const IconPowershell = icon('powershell');
export const IconRocky = icon('rocky');
export const IconUbuntu = icon('ubuntu');

/**
 * Product mark: the app logo, with its canvas background keyed out so it sits on
 * any surface. Same component for the titlebar (18px) and the welcome page.
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <img
      className="brand-mark"
      data-testid="brand-mark"
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
