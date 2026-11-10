import { EditorView } from '@codemirror/view';

/**
 * Accorde CodeMirror au thème de l'application (deux palettes, choisies selon `useTheme()`).
 * Les couleurs sont figées ici plutôt qu'en variables `--cc-*` : CodeMirror injecte ses propres feuilles de style,
 * et ces valeurs reprennent celles de theme.css (fonds, bordures, accent) pour chacun des deux thèmes.
 */
export const darkAppTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#1c1814', fontSize: '13px' },
    '.cm-scroller': { fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: '#1c1814', borderRight: '1px solid #2c261f', color: '#6e6558' },
    '.cm-activeLineGutter': { backgroundColor: '#241f19' },
    '.cm-activeLine': { backgroundColor: '#211c17' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#e5865f' },
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(229, 134, 95, 0.28)' },
    '.cm-placeholder': { color: '#6e6558' },
  },
  { dark: true },
);

export const lightAppTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#fffcf7', fontSize: '13px' },
    '.cm-scroller': { fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: '#f6f2ea', borderRight: '1px solid #e3dbcf', color: '#9a9184' },
    '.cm-activeLineGutter': { backgroundColor: '#efe8dd' },
    '.cm-activeLine': { backgroundColor: '#f8f3ea' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#bf5b39' },
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(191, 91, 57, 0.22)' },
    '.cm-placeholder': { color: '#9a9184' },
  },
  { dark: false },
);
