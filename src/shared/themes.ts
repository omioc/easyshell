/**
 * Color schemes. Each scheme carries both the terminal palette (fed to xterm.js)
 * and the UI tokens (fed to CSS custom properties), so chrome and terminal never
 * drift apart when the user switches schemes.
 */

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface UiTokens {
  /** App background behind the terminal. */
  canvas: string;
  /** Tab bar and panels. */
  surface: string;
  /** Menus, dialogs, popovers. */
  elevated: string;
  /** Hover / selected rows. */
  hover: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  danger: string;
  warning: string;
  success: string;
  /** Soft accent wash for badges and status dots. */
  accentWash: string;
}

export interface ColorScheme {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  ui: UiTokens;
  terminal: TerminalPalette;
}

const darkUi: UiTokens = {
  canvas: '#0f1116',
  surface: '#161a20',
  elevated: '#1b2029',
  hover: '#212734',
  border: '#252b38',
  borderStrong: '#333a4a',
  text: '#e7eaf0',
  textMuted: '#98a1b0',
  textFaint: '#6a7382',
  accent: '#7aa2f7',
  accentText: '#0b1220',
  danger: '#f7768e',
  warning: '#e0af68',
  success: '#5ccf8a',
  accentWash: 'rgba(122, 162, 247, 0.14)',
};

/**
 * The signature look: a cool tinted canvas with white cards, a single blue
 * accent, and a dark terminal card that anchors the session.
 */
