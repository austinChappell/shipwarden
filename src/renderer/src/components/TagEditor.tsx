import { useEffect, useRef, useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';
import { pluralize } from '@shared/format';
import { normalizeTags, tagOptions } from '@shared/notes';
import { Chip, Count, labelIndex } from './ui';
import { cx } from './ui/cx';

/** The width of the tag picker popover, in pixels. The CSS has the same value. */
const POPOVER_WIDTH = 260;

interface PickerProps {
    tags: string[];
    /** The tags of the other items. The picker shows them as options. */
    allTags: string[];
    onAdd(tag: string): void;
    onRemoveLast(): void;
    /** True to open the popover when the picker shows. */
    autoOpen?: boolean;
    /** Called when the popover closes. */
    onClose?(): void;
}

/** The "Add tag" button. It opens a combobox with the tags of the other items and an option to create a new tag. */
function TagPicker({ tags, allTags, onAdd, onRemoveLast, autoOpen = false, onClose }: PickerProps) {
    const [open, setOpenState] = useState(autoOpen);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    /** True when the popover opens to the left of the button, because the window has no space at the right. */
    const [alignRight, setAlignRight] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const options = tagOptions(query, tags, allTags);

    const setOpen = (value: boolean) => {
        setOpenState(value);
        if (!value) onClose?.();
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen calls onClose. A new onClose does not change the listener.
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new query selects the first option again.
    useEffect(() => setActive(0), [query]);
    useEffect(() => {
        if (!autoOpen) return;
        const left = root.current?.getBoundingClientRect().left ?? 0;
        setAlignRight(left + POPOVER_WIDTH > window.innerWidth - 12);
    }, [autoOpen]);

    const choose = (tag: string) => {
        onAdd(tag);
        // The picker stays open, so the user can add more tags.
        setQuery('');
    };
    const onKey = (event: React.KeyboardEvent) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(index => Math.min(options.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(0, index - 1));
        } else if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            const option = options[active];
            if (option) choose(option.tag);
        } else if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
            // Escape closes only the popover, not a dialog around it. Shift+Tab also closes it.
            // The focus goes back to the button. After Tab, `onBlur` closes the popover.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
        } else if (event.key === 'Backspace' && !query && tags.length) {
            onRemoveLast();
        }
    };

    return (
        <div
            className="tag-picker"
            ref={root}
            onBlur={event => {
                // A click on an option gives no new focus. Only a focus outside the picker closes the popover.
                if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                type="button"
                className={`tag-add${open ? ' on' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setQuery('');
                    const left = root.current?.getBoundingClientRect().left ?? 0;
                    setAlignRight(left + POPOVER_WIDTH > window.innerWidth - 12);
                    setOpen(!open);
                }}
            >
                <Plus size={12} strokeWidth={2} /> Add tag
            </button>
            {open && (
                <div className={`combobox-popover tag-picker-popover${alignRight ? ' align-right' : ''}`}>
                    <label className="combobox-search">
                        <Tag size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder="Find or create a tag"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                            onKeyDown={onKey}
                        />
                    </label>
                    <div className="combobox-list" role="listbox">
                        {options.length === 0 && (
                            <div className="combobox-empty">
                                {allTags.length ? 'No other tags. Type to create one.' : 'Type a name to create the first tag.'}
                            </div>
                        )}
                        {options.map((option, index) => (
                            <div
                                key={`${option.create}-${option.tag}`}
                                role="option"
                                aria-selected={index === active}
                                className={`combobox-option${index === active ? ' active' : ''}`}
                                onMouseMove={() => setActive(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(option.tag)}
                            >
                                {option.create ? (
                                    <span className="combobox-label">
                                        Create tag <strong>#{option.tag}</strong>
                                    </span>
                                ) : (
                                    <span className="combobox-label">#{option.tag}</span>
                                )}
                                {option.create && <Plus size={13} strokeWidth={2} />}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

interface EditorProps {
    tags: string[];
    allTags: string[];
    onChange(tags: string[]): void;
    /** True to open the tag picker when the editor shows. */
    autoOpen?: boolean;
    /** Called when the tag picker closes. */
    onClose?(): void;
    className?: string;
}

/** The tags of an item: chips with a remove button, and the "Add tag" button. */
export function TagEditor({ tags, allTags, onChange, autoOpen, onClose, className }: EditorProps) {
    return (
        <div className={cx('tag-list', className)}>
            {tags.map(tag => (
                <Chip key={tag} tone="label" labelIndex={labelIndex(tag)} className="tag-chip">
                    #{tag}
                    <button type="button" title={`Remove the tag ${tag}`} onClick={() => onChange(tags.filter(item => item !== tag))}>
                        <X size={11} strokeWidth={2} />
                    </button>
                </Chip>
            ))}
            <TagPicker
                tags={tags}
                allTags={allTags}
                onAdd={tag => onChange(normalizeTags([...tags, tag]))}
                onRemoveLast={() => onChange(tags.slice(0, -1))}
                autoOpen={autoOpen}
                onClose={onClose}
            />
        </div>
    );
}

interface FilterProps {
    /** Each tag with the number of items that have it. */
    tags: [string, number][];
    selected: string[];
    onToggle(tag: string): void;
    /** The name of one item for the count label, for example "file". */
    noun: string;
    className?: string;
}

/** A row of tag toggles with counts. An item shows when it has each selected tag. Without tags, the row does not show. */
export function TagFilter({ tags, selected, onToggle, noun, className }: FilterProps) {
    if (tags.length === 0) return null;
    return (
        <div className={className} role="group" aria-label="Filter by tag">
            {tags.map(([tag, count]) => (
                <button
                    key={tag}
                    type="button"
                    className={`tag-filter-toggle${selected.includes(tag) ? ' on' : ''}`}
                    aria-pressed={selected.includes(tag)}
                    onClick={() => onToggle(tag)}
                >
                    #{tag}
                    <Count value={count} label={pluralize(count, noun)} />
                </button>
            ))}
        </div>
    );
}
