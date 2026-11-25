/**
 * The element picker of the in-app browser. The user clicks an element in the page, and ShipWarden sends its HTML, its
 * styles, a CSS selector, and a screenshot to an agent of the worktree.
 *
 * The scripts are plain text, so the bundler does not change them. The main process runs them in an isolated world of
 * the page. The tests run them in jsdom.
 */
import { fence } from './ask-agent';

/** The rectangle of an element in the viewport, in CSS pixels. */
export interface ElementRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The data of the element that the user picked. */
export interface PickedElement {
    url: string;
    title: string;
    /** The tag name in lowercase, for example "button". */
    tag: string;
    /** A CSS selector that matches only this element in the page. */
    selector: string;
    /** The outer HTML. It is cut at `maxHtml` characters. */
    html: string;
    /** True when the HTML is longer than the limit. */
    htmlTruncated: boolean;
    /** The visible text of the element, cut at 200 characters. */
    text: string;
    /** The computed styles that matter for a layout or a look. Properties with a default value are not in the list. */
    styles: Record<string, string>;
    rect: ElementRect;
    /** The size of the viewport in CSS pixels. */
    viewport: { width: number; height: number };
}

/** The result of a pick for the page: the element, and the screenshot of the element when ShipWarden made one. */
export interface ElementPick {
    element: PickedElement;
    /** The path of the PNG file of the screenshot. */
    imagePath?: string;
    /** The screenshot as a data URL, for the preview. */
    imageDataUrl?: string;
    /** True when the screenshot shows only the visible part of the element. */
    imagePartial?: boolean;
}

/** The most characters of outer HTML in a pick. */
export const MAX_PICK_HTML = 6000;

/** The isolated world of the picker scripts. The page cannot see or change their variables. */
export const PICK_WORLD_ID = 1101;

/** The computed style properties that a pick sends. Each one shows only when it has a value that is not a default. */
export const PICK_STYLE_PROPERTIES = [
    'display',
    'position',
    'box-sizing',
    'width',
    'height',
    'margin',
    'padding',
    'border',
    'border-radius',
    'color',
    'background-color',
    'background-image',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'text-align',
    'flex-direction',
    'flex-wrap',
    'justify-content',
    'align-items',
    'gap',
    'grid-template-columns',
    'overflow',
    'opacity',
    'z-index',
    'box-shadow',
    'transform'
] as const;

/**
 * The helpers that the scripts share:
 * - `selectorOf` makes a short CSS selector that matches only the element. It uses a unique id, then a unique test
 *   attribute, then a path of tags, stable classes, and ":nth-of-type".
 * - `describeElement` returns the data of a PickedElement.
 */
