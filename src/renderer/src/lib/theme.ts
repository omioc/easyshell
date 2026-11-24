import { resolveScheme } from '@shared/themes';
import type { ColorScheme } from '@shared/themes';
import type { Settings, ThemeMode } from '@shared/types';

/** CSS custom property carrying each UI token. The mapping is the only place
 * that knows the variable names; components read the variables, nothing else. */
const TOKEN_VARS: ReadonlyArray<readonly [keyof ColorScheme['ui'], string]> = [
  ['canvas', '--canvas'],
  ['surface', '--surface'],
  ['elevated', '--elevated'],
  ['hover', '--hover'],
  ['border', '--border'],
  ['borderStrong', '--border-strong'],
  ['text', '--text'],
  ['textMuted', '--text-muted'],
  ['textFaint', '--text-faint'],
  ['accent', '--accent'],
  ['accentText', '--accent-text'],
  ['danger', '--danger'],
  ['warning', '--warning'],
  ['success', '--success'],
  ['accentWash', '--accent-wash'],
];

/**
 * The scheme to use right now. The theme mode wins over the OS preference, and
 * `resolveScheme` falls back to a scheme of the requested lightness when the
 * chosen scheme belongs to the other one.
 */
export function activeScheme(settings: Settings, systemDark: boolean): ColorScheme {
  const effectiveDark = effectiveDarkMode(settings.appearance.theme, systemDark);
  return resolveScheme(settings.appearance.colorScheme, effectiveDark);
}

export function effectiveDarkMode(mode: ThemeMode, systemDark: boolean): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemDark;
}

/** Writes the scheme onto `:root` as CSS variables. Called before first paint
 * and again on every scheme, mode or system-theme change. */
export function applyScheme(scheme: ColorScheme): void {
  const root = document.documentElement;
  const style = root.style;
  for (const [token, variable] of TOKEN_VARS) {
    style.setProperty(variable, scheme.ui[token]);
  }
  style.setProperty('--terminal-bg', scheme.terminal.background);
  // Text the app draws *on* a terminal-coloured surface (the paste preview, the
  // appearance sample) needs the terminal's own foreground: `--text` is tuned
  // for the sheet, and on a dark terminal card in a light scheme it disappears.
  style.setProperty('--terminal-fg', scheme.terminal.foreground);
  // Shadows and scrims are not part of the shared token set: derive them from
  // the scheme's lightness instead of hardcoding a colour per component.
  style.setProperty(
    '--shadow-color',
    scheme.mode === 'dark' ? 'rgba(0, 0, 0, 0.45)' : 'rgba(30, 30, 40, 0.14)',
  );
  style.setProperty(
    '--scrim',
    scheme.mode === 'dark' ? 'rgba(8, 9, 11, 0.55)' : 'rgba(60, 60, 70, 0.18)',
  );
  root.style.colorScheme = scheme.mode;
  root.dataset.schemeMode = scheme.mode;
  root.dataset.scheme = scheme.id;
}
