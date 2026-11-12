import { useRef, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { keyParts, SHORTCUT_GROUPS, shortcutRows } from '@shared/shortcuts';
import { IconButton, SearchInput } from './ui';
import { useModal } from './use-modal';

/** A key combination as key caps, for example ⇧ ⌘ D. A screen reader reads the text, for example "⇧⌘D". */
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
 * The Keyboard Shortcuts dialog (Help › Keyboard Shortcuts). The list comes from `src/shared/shortcuts.ts`, so it
 * shows the keys that the app uses.
 */
export function ShortcutsDialog({ onClose }: { onClose(): void }) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [query, setQuery] = useState('');
    const text = query.trim().toLowerCase();
    const shortcuts = shortcutRows().filter(
        item => !text || item.label.toLowerCase().includes(text) || item.keys.some(keys => keys.toLowerCase().includes(text))
    );

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div
                ref={dialog}
                className="modal shortcuts-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="shortcuts-title"
                onKeyDown={event => {
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        onClose();
                    }
                }}
            >
                <header className="modal-header">
                    <Keyboard size={16} strokeWidth={1.8} aria-hidden="true" />
                    <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={15} strokeWidth={1.8} />} label="Close" title="Close (Escape)" onClick={onClose} />
                </header>
                <div className="modal-body">
                    <SearchInput
                        className="shortcuts-search"
                        autoFocus
                        value={query}
                        placeholder="Find a shortcut"
                        aria-label="Find a shortcut"
                        onChange={setQuery}
                    />
                    {shortcuts.length === 0 && <p className="panel-note">No shortcuts match “{query.trim()}”.</p>}
                    {SHORTCUT_GROUPS.map(group => {
                        const items = shortcuts.filter(item => item.group === group);
                        if (items.length === 0) return null;
                        const id = `shortcuts-group-${group.replace(/\W+/g, '-').toLowerCase()}`;
                        return (
                            <section key={group} className="shortcuts-group" aria-labelledby={id}>
                                <h3 id={id}>{group}</h3>
                                <dl>
                                    {items.map(item => (
                                        <div key={item.label} className="shortcut-row">
                                            <dt>{item.label}</dt>
                                            <dd>
                                                {item.keys.map((keys, index) => (
                                                    <span key={keys} className="shortcut-choice">
                                                        {index > 0 && <span className="shortcut-or">{item.range ? 'to' : 'or'}</span>}
                                                        <Keys keys={keys} />
                                                    </span>
                                                ))}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
