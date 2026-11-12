/**
 * Variables du thème de Skipper injectées dans un artefact affiché comme bloc (mode `embed`), pour qu'une page qui
 * utilise `var(--cc-accent)` ou `var(--cc-fg)` soit à la bonne couleur dans les deux thèmes sans copier la palette.
 * Copie volontaire des valeurs essentielles de frontend/src/theme.css (le backend ne lit pas le bundle) : à tenir à jour
 * quand la palette change (test `embedTheme.test.ts` : les deux jeux ont les mêmes clés).
 */
export type EmbedTheme = 'light' | 'dark';

const COMMON = {
  '--cc-radius': '10px',
  '--cc-font-sans': "'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  '--cc-font-serif': "'Fraunces', Georgia, serif",
  '--cc-font-mono': "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const EMBED_THEMES: Record<EmbedTheme, Record<string, string>> = {
  light: {
    ...COMMON,
    '--cc-bg': '#f6f2ea',
    '--cc-bg-elevated': '#fffcf7',
    '--cc-bg-hover': '#efe8dd',
    '--cc-fg': '#211d18',
    '--cc-dim': '#6d655a',
    '--cc-dimmer': '#9a9184',
    '--cc-border': '#e3dbcf',
    '--cc-border-soft': '#ece5da',
    '--cc-accent': '#bf5b39',
    '--cc-accent-rgb': '191, 91, 57',
    '--cc-accent-soft': '#f5e1d8',
    '--cc-green': '#4b7a43',
    '--cc-red': '#b43f2c',
    '--cc-blue': '#3f6c8f',
    '--cc-yellow': '#a27417',
    '--cc-purple': '#6656a8',
  },
  dark: {
    ...COMMON,
    '--cc-bg': '#14110e',
    '--cc-bg-elevated': '#1c1814',
    '--cc-bg-hover': '#241f19',
    '--cc-fg': '#f1e9dd',
    '--cc-dim': '#a59a8a',
    '--cc-dimmer': '#6e6558',
    '--cc-border': '#2c261f',
    '--cc-border-soft': '#241f19',
    '--cc-accent': '#e5865f',
    '--cc-accent-rgb': '229, 134, 95',
    '--cc-accent-soft': 'rgba(229, 134, 95, 0.14)',
    '--cc-green': '#a3c78f',
    '--cc-red': '#ec7a66',
    '--cc-blue': '#8fb3d4',
    '--cc-yellow': '#e5b55c',
    '--cc-purple': '#b9a3e8',
  },
};

export const parseEmbedTheme = (v: string | null | undefined): EmbedTheme => (v === 'dark' ? 'dark' : 'light');

/** Feuille de style de base d'un bloc : variables du thème, fond transparent, marges nulles, police de Skipper. */
export function embedStyle(theme: EmbedTheme): string {
  const vars = Object.entries(EMBED_THEMES[theme])
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `:root{${vars};color-scheme:${theme}}html{background:transparent}body{margin:0;background:transparent;color:var(--cc-fg);font-family:var(--cc-font-sans);font-size:14px;line-height:1.5}`;
}
