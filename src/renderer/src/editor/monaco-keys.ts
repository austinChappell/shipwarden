import type { KeyChord } from '@shared/key-chords';
import type { KeyCommandId } from '@shared/shortcuts';
import { currentKeymap, onKeymapChange } from '../keyboard/keymap';
import { monaco } from './monaco';

/** The Monaco key code name of each key name that is not a letter, a digit, or a function key. */
const MONACO_KEYS: Record<string, keyof typeof monaco.KeyCode> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    '\\': 'Backslash',
    Left: 'LeftArrow',
    Right: 'RightArrow',
    Up: 'UpArrow',
    Down: 'DownArrow',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Space: 'Space',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
};

/** Returns the Monaco keybinding of a chord, or undefined for a key that Monaco does not know. */
export function monacoKeybinding(chord: KeyChord): number | undefined {
    const name = /^[A-Z]$/.test(chord.key)
        ? `Key${chord.key}`
        : /^\d$/.test(chord.key)
          ? `Digit${chord.key}`
          : /^F\d+$/.test(chord.key)
            ? chord.key
            : MONACO_KEYS[chord.key];
    const code = name ? (monaco.KeyCode as unknown as Record<string, number>)[name] : undefined;
    if (code === undefined) return undefined;
    return (
        code |
        (chord.meta ? monaco.KeyMod.CtrlCmd : 0) |
        (chord.control ? monaco.KeyMod.WinCtrl : 0) |
        (chord.alt ? monaco.KeyMod.Alt : 0) |
        (chord.shift ? monaco.KeyMod.Shift : 0)
    );
}

/**
 * Adds an action to the editor with the keys of a command in the keymap. A change of the keybindings adds the action
 * again with the new keys. The action goes away with the editor.
 */
export function addKeyedAction(
    editor: Pick<monaco.editor.IStandaloneCodeEditor, 'addAction' | 'onDidDispose'>,
    command: KeyCommandId,
    action: Omit<monaco.editor.IActionDescriptor, 'keybindings'>
): monaco.IDisposable {
    const add = () =>
        editor.addAction({
            ...action,
            keybindings: currentKeymap()
                .keys[command].map(monacoKeybinding)
                .filter((keybinding): keybinding is number => keybinding !== undefined)
        });
    let added = add();
    const stop = onKeymapChange(() => {
        added.dispose();
        added = add();
    });
    const disposable = {
        dispose: () => {
            stop();
            added.dispose();
            listener.dispose();
        }
    };
    const listener = editor.onDidDispose(() => disposable.dispose());
    return disposable;
}
