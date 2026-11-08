import * as monaco from 'monaco-editor';
import { THEMES, type Mode, type Palette } from '@shared/themes';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
        switch (label) {
            case 'json':
                return new JsonWorker();
            case 'css':
            case 'scss':
            case 'less':
                return new CssWorker();
            case 'html':
            case 'handlebars':
            case 'razor':
                return new HtmlWorker();
            case 'typescript':
            case 'javascript':
                return new TsWorker();
            default:
                return new EditorWorker();
        }
    }
};

// The built-in TypeScript worker sees only the open files, so it reports false errors for imports.
// Keep the syntax checks. The language servers will supply the real diagnostics.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

/** Syntax colors for each mode. Dark follows Ayu Dark. Light uses dark, saturated colors that are readable on a light background. */
const SYNTAX: Record<Mode, Record<string, string>> = {
    dark: {
        comment: '6c7380', keyword: 'ff8f40', string: 'aad94c', number: 'd2a6ff', type: '59c2ff', delimiter: 'bfbdb6b3',
        tag: '39bae6', attributeName: 'ffb454', regexp: '95e6cb', error: 'f07178', warning: 'e6b450'
    },
    light: {
        comment: '6e7781', keyword: 'cf222e', string: '0a3069', number: '0550ae', type: '953800', delimiter: '57606a',
        tag: '116329', attributeName: '0550ae', regexp: '116329', error: 'cf222e', warning: '9a6700'
    }
};

function hexToRgb(hex: string): [number, number, number] {
    const value = parseInt(hex.slice(1, 7), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Mixes two colors. `amount` is the part of `a`, from 0 to 1. */
function mix(a: string, b: string, amount: number): string {
    const [ra, ga, ba] = hexToRgb(a);
    const [rb, gb, bb] = hexToRgb(b);
    const channel = (x: number, y: number) => Math.round(x * amount + y * (1 - amount)).toString(16).padStart(2, '0');
    return `#${channel(ra, rb)}${channel(ga, gb)}${channel(ba, bb)}`;
}

/** Adds an alpha value (0 to 1) to a hex color. */
function alpha(hex: string, value: number): string {
    return `${hex.slice(0, 7)}${Math.round(value * 255).toString(16).padStart(2, '0')}`;
}

/**
 * Defines the "shipwarden" editor theme from a palette and applies it to all editors.
 * The editors give the theme name when they open, so the name stays the same for each palette.
 */
export function applyEditorTheme(palette: Palette, mode: Mode): void {
    const syntax = SYNTAX[mode];
    const selection = mix(palette.info, palette.bg, mode === 'dark' ? 0.28 : 0.22);
    const widget = mode === 'dark' ? mix(palette.raised, palette.bg, 0.5) : palette.raised;
    const shade = mode === 'dark' ? '#ffffff' : '#000000';
    monaco.editor.defineTheme('shipwarden', {
        base: mode === 'dark' ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
            { token: 'comment', foreground: syntax.comment, fontStyle: 'italic' },
            { token: 'keyword', foreground: syntax.keyword },
            { token: 'string', foreground: syntax.string },
            { token: 'number', foreground: syntax.number },
            { token: 'type', foreground: syntax.type },
            { token: 'type.identifier', foreground: syntax.type },
            { token: 'delimiter', foreground: syntax.delimiter },
            { token: 'tag', foreground: syntax.tag },
            { token: 'attribute.name', foreground: syntax.attributeName },
            { token: 'attribute.value', foreground: syntax.string },
            { token: 'key', foreground: syntax.type },
            { token: 'string.key.json', foreground: syntax.type },
            { token: 'string.value.json', foreground: syntax.string },
            { token: 'regexp', foreground: syntax.regexp },
            // GitHub Actions logs (the "ci-log" language).
            { token: 'ci-error', foreground: syntax.error },
            { token: 'ci-warning', foreground: syntax.warning },
            { token: 'ci-group', foreground: syntax.type, fontStyle: 'bold' },
            { token: 'ci-command', foreground: syntax.regexp },
            { token: 'ci-muted', foreground: syntax.comment }
        ],
        colors: {
            'editor.background': palette.bg,
            'editor.foreground': palette.text,
            'editorLineNumber.foreground': mix(palette.muted, palette.bg, 0.55),
            'editorLineNumber.activeForeground': palette.muted,
            'editor.lineHighlightBackground': palette.raised,
            'editor.lineHighlightBorder': '#00000000',
            'editor.selectionBackground': selection,
            'editor.inactiveSelectionBackground': alpha(selection, 0.5),
            'editor.wordHighlightBackground': alpha(shade, 0.05),
            'editor.wordHighlightStrongBackground': alpha(shade, 0.08),
            'editor.wordHighlightBorder': '#00000000',
            'editor.selectionHighlightBackground': alpha(selection, 0.4),
            'editor.findMatchHighlightBackground': alpha(palette.accent, 0.2),
            'editorCursor.foreground': palette.accent,
            'editorWidget.background': widget,
            'editorWidget.border': palette.border,
            'editorHoverWidget.background': widget,
            'editorHoverWidget.border': palette.border,
            'editorIndentGuide.background1': palette.border,
            'editorIndentGuide.activeBackground1': mix(palette.muted, palette.border, 0.4),
            'editorGutter.background': palette.bg,
            'scrollbarSlider.background': alpha(shade, 0.07),
            'scrollbarSlider.hoverBackground': alpha(shade, 0.12),
            'scrollbarSlider.activeBackground': alpha(shade, 0.16),
            'focusBorder': '#00000000',
            'peekView.border': palette.accent,
            'peekViewTitle.background': widget,
            'peekViewTitleLabel.foreground': palette.textStrong,
            'peekViewTitleDescription.foreground': palette.muted,
            'peekViewEditor.background': palette.panel,
            'peekViewEditorGutter.background': palette.panel,
            'peekViewEditor.matchHighlightBackground': alpha(palette.accent, 0.24),
            'peekViewResult.background': widget,
            'peekViewResult.fileForeground': palette.textStrong,
            'peekViewResult.lineForeground': palette.text,
            'peekViewResult.matchHighlightBackground': alpha(palette.accent, 0.24),
            'peekViewResult.selectionBackground': palette.selected,
            'peekViewResult.selectionForeground': palette.textStrong,
            'editorSuggestWidget.background': widget,
            'editorSuggestWidget.border': palette.border,
            'editorSuggestWidget.selectedBackground': palette.selected,
            'editorSuggestWidget.highlightForeground': palette.accent,
            'editorSuggestWidget.focusHighlightForeground': palette.accent,
            'list.hoverBackground': palette.hover,
            'editorError.foreground': palette.danger,
            'editorWarning.foreground': palette.accent,
            'editorInfo.foreground': palette.info,
            'diffEditor.insertedTextBackground': alpha(palette.ok, mode === 'dark' ? 0.14 : 0.18),
            'diffEditor.removedTextBackground': alpha(palette.danger, mode === 'dark' ? 0.14 : 0.16),
            'diffEditor.insertedLineBackground': alpha(palette.ok, mode === 'dark' ? 0.08 : 0.1),
            'diffEditor.removedLineBackground': alpha(palette.danger, mode === 'dark' ? 0.08 : 0.09)
        }
    });
    monaco.editor.setTheme('shipwarden');
}

applyEditorTheme(THEMES[0].dark, 'dark');

export { monaco };

// Automated UI checks drive the editor through this object from the DevTools console.
(window as unknown as { __shipwardenMonaco: typeof monaco }).__shipwardenMonaco = monaco;