const lightUi: UiTokens = {
  canvas: '#eef2fa',
  surface: '#ffffff',
  elevated: '#ffffff',
  hover: '#f0f4fc',
  border: '#e7ecf7',
  borderStrong: '#d5deee',
  text: '#1d2433',
  textMuted: '#5a6478',
  textFaint: '#98a2b5',
  accent: '#2f6feb',
  accentText: '#ffffff',
  danger: '#dc3d43',
  warning: '#a4640b',
  success: '#1a9b62',
  accentWash: 'rgba(47, 111, 235, 0.1)',
};

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: 'easyshell',
    name: 'EasyShell',
    mode: 'dark',
    ui: darkUi,
    terminal: {
      background: '#15181f',
      foreground: '#d6d8db',
      cursor: '#7aa2f7',
      cursorAccent: '#15181f',
      selectionBackground: 'rgba(122, 162, 247, 0.26)',
      black: '#14151a',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#c8ccd4',
      brightBlack: '#6b7079',
      brightRed: '#f17c84',
      brightGreen: '#a9d68c',
      brightYellow: '#f0cd8a',
      brightBlue: '#7cc0f7',
      brightMagenta: '#d79ae8',
      brightCyan: '#74c8d3',
      brightWhite: '#f2f4f7',
    },
  },
  {
    id: 'easyshell-light',
    name: 'EasyShell Light',
    mode: 'light',
    ui: lightUi,
    terminal: {
      background: '#20242b',
      foreground: '#d8dde6',
      cursor: '#3fbf6f',
      cursorAccent: '#20242b',
      selectionBackground: 'rgba(122, 162, 247, 0.28)',
      black: '#272c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#ddb174',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#c9ced8',
      brightBlack: '#6f7885',
      brightRed: '#f17c84',
      brightGreen: '#a9d68c',
      brightYellow: '#edcd8a',
      brightBlue: '#7cc0f7',
      brightMagenta: '#d79ae8',
      brightCyan: '#74c8d3',
      brightWhite: '#f2f4f7',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    ui: {
      ...darkUi,
      canvas: '#12131a',
      surface: '#181a24',
      elevated: '#1d2030',
      hover: '#242838',
      border: '#262a3b',
      borderStrong: '#343a52',
      accent: '#7aa2f7',
      accentWash: 'rgba(122, 162, 247, 0.16)',
    },
    terminal: {
      background: '#12131a',
      foreground: '#c0caf5',
      cursor: '#7aa2f7',
      cursorAccent: '#12131a',
      selectionBackground: 'rgba(122, 162, 247, 0.25)',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#ff7a93',
      brightGreen: '#b9f27c',
      brightYellow: '#ff9e64',
      brightBlue: '#82aaff',
      brightMagenta: '#c7a9ff',
      brightCyan: '#8ee6ff',
      brightWhite: '#c0caf5',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    ui: {
      ...darkUi,
      canvas: '#2e3440',
      surface: '#333a47',
      elevated: '#3b4252',
      hover: '#434c5e',
      border: '#3f4759',
      borderStrong: '#4c566a',
      text: '#eceff4',
      textMuted: '#a9b4c6',
      accent: '#88c0d0',
      accentText: '#2e3440',
      accentWash: 'rgba(136, 192, 208, 0.16)',
    },
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(136, 192, 208, 0.24)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d08770',
      brightGreen: '#b9d3a3',
      brightYellow: '#f2d9a3',
      brightBlue: '#8fbcbb',
      brightMagenta: '#c9a4c6',
      brightCyan: '#9fd8e0',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    mode: 'dark',
    ui: {
      ...darkUi,
      canvas: '#1d2021',
      surface: '#26292b',
      elevated: '#2c2f31',
      hover: '#323537',
      border: '#3a3d3f',
      borderStrong: '#504945',
      text: '#ebdbb2',
      textMuted: '#a89984',
      accent: '#fabd2f',
      accentText: '#1d2021',
      accentWash: 'rgba(250, 189, 47, 0.16)',
    },
    terminal: {
      background: '#1d2021',
      foreground: '#ebdbb2',
      cursor: '#fabd2f',
      cursorAccent: '#1d2021',
      selectionBackground: 'rgba(250, 189, 47, 0.22)',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'matrix',
    name: 'Matrix',
    mode: 'dark',
    ui: {
      ...darkUi,
      canvas: '#08100b',
      surface: '#0d160f',
      elevated: '#111d14',
      hover: '#16261a',
      border: '#1b2e20',
      borderStrong: '#27452e',
      text: '#cdeadb',
      textMuted: '#84b894',
      accent: '#4ade80',
      accentText: '#04140a',
      accentWash: 'rgba(74, 222, 128, 0.14)',
    },
    terminal: {
      background: '#08100b',
      foreground: '#b9f6ca',
      cursor: '#4ade80',
      cursorAccent: '#08100b',
      selectionBackground: 'rgba(74, 222, 128, 0.22)',
      black: '#0c1710',
      red: '#ff6b6b',
      green: '#4ade80',
      yellow: '#e2e86b',
      blue: '#5bc0eb',
      magenta: '#c792ea',
      cyan: '#6ff7d0',
      white: '#b9f6ca',
      brightBlack: '#3f6b4c',
      brightRed: '#ff8f8f',
      brightGreen: '#7ef2a6',
      brightYellow: '#edf28a',
      brightBlue: '#84d3f5',
      brightMagenta: '#d7aef0',
      brightCyan: '#9dffe4',
      brightWhite: '#dcffe8',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    mode: 'light',
    ui: {
      ...lightUi,
      canvas: '#fdfcf9',
      surface: '#f6f4ef',
      elevated: '#ffffff',
      hover: '#efece5',
      border: '#e5e1d8',
      borderStrong: '#d3cec2',
      text: '#22201c',
      textMuted: '#6a6559',
      accent: '#b45309',
      accentWash: 'rgba(180, 83, 9, 0.1)',
    },
    terminal: {
      background: '#fdfcf9',
      foreground: '#2b2823',
      cursor: '#b45309',
      cursorAccent: '#fdfcf9',
      selectionBackground: 'rgba(180, 83, 9, 0.16)',
      black: '#2b2823',
      red: '#b91c1c',
      green: '#4d7c0f',
      yellow: '#a16207',
      blue: '#1d4ed8',
      magenta: '#9333ea',
      cyan: '#0e7490',
      white: '#ded9ce',
      brightBlack: '#6a6559',
      brightRed: '#dc2626',
      brightGreen: '#65a30d',
      brightYellow: '#ca8a04',
      brightBlue: '#2563eb',
      brightMagenta: '#a855f7',
      brightCyan: '#0891b2',
      brightWhite: '#ffffff',
    },
  },
];

export const DEFAULT_SCHEME_ID = 'easyshell';

export function findScheme(id: string): ColorScheme {
  return COLOR_SCHEMES.find((scheme) => scheme.id === id) ?? (COLOR_SCHEMES[0] as ColorScheme);
}

/** Resolves the scheme to use for a given appearance setting and system theme. */
export function resolveScheme(colorSchemeId: string, systemDark: boolean): ColorScheme {
  const requested = COLOR_SCHEMES.find((scheme) => scheme.id === colorSchemeId);
  if (requested && systemDark === (requested.mode === 'dark')) return requested;
  const fallback = COLOR_SCHEMES.find((scheme) => scheme.mode === (systemDark ? 'dark' : 'light'));
  return fallback ?? requested ?? (COLOR_SCHEMES[0] as ColorScheme);
}
