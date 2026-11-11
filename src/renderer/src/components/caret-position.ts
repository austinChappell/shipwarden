/** The styles that change where the text of a text box wraps. A copy of the box needs the same values. */
const COPIED_STYLES = [
    'boxSizing',
    'width',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'wordSpacing',
    'tabSize'
] as const;

/**
 * Returns the position of a character of a text box in the window, and the height of a line.
 * The function puts a hidden copy of the box with the same text and styles in the page, and measures a marker at the index.
 */
export function caretRect(box: HTMLTextAreaElement, index: number): { left: number; top: number; height: number } {
    const style = getComputedStyle(box);
    const copy = document.createElement('div');
    for (const name of COPIED_STYLES) copy.style[name] = style[name];
    copy.style.position = 'absolute';
    copy.style.visibility = 'hidden';
    copy.style.top = '0';
    copy.style.left = '-9999px';
    copy.style.whiteSpace = 'pre-wrap';
    copy.style.overflowWrap = 'break-word';
    copy.textContent = box.value.slice(0, index);
    const marker = document.createElement('span');
    // The marker needs content, else it has no height.
    marker.textContent = box.value.slice(index, index + 1) || '.';
    copy.appendChild(marker);
    document.body.appendChild(copy);
    const lineHeight = Number.parseFloat(style.lineHeight) || marker.offsetHeight;
    const boxRect = box.getBoundingClientRect();
    const result = {
        left: boxRect.left + marker.offsetLeft - box.scrollLeft,
        top: boxRect.top + marker.offsetTop - box.scrollTop,
        height: lineHeight
    };
    copy.remove();
    return result;
}