const HELPERS = String.raw`
    var TEST_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
    var STYLE_PROPERTIES = ${JSON.stringify(PICK_STYLE_PROPERTIES)};
    var EMPTY_VALUES = ['', 'none', 'normal', 'auto', 'rgba(0, 0, 0, 0)', 'transparent', '0px', 'static', 'visible', 'content-box', 'start', 'nowrap', '1'];
    var FLEX_PROPERTIES = ['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap'];
    function cssEscape(value) {
        return String(value).replace(/^-?\d|[^a-zA-Z0-9_\u00a0-\uffff-]/g, function (match) {
            if (/^-?\d$/.test(match)) return match.slice(0, -1) + '\\3' + match.slice(-1) + ' ';
            return '\\' + match;
        });
    }
    function unique(selector, element) {
        var list;
        try { list = document.querySelectorAll(selector); } catch (e) { return false; }
        return list.length === 1 && list[0] === element;
    }
    // A generated id or class changes with each build or each load, so a selector must not use it.
    function stableName(name) {
        return !!name && name.length <= 40 && !/\d{3,}|:|^(css|sc|jsx|emotion|svelte)-|__[a-zA-Z0-9]{5,}$/.test(name);
    }
    function stepOf(element) {
        var tag = element.tagName.toLowerCase();
        var classes = Array.prototype.filter.call(element.classList || [], stableName).slice(0, 2);
        return tag + classes.map(function (name) { return '.' + cssEscape(name); }).join('');
    }
    function nthOfType(element) {
        var index = 1;
        var sibling = element.previousElementSibling;
        while (sibling) {
            if (sibling.tagName === element.tagName) index += 1;
            sibling = sibling.previousElementSibling;
        }
        return ':nth-of-type(' + index + ')';
    }
    function selectorOf(element) {
        if (element.id && stableName(element.id) && unique('#' + cssEscape(element.id), element)) return '#' + cssEscape(element.id);
        for (var a = 0; a < TEST_ATTRIBUTES.length; a++) {
            var value = element.getAttribute(TEST_ATTRIBUTES[a]);
            if (value) {
                var byAttribute = '[' + TEST_ATTRIBUTES[a] + '="' + String(value).replace(/["\\]/g, '\\$&') + '"]';
                if (unique(byAttribute, element)) return byAttribute;
            }
        }
        var parts = [];
        var current = element;
        while (current && current.nodeType === 1 && current !== document.documentElement) {
            if (current !== element && current.id && stableName(current.id) && unique('#' + cssEscape(current.id), current)) {
                parts.unshift('#' + cssEscape(current.id));
                break;
            }
            var step = stepOf(current);
            var parent = current.parentElement;
            if (parent) {
                var same = Array.prototype.filter.call(parent.children, function (child) {
                    try { return child.matches(step); } catch (e) { return false; }
                });
                if (same.length > 1) step += nthOfType(current);
            }
            parts.unshift(step);
            var path = parts.join(' > ');
            if (unique(path, element)) return path;
            current = parent;
        }
        var full = parts.join(' > ');
        return unique(full, element) ? full : fullPath(element);
    }
    // The last choice: tags and ":nth-of-type" from the root. It always matches only the element.
    function fullPath(element) {
        var parts = [];
        var current = element;
        while (current && current.nodeType === 1 && current !== document.documentElement) {
            parts.unshift(current.tagName.toLowerCase() + nthOfType(current));
            current = current.parentElement;
        }
        return parts.join(' > ');
    }
    function stylesOf(element) {
        var style = window.getComputedStyle(element);
        var display = style.getPropertyValue('display');
        var flexOrGrid = /flex|grid/.test(display);
        var result = {};
        STYLE_PROPERTIES.forEach(function (property) {
            var value = String(style.getPropertyValue(property) || '').trim();
            if (property === 'display' || property === 'position' ? !value : EMPTY_VALUES.indexOf(value) >= 0) return;
            if (FLEX_PROPERTIES.indexOf(property) >= 0 && !flexOrGrid) return;
            if (property === 'grid-template-columns' && display.indexOf('grid') < 0) return;
            if (property === 'border' && /^0px /.test(value)) return;
            if (property === 'font-weight' && value === '400') return;
            result[property] = value;
        });
        return result;
    }
    function describeElement(element, maxHtml) {
        var html = String(element.outerHTML || '').replace(/\s+data-shipwarden-ref="\d+"/g, '');
        var rect = element.getBoundingClientRect();
        var raw = element.innerText != null ? element.innerText : element.textContent;
        var text = String(raw || '').replace(/\s+/g, ' ').trim();
        return {
            url: location.href,
            title: document.title,
            tag: element.tagName.toLowerCase(),
            selector: selectorOf(element),
            html: html.length > maxHtml ? html.slice(0, maxHtml) : html,
            htmlTruncated: html.length > maxHtml,
            text: text.length > 200 ? text.slice(0, 199) + '…' : text,
            styles: stylesOf(element),
            rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
            viewport: { width: window.innerWidth, height: window.innerHeight }
        };
    }
`;

/** Returns the data of the element of a CSS selector, or null when no element matches. */
export const DESCRIBE_ELEMENT_SCRIPT = `function (options) {
    ${HELPERS}
    var element = document.querySelector(options.selector);
    return element ? describeElement(element, options.maxHtml) : null;
}`;

/**
 * Starts the picker. A box shows above the element under the mouse. A click selects the element, and Escape stops the
 * picker. The page does not get the click. The promise resolves with the data of the element, or with null when the
 * user stops the picker. It resolves after the box is gone, so a screenshot does not show it.
 * A second start stops the first picker. CANCEL_PICK_SCRIPT also stops it.
 */
