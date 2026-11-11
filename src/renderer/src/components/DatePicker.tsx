import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover } from './Popover';

/** A day as "YYYY-MM-DD" in the local time zone. */
export function dayKey(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Reads "YYYY-MM-DD" as a local date at midnight. Returns undefined for text that is not a valid day. */
export function parseDayKey(value: string): Date | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return undefined;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return dayKey(date) === value ? date : undefined;
}

/** Adds a number of days to a date. The result is at local midnight. */
export function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Adds a number of months to a date. A day that the month does not have becomes the last day of the month. */
export function addMonths(date: Date, months: number): Date {
    const last = new Date(date.getFullYear(), date.getMonth() + months + 1, 0).getDate();
    return new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), last));
}

/**
 * Returns the days of the calendar for a month: 6 weeks of 7 days, from the week that has the first day of the month.
 * `weekStart` is the first day of a week: 0 is Sunday and 1 is Monday.
 */
export function monthGrid(year: number, month: number, weekStart: number): Date[] {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() - weekStart + 7) % 7;
    return Array.from({ length: 42 }, (_, index) => new Date(year, month, 1 - offset + index));
}

/** The first day of a week in the locale of the user: 0 is Sunday and 1 is Monday. The default is Sunday. */
function localeWeekStart(): number {
    try {
        const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?(): { firstDay: number }; weekInfo?: { firstDay: number } };
        const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
        return firstDay === undefined ? 0 : firstDay % 7;
    } catch {
        return 0;
    }
}

interface Props {
    /** "YYYY-MM-DD", or empty for no date. */
    value: string;
    /** The name of the date, for example "Due date". */
    label: string;
    disabled?: boolean;
    /** The new day "YYYY-MM-DD", or null when the user clears the date. */
    onChange(day: string | null): void;
    /** The content of the button: the current date. */
    children: ReactNode;
    /** The class of the button. */
    className?: string;
}

/**
 * A date picker in the style of the app. It replaces the native date input. The button opens a calendar.
 * The arrow keys move the day, Page Up and Page Down move the month, and Enter selects the day.
 */
export function DatePicker({ value, label, disabled, onChange, children, className = 'task-edit-button' }: Props) {
    const [open, setOpen] = useState(false);
    const [focus, setFocus] = useState(() => parseDayKey(value) ?? new Date());
    const trigger = useRef<HTMLButtonElement>(null);
    const grid = useRef<HTMLDivElement>(null);
    const [weekStart] = useState(localeWeekStart);
    const today = dayKey(new Date());

    const show = () => {
        setFocus(parseDayKey(value) ?? addDays(new Date(), 0));
        setOpen(true);
    };

    const hide = (moveFocus = true) => {
        setOpen(false);
        if (moveFocus) trigger.current?.focus();
    };

    const choose = (day: string | null) => {
        hide();
        if (day !== (value || null)) onChange(day);
    };

    // The focused day gets the keyboard focus, so a screen reader reads it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run when the focused day changes. It finds the day in the page.
    useEffect(() => {
        if (open) grid.current?.querySelector<HTMLElement>('.calendar-day.focus')?.focus();
    }, [open, focus]);

    const onKey = (event: KeyboardEvent) => {
        const moves: Record<string, () => Date> = {
            ArrowLeft: () => addDays(focus, -1),
            ArrowRight: () => addDays(focus, 1),
            ArrowUp: () => addDays(focus, -7),
            ArrowDown: () => addDays(focus, 7),
            PageUp: () => addMonths(focus, event.shiftKey ? -12 : -1),
            PageDown: () => addMonths(focus, event.shiftKey ? 12 : 1),
            Home: () => addDays(focus, -((focus.getDay() - weekStart + 7) % 7)),
            End: () => addDays(focus, 6 - ((focus.getDay() - weekStart + 7) % 7))
        };
        if (moves[event.key]) {
            event.preventDefault();
            setFocus(moves[event.key]());
        } else if (event.key === 'Escape') {
            // Escape closes only the calendar. A dialog around it stays open.
            event.preventDefault();
            event.stopPropagation();
            hide();
        } else if (event.key === 'Tab' && !(event.target as HTMLElement).closest('.calendar-footer')) {
            // Tab goes from the days to the buttons below them. From the last button, it closes the calendar.
            event.preventDefault();
            grid.current?.parentElement?.querySelector<HTMLElement>('.calendar-footer button')?.focus();
        } else if (event.key === 'Tab' && !event.shiftKey && (event.target as HTMLElement).matches('.calendar-footer button:last-child')) {
            event.preventDefault();
            hide();
        }
    };

    const days = monthGrid(focus.getFullYear(), focus.getMonth(), weekStart);
    const weekdays = days.slice(0, 7).map(day => day.toLocaleDateString(undefined, { weekday: 'narrow' }));
    const monthName = focus.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    return (
        <>
            <button
                ref={trigger}
                type="button"
                className={`${className}${open ? ' on' : ''}`}
                disabled={disabled}
                title={`Change the ${label.toLowerCase()}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => (open ? hide(false) : show())}
            >
                {children}
            </button>
            {open && (
                <Popover anchor={trigger} onClose={() => hide(false)} className="calendar">
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: The keys of the days and the buttons come here, so one handler serves them all. */}
                    <div role="dialog" aria-label={label} onKeyDown={onKey}>
                        <div className="calendar-header">
                            <button type="button" className="icon-button" title="Previous month" tabIndex={-1} onClick={() => setFocus(addMonths(focus, -1))}>
                                <ChevronLeft size={14} strokeWidth={1.8} />
                            </button>
                            <span className="calendar-month" aria-live="polite">
                                {monthName}
                            </span>
                            <button type="button" className="icon-button" title="Next month" tabIndex={-1} onClick={() => setFocus(addMonths(focus, 1))}>
                                <ChevronRight size={14} strokeWidth={1.8} />
                            </button>
                        </div>
                        <div className="calendar-grid" ref={grid} role="grid" aria-label={monthName}>
                            {weekdays.map((name, index) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: Two weekdays can have the same narrow name, for example "T".
                                <span key={index} className="calendar-weekday" aria-hidden="true">
                                    {name}
                                </span>
                            ))}
                            {days.map(day => {
                                const key = dayKey(day);
                                const classes = [
                                    'calendar-day',
                                    day.getMonth() !== focus.getMonth() && 'outside',
                                    key === today && 'today',
                                    key === value && 'selected',
                                    key === dayKey(focus) && 'focus'
                                ].filter(Boolean);
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        role="gridcell"
                                        className={classes.join(' ')}
                                        tabIndex={key === dayKey(focus) ? 0 : -1}
                                        aria-selected={key === value}
                                        aria-label={day.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                        onClick={() => choose(key)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                choose(key);
                                            }
                                        }}
                                    >
                                        {day.getDate()}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="calendar-footer">
                            <button type="button" className="link-button" onClick={() => choose(today)}>
                                Today
                            </button>
                            {value && (
                                <button type="button" className="link-button" onClick={() => choose(null)}>
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>
                </Popover>
            )}
        </>
    );
}
