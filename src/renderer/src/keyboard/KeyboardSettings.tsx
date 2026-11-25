import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { FolderOpen, Keyboard } from 'lucide-react';
import { chordId, formatChord, inputOfEvent, keyNamesOf, type KeyChord } from '@shared/key-chords';
import { assignKey, commandsWithKey, hasDefaultKeys, invalidKeyReason, reservedKey } from '@shared/keybindings';
import { findKeybind } from '@shared/keybinds';
import type { PromptTemplate } from '@shared/prompt-templates';
import { KEY_COMMANDS, keyParts, parseKeys, SHORTCUT_GROUPS, type KeyCommand, type Keymap } from '@shared/shortcuts';
import type { TextKeybind } from '@shared/terminal';
import { confirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { Button, Chip, FilterField, inputClass } from '../components/ui';
import { usePromptTemplates } from '../prompts/prompt-queries';
import { errorText } from '../util';
import { resetAllKeybindings, setRecordingKeys, updateKeybindings, useKeybindings } from './keymap';

const api = window.shipwarden.keybindings;

/** The keys that only change other keys. Alone, they are not a key combination. */
const MODIFIER_KEYS = ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'];

/** A key combination as key caps, for example ⇧ ⌘ D. */
function Keys({ keys }: { keys: string }) {
    return (
        <span className="shortcut-keys">
            <span className="visually-hidden">{keys}</span>
            <span className="shortcut-caps" aria-hidden="true">
                {keyParts(keys).map((part, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: The parts of one key combination never change order.
                    <kbd key={index}>{part}</kbd>
                ))}
            </span>
        </span>
    );
}

/**
 * Settings › Keyboard: the commands and their keys. The user can record a new key, remove a key, and reset one
 * command or all commands. The keys are in ~/.shipwarden/keybindings.json, so the user can also change the file.
 */
export function KeyboardSettings({ terminalKeybinds }: { terminalKeybinds: readonly TextKeybind[] }) {
    const { state, keymap } = useKeybindings();
    const { list: prompts } = usePromptTemplates();
    const [query, setQuery] = useState('');
    const [error, setError] = useState<string>();
    const text = query.trim().toLowerCase();
    const changed = KEY_COMMANDS.filter(command => !hasDefaultKeys(keymap, command)).length;
    const commands = useMemo(
        () =>
            KEY_COMMANDS.filter(
                command =>
                    !text ||
                    command.label.toLowerCase().includes(text) ||
                    command.id.toLowerCase().includes(text) ||
                    keymap.keys[command.id].some(chord => formatChord(chord).toLowerCase().includes(text))
            ),
        [text, keymap]
    );

    const resetAll = async () => {
        const ok = await confirmDialog({
            title: 'Reset all keys?',
            message: 'All commands get their default keys. ShipWarden replaces the keybindings file with an empty JSON object.',
            confirmLabel: 'Reset all',
            danger: true
        });
        if (!ok) return;
        setError(undefined);
        await resetAllKeybindings().catch(reason => setError(errorText(reason)));
    };

    return (
        <>
            <SettingsGroup
                title="Keyboard"
                description={
                    <>
                        Give a command a different key. ShipWarden keeps your keys in <code>{state?.file ?? '~/.shipwarden/keybindings.json'}</code>. A change
                        in the file applies at once.
                    </>
                }
                actions={
                    <>
                        <Button size="sm" icon={<FolderOpen size={13} strokeWidth={1.8} />} onClick={() => api.reveal()}>
                            Show in Finder
                        </Button>
                        <Button size="sm" variant="danger" disabled={changed === 0 && !state?.problems.length} onClick={() => void resetAll()}>
                            Reset all
                        </Button>
                    </>
                }
            >
                <FilterField value={query} onChange={setQuery} placeholder="Find a command or a key" className="keyboard-filter" />
                {error && <div className="form-error">{error}</div>}
            </SettingsGroup>
            {state && state.problems.length > 0 && (
                <SettingsGroup
                    title="Entries that ShipWarden ignored"
                    description="These entries of the keybindings file are not valid. The commands keep their default keys. Correct the file in a text editor."
                    card
                >
                    {state.problems.map(problem => (
                        <SettingsRow key={problem} label={<span className="keyboard-problem">{problem}</span>} />
                    ))}
                </SettingsGroup>
            )}
            {commands.length === 0 && (
                <EmptyState icon={Keyboard} title="No commands match" size="compact">
                    No command or key matches “{query.trim()}”.
                </EmptyState>
            )}
            {SHORTCUT_GROUPS.map(group => {
                const items = commands.filter(command => command.group === group);
                if (items.length === 0) return null;
                return (
                    <SettingsGroup key={group} title={group} card>
                        {items.map(command => (
                            <CommandRow key={command.id} command={command} keymap={keymap} prompts={prompts.templates} terminalKeybinds={terminalKeybinds} />
                        ))}
                    </SettingsGroup>
                );
            })}
        </>
    );
}

interface RowProps {
    command: KeyCommand;
    keymap: Keymap;
    prompts: readonly PromptTemplate[];
    terminalKeybinds: readonly TextKeybind[];
}

/** A key that the user pressed. The key belongs to other commands, so the row asks before it moves the key. */
interface PendingKey {
    chord: KeyChord;
    others: KeyCommand[];
}

/** One command: its keys, the conflicts, and the buttons to change and reset the keys. */
function CommandRow({ command, keymap, prompts, terminalKeybinds }: RowProps) {
    const [recording, setRecording] = useState(false);
    const [pending, setPending] = useState<PendingKey>();
    const [error, setError] = useState<string>();
    const keys = keymap.keys[command.id];
    const isDefault = hasDefaultKeys(keymap, command);

    const save = (changes: Parameters<typeof updateKeybindings>[0]) => {
        setError(undefined);
        setPending(undefined);
        updateKeybindings(changes).catch(reason => setError(errorText(reason)));
    };
    const onKey = (chord: KeyChord | null) => {
        setRecording(false);
        if (!chord) {
            save([{ command: command.id, keys: [] }]);
            return;
        }
        const reason = invalidKeyReason(chord);
        if (reason) {
            setError(reason);
            return;
        }
        const others = commandsWithKey(keymap, command, chord);
        if (others.length > 0) setPending({ chord, others });
        else save(assignKey(keymap, command, chord));
    };

    const notes = keys.flatMap(chord => keyNotes(command, chord, keymap, prompts, terminalKeybinds));

    return (
        <SettingsRow
            label={
                <>
                    {command.label}
                    {!isDefault && (
                        <Chip tone="info" className="keyboard-changed">
                            Changed
                        </Chip>
                    )}
                </>
            }
            description={
                (notes.length > 0 || pending || error) && (
                    <>
                        {notes.map(note => (
                            <div key={note} className="keyboard-warning">
                                {note}
                            </div>
                        ))}
                        {pending && (
                            <div className="keyboard-pending">
                                <span className="keyboard-warning">
                                    {formatChord(pending.chord)} is the key of {pending.others.map(other => `"${other.label}"`).join(' and ')}. Replace removes
                                    it from {pending.others.length > 1 ? 'these commands' : 'that command'}.
                                </span>
                                <span className="keyboard-pending-buttons">
                                    <Button size="sm" onClick={() => setPending(undefined)}>
                                        Cancel
                                    </Button>
                                    <Button size="sm" variant="primary" onClick={() => save(assignKey(keymap, command, pending.chord))}>
                                        Replace
                                    </Button>
                                </span>
                            </div>
                        )}
                        {error && <div className="form-error">{error}</div>}
                    </>
                )
            }
            control={
                <div className="keyboard-row-control">
                    {recording ? (
                        <KeyRecorder onKey={onKey} onCancel={() => setRecording(false)} />
                    ) : keys.length > 0 ? (
                        <span className="keyboard-keys">
                            {keys.map(chord => (
                                <Keys key={formatChord(chord)} keys={formatChord(chord)} />
                            ))}
                        </span>
                    ) : (
                        <span className="keyboard-no-key">No key</span>
                    )}
                    <Button
                        size="sm"
                        disabled={recording}
                        title="Press the new keys. Backspace removes the key. Escape cancels."
                        onClick={() => {
                            setError(undefined);
                            setPending(undefined);
                            setRecording(true);
                        }}
                    >
                        Record
                    </Button>
                    <Button
                        size="sm"
                        disabled={isDefault}
                        title="Give the command its default key"
                        onClick={() => save([{ command: command.id, reset: true }])}
                    >
                        Reset
                    </Button>
                </div>
            }
        />
    );
}

/**
 * Returns the warnings of one key of a command: other commands with the key, a key of macOS or the terminal, a prompt
 * template shortcut, or a text keybind of the terminal config.
 */
function keyNotes(
    command: KeyCommand,
    chord: KeyChord,
    keymap: Keymap,
    prompts: readonly PromptTemplate[],
    terminalKeybinds: readonly TextKeybind[]
): string[] {
    const label = formatChord(chord);
    const notes: string[] = [];
    const others = commandsWithKey(keymap, command, chord);
    if (others.length > 0) {
        // The first command in the list gets the key (see `commandForInput`).
        const winner = keymap.byChord.get(chordId(chord))?.find(id => id === command.id || others.some(other => other.id === id));
        const first = winner === command.id;
        const names = others.map(other => `"${other.label}"`).join(' and ');
        notes.push(`Conflict: ${label} is also the key of ${names}. ${first ? 'This command gets the key.' : 'The other command gets the key.'}`);
    }
    const reserved = reservedKey(chord);
    if (reserved) notes.push(`${label} is also the key of "${reserved.label}". This command takes the key.`);
    const template = prompts.find(item => {
        const parsed = item.shortcut ? parseKeys(item.shortcut) : undefined;
        return (
            !!parsed &&
            parsed.meta === chord.meta &&
            parsed.control === chord.control &&
            parsed.alt === chord.alt &&
            parsed.shift === chord.shift &&
            keyNamesOf(parsed).includes(chord.key)
        );
    });
    if (template && command.scope === 'global')
        notes.push(`${label} is also the shortcut of the prompt template "${template.name}". This command takes the key.`);
    const press = {
        key: chord.key.length === 1 ? chord.key.toLowerCase() : chord.key,
        shiftKey: chord.shift,
        ctrlKey: chord.control,
        altKey: chord.alt,
        metaKey: chord.meta
    };
    if (findKeybind(terminalKeybinds, press)) notes.push(`${label} is also a text keybind of your terminal config. This command takes the key.`);
    return notes;
}

/**
 * A field that records a key combination. It has the focus at once. Escape or a click elsewhere cancels. Backspace or
 * Delete without other keys removes the key. While the field records, the shortcuts of ShipWarden do not run.
 */
function KeyRecorder({ onKey, onCancel }: { onKey(chord: KeyChord | null): void; onCancel(): void }) {
    useEffect(() => {
        setRecordingKeys(true);
        return () => setRecordingKeys(false);
    }, []);
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (MODIFIER_KEYS.includes(event.key)) return;
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        if (event.key === 'Escape' && plain) {
            onCancel();
            return;
        }
        if ((event.key === 'Backspace' || event.key === 'Delete') && plain) {
            onKey(null);
            return;
        }
        const input = inputOfEvent(event.nativeEvent);
        const key = keyNamesOf(input)[0];
        if (!key) return;
        onKey({ key, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift });
    };
    return (
        <div className={inputClass('sm', { className: 'input-box key-field recording keyboard-recorder' })}>
            {/* A text input would type the keys. This element only records them. */}
            <div
                role="textbox"
                tabIndex={0}
                aria-label="Press the new keys"
                className="input-inner key-field-value"
                ref={element => element?.focus()}
                onKeyDown={onKeyDown}
                onBlur={onCancel}
            >
                <span className="placeholder">Press the keys…</span>
            </div>
        </div>
    );
}
