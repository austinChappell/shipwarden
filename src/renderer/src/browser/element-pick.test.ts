// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
    CANCEL_PICK_SCRIPT,
    DESCRIBE_ELEMENT_SCRIPT,
    elementPrompt,
    PICK_SCRIPT,
    pickCall,
    visibleCrop,
    type ElementPick,
    type PickedElement
} from '@shared/element-pick';

/**
 * Runs a page script in the global scope of jsdom, as executeJavaScript does. This test is in the page folder,
 * because it needs the DOM types.
 */
function run<T>(script: string, argument: unknown): T {
    return new Function(`return ${pickCall(script, argument)}`)() as T;
}

function describeAt(selector: string, maxHtml = 6000): PickedElement {
    const result = run<PickedElement | null>(DESCRIBE_ELEMENT_SCRIPT, { selector, maxHtml });
    if (!result) throw new Error(`No element for ${selector}`);
    return result;
}

/** Returns the selector of the element and checks that it matches only that element. */
function selectorFor(selector: string): string {
    const element = document.querySelector(selector);
    const built = describeAt(selector).selector;
    const matches = document.querySelectorAll(built);
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe(element);
    return built;
}

describe('the selector builder', () => {
    it('uses a unique id', () => {
        document.body.innerHTML = '<main><button id="save">Save</button></main>';
        expect(selectorFor('button')).toBe('#save');
    });

    it('does not use a generated id or a duplicated id', () => {
        document.body.innerHTML = '<div id=":r1:"><span>A</span></div><p id="x">1</p><p id="x">2</p>';
        expect(selectorFor('span')).toBe('span');
        expect(selectorFor('p:nth-of-type(2)')).toBe('p:nth-of-type(2)');
    });

    it('uses a unique test attribute', () => {
        document.body.innerHTML = '<ul><li data-testid="row">A</li><li data-testid="other">B</li></ul>';
        expect(selectorFor('li:nth-child(2)')).toBe('[data-testid="other"]');
    });

    it('stops the path at an ancestor with a unique id', () => {
        document.body.innerHTML =
            '<section id="cart"><div><a>One</a></div><div><a>Two</a></div></section><section><div><a>Three</a></div><div><a>Four</a></div></section>';
        expect(selectorFor('#cart div:nth-of-type(2) a')).toBe('#cart > div:nth-of-type(2) > a');
    });

    it('uses stable classes and skips generated classes', () => {
        document.body.innerHTML = '<nav><a class="link css-1x2y3z">A</a><a class="link active sc-abc">B</a><a class="link">C</a></nav>';
        expect(selectorFor('a.active')).toBe('a.link.active');
    });

    it('adds :nth-of-type for siblings that look the same', () => {
        document.body.innerHTML = '<ul><li>A</li><li>B</li><li>C</li></ul><ol><li>D</li><li>E</li><li>F</li></ol>';
        expect(selectorFor('ul li:nth-of-type(3)')).toBe('ul > li:nth-of-type(3)');
    });

    it('escapes a class that starts with a digit or has special characters', () => {
        document.body.innerHTML = '<div><b class="1st">A</b><b class="w-1/2">B</b><b>C</b></div>';
        selectorFor('b:nth-of-type(1)');
        expect(selectorFor('b:nth-of-type(2)')).toBe('b.w-1\\/2');
    });
});

describe('DESCRIBE_ELEMENT_SCRIPT', () => {
    it('returns the HTML without refs, the text, and the styles that are not defaults', () => {
        document.title = 'Shop';
        document.body.innerHTML = '<button id="buy" data-shipwarden-ref="4" style="display:flex; color: red; opacity: 1">Buy   now</button>';
        const element = describeAt('#buy');
        expect(element.title).toBe('Shop');
        expect(element.tag).toBe('button');
        expect(element.html).not.toContain('data-shipwarden-ref');
        expect(element.text).toBe('Buy now');
        expect(element.htmlTruncated).toBe(false);
        expect(element.styles.display).toBe('flex');
        expect(element.styles.color).toBe('rgb(255, 0, 0)');
        expect(element.styles).not.toHaveProperty('opacity');
    });

    it('cuts long HTML', () => {
        document.body.innerHTML = `<div id="big">${'<p>text</p>'.repeat(100)}</div>`;
        const element = describeAt('#big', 50);
        expect(element.html.length).toBe(50);
        expect(element.htmlTruncated).toBe(true);
    });

    it('returns null when no element matches', () => {
        document.body.innerHTML = '';
        expect(run(DESCRIBE_ELEMENT_SCRIPT, { selector: '#none', maxHtml: 10 })).toBeNull();
    });
});

