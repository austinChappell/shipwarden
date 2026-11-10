/** Returns the index that is `delta` steps from `index`. The index wraps at the two ends of the list. */
export function stepIndex(index: number, count: number, delta: number): number {
    if (count <= 0) return -1;
    return (((index + delta) % count) + count) % count;
}

/**
 * The keydown handler of a group with `role="radiogroup"`. The Left and Right arrow keys focus and select the
 * previous or the next radio button. The selection wraps at the two ends.
 */
export function radioGroupKeys(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
    const index = radios.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = radios[stepIndex(index, radios.length, event.key === 'ArrowRight' ? 1 : -1)];
    next.focus();
    next.click();
}
