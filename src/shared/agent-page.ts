/**
 * The scripts that the MCP browser tools run in a page of the in-app browser. They are plain text, so the bundler
 * does not change them. Each script is an expression of a function, and `pageCall` adds the argument.
 * The main process runs them. The tests run them in jsdom.
 */

/** The element of a tool call: a ref from read_page, a CSS selector, or the visible text of the element. */
export interface ElementTarget {
    ref?: number;
    selector?: string;
    text?: string;
}

/** An interactive element in the result of read_page. */
export interface PageElement {
    ref: number;
    tag: string;
    role?: string;
    name: string;
    type?: string;
    href?: string;
    value?: string;
    disabled?: boolean;
}

export interface PageRead {
    url: string;
    title: string;
    text: string;
    /** True when the text is longer than the limit. */
    truncated: boolean;
    elements: PageElement[];
}

/** The result of a script that acts on an element. */
export type ActResult = { ok: true; element: string } | { ok: false; error: string };

/** The most characters of page text in the result of read_page. */
export const MAX_PAGE_TEXT = 20_000;
/** The most interactive elements in the result of read_page. */
export const MAX_PAGE_ELEMENTS = 150;

/** Returns the script that calls a page function with an argument. */
export function pageCall(script: string, argument: unknown): string {
    return `(${script})(${JSON.stringify(argument)})`;
}

/**
 * The helpers that the scripts share: the interactive elements, the name of an element, and the search for the target.
 * The attribute "data-shipwarden-ref" gives each element a number that stays while the page stays.
 */
const HELPERS = String.raw`
    var SELECTOR = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable=""], [contenteditable="true"]';
    function clip(text, max) {
        var value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        return value.length > max ? value.slice(0, max - 1) + '…' : value;
    }
    function hidden(element) {
        if (element.hidden || (element.tagName === 'INPUT' && element.type === 'hidden')) return true;
        var style = window.getComputedStyle(element);
        return style.display === 'none' || style.visibility === 'hidden';
    }
    function nameOf(element) {
        var label = element.getAttribute('aria-label');
        if (!label && element.labels && element.labels.length) label = element.labels[0].textContent;
        // The text of a select is the text of all its options. It is not a name.
        var text = element.tagName === 'SELECT' ? '' : element.innerText != null ? element.innerText : element.textContent;
        return clip(label || text || element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('name') || '', 80);
    }
    var nextRef = 0;
    function refOf(element) {
        var current = element.getAttribute('data-shipwarden-ref');
        if (current) return Number(current);
        if (!nextRef) {
            document.querySelectorAll('[data-shipwarden-ref]').forEach(function (item) {
                nextRef = Math.max(nextRef, Number(item.getAttribute('data-shipwarden-ref')) || 0);
            });
        }
        nextRef += 1;
        element.setAttribute('data-shipwarden-ref', String(nextRef));
        return nextRef;
    }
    function interactive(root) {
        return Array.prototype.filter.call(root.querySelectorAll(SELECTOR), function (element) { return !hidden(element); });
    }
    function describe(element) {
        var name = nameOf(element);
        return '<' + element.tagName.toLowerCase() + '>' + (name ? ' "' + name + '"' : '');
    }
    function find(target) {
        if (target.ref != null) {
            var byRef = document.querySelector('[data-shipwarden-ref="' + Number(target.ref) + '"]');
            if (!byRef) throw new Error('No element has the ref ' + target.ref + '. The page changed. Call read_page again.');
            return byRef;
        }
        if (target.selector) {
            var bySelector;
            try { bySelector = document.querySelector(target.selector); } catch (e) { throw new Error('"' + target.selector + '" is not a valid CSS selector.'); }
            if (!bySelector) throw new Error('No element matches the selector "' + target.selector + '".');
            return bySelector;
        }
        var wanted = clip(target.text, 200).toLowerCase();
        var list = interactive(document.body || document.documentElement);
        var exact = list.filter(function (element) { return nameOf(element).toLowerCase() === wanted; });
        var match = exact[0] || list.filter(function (element) { return nameOf(element).toLowerCase().indexOf(wanted) >= 0; })[0];
        if (!match) throw new Error('No interactive element has the text "' + target.text + '". Call read_page to get the elements.');
        return match;
    }
`;

/** Reads the text of the page (or of the element of `selector`) and lists its interactive elements with their refs. */
export const READ_PAGE_SCRIPT = String.raw`function (options) {
    ${HELPERS}
    var root = options.selector ? document.querySelector(options.selector) : (document.body || document.documentElement);
    if (!root) return { error: 'No element matches the selector "' + options.selector + '".' };
    var raw = root.innerText != null ? root.innerText : root.textContent;
    var text = String(raw || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    var elements = interactive(root).slice(0, options.maxElements).map(function (element) {
        var item = { ref: refOf(element), tag: element.tagName.toLowerCase(), name: nameOf(element) };
        var role = element.getAttribute('role');
        if (role) item.role = role;
        if (element.type && element.tagName !== 'BUTTON') item.type = element.type;
        if (element.tagName === 'A') item.href = element.href;
        if ((element.tagName === 'INPUT' && element.type !== 'password') || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') item.value = clip(element.value, 200);
        if (element.disabled) item.disabled = true;
        return item;
    });
    return {
        url: location.href,
        title: document.title,
        text: text.slice(0, options.maxChars),
        truncated: text.length > options.maxChars,
        elements: elements
    };
}`;

/** Clicks an element. The element scrolls into view first. */
export const CLICK_SCRIPT = `function (target) {
    ${HELPERS}
    try {
        var element = find(target);
        if (element.scrollIntoView) element.scrollIntoView({ block: 'center' });
        if (element.focus) element.focus();
        element.click();
        return { ok: true, element: describe(element) };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}`;

/**
 * Types text into a text field, a select, or an element that the user can edit. The value setter of the prototype
 * and the "input" event make frameworks such as React see the change. With `clear`, the new text replaces the value.
 * With `submit`, the form of the element submits, or the element gets the Enter key.
 */
export const TYPE_SCRIPT = `function (options) {
    ${HELPERS}
    try {
        var element = find(options.target);
        if (element.scrollIntoView) element.scrollIntoView({ block: 'center' });
        if (element.focus) element.focus();
        var tag = element.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            var prototype = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
            setter.call(element, options.clear ? options.text : element.value + options.text);
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (tag === 'SELECT') {
            var wanted = String(options.text).trim().toLowerCase();
            var option = Array.prototype.find.call(element.options, function (item) {
                return item.value.toLowerCase() === wanted || item.text.trim().toLowerCase() === wanted;
            });
            if (!option) return { ok: false, error: 'The select ' + describe(element) + ' has no option "' + options.text + '".' };
            element.value = option.value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (element.isContentEditable) {
            if (options.clear) document.execCommand('selectAll', false);
            document.execCommand('insertText', false, options.text);
        } else {
            return { ok: false, error: 'The element ' + describe(element) + ' does not take text. Select a text field.' };
        }
        if (options.submit) {
            if (element.form && element.form.requestSubmit) element.form.requestSubmit();
            else {
                ['keydown', 'keypress', 'keyup'].forEach(function (type) {
                    element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                });
            }
        }
        return { ok: true, element: describe(element) };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}`;