export const PICK_SCRIPT = `function (options) {
    ${HELPERS}
    if (window.__shipwardenPick) window.__shipwardenPick(null);
    return new Promise(function (resolve) {
        var root = document.documentElement;
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,0.15);border-radius:2px;display:none;';
        var label = document.createElement('div');
        label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:3px;background:#1e293b;color:#fff;font:11px/16px -apple-system,system-ui,sans-serif;white-space:nowrap;display:none;';
        root.appendChild(box);
        root.appendChild(label);
        var current = null;
        var done = false;
        var oldCursor = root.style.cursor;
        root.style.cursor = 'crosshair';
        function show(element) {
            current = element;
            var rect = element.getBoundingClientRect();
            box.style.display = 'block';
            box.style.left = rect.left + 'px';
            box.style.top = rect.top + 'px';
            box.style.width = rect.width + 'px';
            box.style.height = rect.height + 'px';
            var step = stepOf(element);
            label.textContent = (step.length > 60 ? step.slice(0, 59) + '…' : step) + '  ' + Math.round(rect.width) + ' × ' + Math.round(rect.height);
            label.style.display = 'block';
            label.style.left = Math.max(0, rect.left) + 'px';
            label.style.top = (rect.top >= 22 ? rect.top - 20 : Math.min(window.innerHeight - 20, rect.bottom + 2)) + 'px';
        }
        function targetOf(event) {
            var element = event.target;
            return element && element.nodeType === 1 && element !== root ? element : null;
        }
        function onMove(event) {
            var element = targetOf(event);
            if (element && element !== current) show(element);
        }
        function block(event) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
        // The pick happens at the press. The release and the click that follow stay blocked for a short time, so the
        // page does not get them.
        function onDown(event) {
            block(event);
            if (event.button !== 0) return;
            var element = targetOf(event) || current;
            if (!element) return;
            finish(describeElement(element, options.maxHtml), 400);
        }
        function onKey(event) {
            if (event.key !== 'Escape') return;
            block(event);
            finish(null, 0);
        }
        var BLOCKED = ['pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
        function stop() {
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('mousedown', block, true);
            window.removeEventListener('keydown', onKey, true);
            box.remove();
            label.remove();
            root.style.cursor = oldCursor;
        }
        function finish(result, blockMs) {
            if (done) return;
            done = true;
            window.__shipwardenPick = null;
            stop();
            setTimeout(function () {
                BLOCKED.forEach(function (type) { window.removeEventListener(type, block, true); });
            }, blockMs);
            // Wait for a paint without the box, then resolve. A hidden page does not paint, so a timer also resolves.
            var resolved = false;
            function settle() {
                if (resolved) return;
                resolved = true;
                resolve(result);
            }
            requestAnimationFrame(function () { requestAnimationFrame(settle); });
            setTimeout(settle, 250);
        }
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('mousedown', block, true);
        window.addEventListener('keydown', onKey, true);
        BLOCKED.forEach(function (type) { window.addEventListener(type, block, true); });
        window.__shipwardenPick = function (result) { finish(result, 0); };
    });
}`;

/** Stops the picker of the page. The promise of PICK_SCRIPT then resolves with null. */
export const CANCEL_PICK_SCRIPT = 'window.__shipwardenPick ? (window.__shipwardenPick(null), true) : false';

/** Returns the script that calls a page function with an argument. */
export function pickCall(script: string, argument: unknown): string {
    return `(${script})(${JSON.stringify(argument)})`;
}

/**
 * Returns the part of the element that is in the viewport, in pixels of the view (CSS pixels × zoom), or undefined when
 * no part is visible. `partial` is true when a part of the element is outside the viewport.
 */
export function visibleCrop(rect: ElementRect, viewport: { width: number; height: number }, zoom = 1): { rect: ElementRect; partial: boolean } | undefined {
    const left = Math.max(0, rect.x);
    const top = Math.max(0, rect.y);
    const right = Math.min(viewport.width, rect.x + rect.width);
    const bottom = Math.min(viewport.height, rect.y + rect.height);
    if (right - left < 1 || bottom - top < 1) return undefined;
    const partial = left > rect.x || top > rect.y || right < rect.x + rect.width || bottom < rect.y + rect.height;
    return {
        rect: {
            x: Math.floor(left * zoom),
            y: Math.floor(top * zoom),
            width: Math.ceil((right - left) * zoom),
            height: Math.ceil((bottom - top) * zoom)
        },
        partial
    };
}

/** Returns a short name of an element for the UI, for example "<button> #save". */
export function pickLabel(element: Pick<PickedElement, 'tag' | 'selector'>): string {
    return `<${element.tag}> ${element.selector}`;
}

/** The input of the prompt of a picked element. */
export interface ElementPromptInput {
    pick: ElementPick;
    /** The note of the user. It can be empty. */
    note: string;
}

/** Returns the prompt that gives a picked element to an agent. The note of the user comes last. */
export function elementPrompt({ pick, note }: ElementPromptInput): string {
    const { element } = pick;
    const title = element.title ? ` ("${element.title}")` : '';
    const { rect, viewport } = element;
    const facts = [
        `I picked an element in the in-app browser of ShipWarden, on the page ${element.url}${title}.`,
        `- Selector: \`${element.selector}\``,
        `- Size: ${rect.width} × ${rect.height} px at x ${rect.x}, y ${rect.y} of a ${viewport.width} × ${viewport.height} px viewport.`
    ];
    if (element.text) facts.push(`- Text: "${element.text}"`);
    if (pick.imagePath) {
        const part = pick.imagePartial ? ' It shows only the part of the element that is in the viewport.' : '';
        facts.push(`- Screenshot of the element: ${pick.imagePath}. Read this image file.${part}`);
    }
    const sections = [facts.join('\n')];
    const styles = Object.entries(element.styles);
    if (styles.length) sections.push(`Computed styles:\n${styles.map(([name, value]) => `- ${name}: ${value}`).join('\n')}`);
    const marker = fence(element.html);
    const cut = element.htmlTruncated ? `\n\nThe HTML is longer. ShipWarden cut it at ${element.html.length} characters.` : '';
    sections.push(`HTML:\n\n${marker}html\n${element.html}\n${marker}${cut}`);
    const text = note.trim();
    sections.push(text || 'Read the element. Then wait for my instructions.');
    return sections.join('\n\n');
}
