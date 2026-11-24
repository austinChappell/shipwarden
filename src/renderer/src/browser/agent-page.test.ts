// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CLICK_SCRIPT, pageCall, READ_PAGE_SCRIPT, TYPE_SCRIPT, type ActResult, type PageRead } from '@shared/agent-page';

/**
 * Shows the HTML in the document of the test. The scripts run with the globals of jsdom, as in a page.
 * This test is in the page folder, because it needs the DOM types.
 */
function page(html: string) {
    document.title = 'Form';
    document.body.innerHTML = html;
    // The function runs the script in the global scope, as executeJavaScript does.
    const run = <T>(script: string, argument: unknown): T => new Function(`return ${pageCall(script, argument)}`)() as T;
    return { document, run };
}

const FORM = `
    <h1>Sign up</h1>
    <form id="f">
        <label for="name">Name</label><input id="name" name="name" value="">
        <input type="password" id="pw" value="secret">
        <input type="hidden" name="csrf" value="x">
        <select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select>
        <button type="submit">Save</button>
        <button style="display:none">Hidden</button>
    </form>
    <a href="/help">Help</a>
    <div contenteditable="true" aria-label="Notes"></div>`;

describe('READ_PAGE_SCRIPT', () => {
    it('returns the text and the visible interactive elements with refs, without passwords', () => {
        const { run } = page(FORM);
        const result = run<PageRead>(READ_PAGE_SCRIPT, { maxChars: 1000, maxElements: 50 });
        expect(result.url).toBe('http://localhost:3000/');
        expect(result.title).toBe('Form');
        expect(result.text).toContain('Sign up');
        expect(result.elements.map(item => [item.ref, item.tag, item.name])).toEqual([
            [1, 'input', 'Name'],
            [2, 'input', ''],
            [3, 'select', ''],
            [4, 'button', 'Save'],
            [5, 'a', 'Help'],
            [6, 'div', 'Notes']
        ]);
        expect(result.elements[1]).not.toHaveProperty('value');
        expect(result.elements[4].href).toBe('http://localhost:3000/help');
    });

    it('keeps the refs on a second read and cuts the text', () => {
        const { run } = page(FORM);
        run(READ_PAGE_SCRIPT, { maxChars: 1000, maxElements: 50 });
        const again = run<PageRead>(READ_PAGE_SCRIPT, { maxChars: 4, maxElements: 2 });
        expect(again.elements.map(item => item.ref)).toEqual([1, 2]);
        expect(again.text).toHaveLength(4);
        expect(again.truncated).toBe(true);
    });

    it('gives an error for a selector without a match', () => {
        expect(page(FORM).run<{ error: string }>(READ_PAGE_SCRIPT, { selector: '#nope', maxChars: 10, maxElements: 10 }).error).toContain('#nope');
    });
});

describe('CLICK_SCRIPT', () => {
    it('clicks the element with the text, the selector, or the ref', () => {
        const { run, document } = page(FORM);
        let clicks = 0;
        document.querySelector('a')!.addEventListener('click', (event: Event) => {
            event.preventDefault();
            clicks += 1;
        });
        expect(run<ActResult>(CLICK_SCRIPT, { text: 'help' })).toEqual({ ok: true, element: '<a> "Help"' });
        expect(run<ActResult>(CLICK_SCRIPT, { selector: 'a[href="/help"]' }).ok).toBe(true);
        run(READ_PAGE_SCRIPT, { maxChars: 10, maxElements: 50 });
        expect(run<ActResult>(CLICK_SCRIPT, { ref: 5 }).ok).toBe(true);
        expect(clicks).toBe(3);
    });

    it('gives clear errors', () => {
        const { run } = page(FORM);
        expect(run<ActResult>(CLICK_SCRIPT, { ref: 99 })).toEqual({ ok: false, error: expect.stringContaining('Call read_page again') });
        expect(run<ActResult>(CLICK_SCRIPT, { selector: '[[' })).toEqual({ ok: false, error: '"[[" is not a valid CSS selector.' });
        expect(run<ActResult>(CLICK_SCRIPT, { text: 'Hidden' })).toEqual({ ok: false, error: expect.stringContaining('No interactive element') });
    });
});

describe('TYPE_SCRIPT', () => {
    it('sets the value with input events, adds text without clear, and selects an option', () => {
        const { run, document } = page(FORM);
        const input = document.querySelector<HTMLInputElement>('#name')!;
        const events: string[] = [];
        input.addEventListener('input', () => events.push('input'));
        input.addEventListener('change', () => events.push('change'));
        expect(run<ActResult>(TYPE_SCRIPT, { target: { text: 'Name' }, text: 'Ann', clear: true, submit: false })).toEqual({
            ok: true,
            element: '<input> "Name"'
        });
        run(TYPE_SCRIPT, { target: { selector: '#name' }, text: ' Lee', clear: false, submit: false });
        expect(input.value).toBe('Ann Lee');
        expect(events).toEqual(['input', 'change', 'input', 'change']);
        run(TYPE_SCRIPT, { target: { selector: '#plan' }, text: 'pro plan', clear: true, submit: false });
        expect(document.querySelector<HTMLSelectElement>('#plan')!.value).toBe('pro');
        expect(run<ActResult>(TYPE_SCRIPT, { target: { selector: '#plan' }, text: 'Gold', clear: true, submit: false }).ok).toBe(false);
    });

    it('submits the form of the field', () => {
        const { run, document } = page(FORM);
        let submitted = false;
        document.querySelector('form')!.addEventListener('submit', (event: Event) => {
            event.preventDefault();
            submitted = true;
        });
        run(TYPE_SCRIPT, { target: { selector: '#name' }, text: 'Ann', clear: true, submit: true });
        expect(submitted).toBe(true);
    });

    it('refuses an element that does not take text', () => {
        expect(page(FORM).run<ActResult>(TYPE_SCRIPT, { target: { text: 'Help' }, text: 'x', clear: true, submit: false })).toEqual({
            ok: false,
            error: 'The element <a> "Help" does not take text. Select a text field.'
        });
    });
});