describe('PICK_SCRIPT', () => {
    it('picks the element of the press and blocks the click for the page', async () => {
        document.body.innerHTML = '<button id="go">Go</button>';
        const button = document.getElementById('go') as HTMLButtonElement;
        let clicks = 0;
        button.addEventListener('click', () => clicks++);
        const pick = run<Promise<PickedElement | null>>(PICK_SCRIPT, { maxHtml: 1000 });
        button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        expect(document.documentElement.querySelectorAll(':scope > div').length).toBe(2);
        button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const result = await pick;
        expect(result?.selector).toBe('#go');
        expect(clicks).toBe(0);
        // The box is gone.
        expect(document.documentElement.querySelectorAll(':scope > div').length).toBe(0);
    });

    it('resolves with null on Escape and on the cancel script', async () => {
        document.body.innerHTML = '<p>Text</p>';
        const first = run<Promise<unknown>>(PICK_SCRIPT, { maxHtml: 1000 });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(await first).toBeNull();
        const second = run<Promise<unknown>>(PICK_SCRIPT, { maxHtml: 1000 });
        expect(new Function(`return ${CANCEL_PICK_SCRIPT}`)()).toBe(true);
        expect(await second).toBeNull();
    });
});

describe('visibleCrop', () => {
    const viewport = { width: 800, height: 600 };

    it('returns the box of an element in the viewport, with the zoom', () => {
        expect(visibleCrop({ x: 10, y: 20, width: 100, height: 50 }, viewport, 1.5)).toEqual({
            rect: { x: 15, y: 30, width: 150, height: 75 },
            partial: false
        });
    });

    it('cuts an element at the edges of the viewport', () => {
        expect(visibleCrop({ x: -20, y: 500, width: 100, height: 300 }, viewport)).toEqual({
            rect: { x: 0, y: 500, width: 80, height: 100 },
            partial: true
        });
    });

    it('returns undefined for an element outside the viewport or without a size', () => {
        expect(visibleCrop({ x: 0, y: 700, width: 100, height: 50 }, viewport)).toBeUndefined();
        expect(visibleCrop({ x: 10, y: 10, width: 0, height: 0 }, viewport)).toBeUndefined();
    });
});

describe('elementPrompt', () => {
    const element: PickedElement = {
        url: 'http://localhost:3000/cart',
        title: 'Cart',
        tag: 'button',
        selector: '#buy',
        html: '<button id="buy">Buy</button>',
        htmlTruncated: false,
        text: 'Buy',
        styles: { display: 'flex', color: 'rgb(255, 0, 0)' },
        rect: { x: 10, y: 20, width: 120, height: 32 },
        viewport: { width: 1280, height: 800 }
    };

    it('gives the page, the selector, the size, the screenshot, the styles, the HTML, and the note', () => {
        const pick: ElementPick = { element, imagePath: '/tmp/element.png' };
        expect(elementPrompt({ pick, note: '  Make it blue.  ' })).toBe(
            [
                'I picked an element in the in-app browser of ShipWarden, on the page http://localhost:3000/cart ("Cart").',
                '- Selector: `#buy`',
                '- Size: 120 × 32 px at x 10, y 20 of a 1280 × 800 px viewport.',
                '- Text: "Buy"',
                '- Screenshot of the element: /tmp/element.png. Read this image file.',
                '',
                'Computed styles:',
                '- display: flex',
                '- color: rgb(255, 0, 0)',
                '',
                'HTML:',
                '',
                '```html',
                '<button id="buy">Buy</button>',
                '```',
                '',
                'Make it blue.'
            ].join('\n')
        );
    });

    it('says when the image is partial and the HTML is cut, and asks the agent to wait without a note', () => {
        const pick: ElementPick = {
            element: { ...element, title: '', text: '', styles: {}, html: '<div>```</div>', htmlTruncated: true },
            imagePath: '/tmp/a.png',
            imagePartial: true
        };
        const prompt = elementPrompt({ pick, note: '' });
        expect(prompt).toContain('on the page http://localhost:3000/cart.\n');
        expect(prompt).toContain('It shows only the part of the element that is in the viewport.');
        expect(prompt).not.toContain('Text:');
        expect(prompt).not.toContain('Computed styles');
        expect(prompt).toContain('````html\n<div>```</div>\n````');
        expect(prompt).toContain('ShipWarden cut it at 14 characters.');
        expect(prompt.endsWith('Read the element. Then wait for my instructions.')).toBe(true);
    });

    it('has no screenshot line without an image', () => {
        expect(elementPrompt({ pick: { element }, note: 'x' })).not.toContain('Screenshot');
    });
});
