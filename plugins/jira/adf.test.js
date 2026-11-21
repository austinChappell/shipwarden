import { describe, expect, it } from 'vitest';
import { adfToMarkdown, isRoundTripSafe, markdownToAdf, parseInline } from './adf.js';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = (...content) => ({ type: 'paragraph', content });
const text = (value, ...marks) => (marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const strong = { type: 'strong' };
const em = { type: 'em' };
const code = { type: 'code' };
const strike = { type: 'strike' };
const link = href => ({ type: 'link', attrs: { href } });
const item = (...content) => ({ type: 'listItem', content });
const bullets = (...items) => ({ type: 'bulletList', content: items });
const cell = (value, type = 'tableCell') => ({ type, attrs: {}, content: [p(text(value))] });

describe('ADF to Markdown', () => {
    it('returns an empty string for no document', () => {
        expect(adfToMarkdown(null)).toBe('');
        expect(adfToMarkdown(undefined)).toBe('');
        expect(adfToMarkdown(doc())).toBe('');
    });

    it('keeps a plain string, for an API that sends text', () => {
        expect(adfToMarkdown('Plain text')).toBe('Plain text');
    });

    it('separates paragraphs with a blank line', () => {
        expect(adfToMarkdown(doc(p(text('One')), p(text('Two')), { type: 'paragraph' }))).toBe('One\n\nTwo');
    });

    it('converts the headings of all levels', () => {
        const headings = [1, 2, 6].map(level => ({ type: 'heading', attrs: { level }, content: [text(`H${level}`)] }));
        expect(adfToMarkdown(doc(...headings))).toBe('# H1\n\n## H2\n\n###### H6');
    });

    it('converts the marks', () => {
        expect(adfToMarkdown(doc(p(text('b', strong), text(' '), text('i', em), text(' '), text('c', code), text(' '), text('s', strike))))).toBe(
            '**b** *i* `c` ~~s~~'
        );
    });

    it('merges the marks of adjacent text nodes', () => {
        expect(adfToMarkdown(doc(p(text('bold ', strong), text('and italic', strong, em), text(' end'))))).toBe('**bold *and italic*** end');
    });

    it('converts links, also with marks inside', () => {
        const url = 'https://example.com/a';
        expect(adfToMarkdown(doc(p(text('See '), text('the ', link(url)), text('docs', link(url), strong))))).toBe(`See [the **docs**](${url})`);
    });

    it('uses more backticks for code with a backtick', () => {
        expect(adfToMarkdown(doc(p(text('a`b', code))))).toBe('`` a`b ``');
    });

    it('escapes Markdown characters in text', () => {
        expect(adfToMarkdown(doc(p(text('snake_case and *stars* [x]'))))).toBe('snake\\_case and \\*stars\\* \\[x\\]');
    });

    it('converts bullet and ordered lists, also nested lists', () => {
        const nested = doc(bullets(item(p(text('One')), bullets(item(p(text('One A'))), item(p(text('One B'))))), item(p(text('Two')))), {
            type: 'orderedList',
            attrs: { order: 3 },
            content: [item(p(text('Three'))), item(p(text('Four')), { type: 'orderedList', content: [item(p(text('Deep')))] })]
        });
        expect(adfToMarkdown(nested)).toBe('- One\n  - One A\n  - One B\n- Two\n\n3. Three\n4. Four\n   1. Deep');
    });

    it('indents the second paragraph of a list item', () => {
        expect(adfToMarkdown(doc(bullets(item(p(text('First')), p(text('Second'))))))).toBe('- First\n\n  Second');
    });

    it('converts code blocks with the language', () => {
        const block = { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;\nconst b = 2;')] };
        expect(adfToMarkdown(doc(block))).toBe('```ts\nconst a = 1;\nconst b = 2;\n```');
        expect(adfToMarkdown(doc({ type: 'codeBlock', content: [text('a ``` b')] }))).toBe('````\na ``` b\n````');
    });

    it('converts block quotes and panels to quotes', () => {
        expect(adfToMarkdown(doc({ type: 'blockquote', content: [p(text('One')), p(text('Two'))] }))).toBe('> One\n>\n> Two');
        expect(adfToMarkdown(doc({ type: 'panel', attrs: { panelType: 'info' }, content: [p(text('Note'))] }))).toBe('> Note');
    });

    it('converts tables, with the first row as the header', () => {
        const table = {
            type: 'table',
            content: [
                { type: 'tableRow', content: [cell('Name', 'tableHeader'), cell('Value', 'tableHeader')] },
                { type: 'tableRow', content: [cell('a|b'), cell('1')] },
                { type: 'tableRow', content: [cell('short')] }
            ]
        };
        expect(adfToMarkdown(doc(table))).toBe('| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| short |  |');
    });

    it('converts mentions, emoji, and hard breaks', () => {
        const paragraph = p(
            { type: 'mention', attrs: { id: 'acc-1', text: '@Ann Lee' } },
            text(' says '),
            { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
            { type: 'hardBreak' },
            { type: 'emoji', attrs: { shortName: ':custom:' } },
            text(' '),
            { type: 'mention', attrs: { id: 'acc-2', text: 'Bob' } }
        );
        expect(adfToMarkdown(doc(paragraph))).toBe('@Ann Lee says 😄\n:custom: @Bob');
    });

    it('writes placeholders for attachments', () => {
        const single = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'f1', type: 'file', collection: 'c', alt: 'screen.png' } }] };
        const group = {
            type: 'mediaGroup',
            content: [
                { type: 'media', attrs: { id: 'f2' } },
                { type: 'media', attrs: { id: 'f3', fileName: 'log.txt' } }
            ]
        };
        expect(adfToMarkdown(doc(single, group))).toBe('[Attachment: screen.png]\n\n[Attachment] [Attachment: log.txt]');
    });

    it('converts cards, dates, statuses, and rules', () => {
        const paragraph = p(
            { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/ENG-1' } },
            text(' '),
            { type: 'date', attrs: { timestamp: '1763510400000' } },
            text(' '),
            { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue' } }
        );
        expect(adfToMarkdown(doc(paragraph, { type: 'rule' }))).toBe('<https://acme.atlassian.net/browse/ENG-1> 2025-11-19 [IN PROGRESS]\n\n---');
    });

    it('converts task lists to check boxes', () => {
        const tasks = {
            type: 'taskList',
            attrs: { localId: 'l' },
            content: [
                { type: 'taskItem', attrs: { localId: 'a', state: 'DONE' }, content: [text('Done')] },
                { type: 'taskItem', attrs: { localId: 'b', state: 'TODO' }, content: [text('Open')] }
            ]
        };
        expect(adfToMarkdown(doc(tasks))).toBe('- [x] Done\n- [ ] Open');
    });

    it('keeps the content of unknown nodes and drops unknown nodes without content', () => {
        const unknownBlock = { type: 'futureBlock', content: [p(text('Inside'))] };
        const unknownInline = p(text('A '), { type: 'futureInline', attrs: { text: 'label' } }, text(' '), { type: 'futureEmpty' }, text('B'));
        expect(adfToMarkdown(doc(unknownBlock, unknownInline, { type: 'extension', attrs: { extensionKey: 'x' } }))).toBe('Inside\n\nA label B');
    });

    it('converts an expand to a bold title and its content', () => {
        expect(adfToMarkdown(doc({ type: 'expand', attrs: { title: 'Details' }, content: [p(text('Hidden'))] }))).toBe('**Details**\n\nHidden');
    });
});

describe('Markdown to ADF', () => {
    it('returns null for empty text, so Jira clears the field', () => {
        expect(markdownToAdf('')).toBeNull();
        expect(markdownToAdf('  \n ')).toBeNull();
        expect(markdownToAdf(undefined)).toBeNull();
    });

    it('converts paragraphs, with each newline as a hard break', () => {
        expect(markdownToAdf('One\nline two\n\nNext')).toEqual(doc(p(text('One'), { type: 'hardBreak' }, text('line two')), p(text('Next'))));
    });

    it('converts headings, rules, quotes, and code blocks', () => {
        expect(markdownToAdf('## Title\n\n---\n\n> Quote\n\n```js\nlet a;\n```')).toEqual(
            doc(
                { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
                { type: 'rule' },
                { type: 'blockquote', content: [p(text('Quote'))] },
                { type: 'codeBlock', attrs: { language: 'js' }, content: [text('let a;')] }
            )
        );
    });

    it('converts nested lists', () => {
        expect(markdownToAdf('- One\n  - One A\n- Two\n\n3. Three\n4. Four')).toEqual(
            doc(bullets(item(p(text('One')), bullets(item(p(text('One A'))))), item(p(text('Two')))), {
                type: 'orderedList',
                attrs: { order: 3 },
                content: [item(p(text('Three'))), item(p(text('Four')))]
            })
        );
    });

    it('converts tables', () => {
        expect(markdownToAdf('| A | B |\n| --- | --- |\n| 1 | x\\|y |')).toEqual(
            doc({
                type: 'table',
                content: [
                    { type: 'tableRow', content: [cell('A', 'tableHeader'), cell('B', 'tableHeader')].map(({ attrs: _attrs, ...rest }) => rest) },
                    { type: 'tableRow', content: [cell('1'), cell('x|y')].map(({ attrs: _attrs, ...rest }) => rest) }
                ]
            })
        );
    });

    it('converts inline marks, links, and escapes', () => {
        expect(parseInline('**b** *i* `c` ~~s~~ [l](https://x.io) \\*no\\* snake_case')).toEqual([
            text('b', strong),
            text(' '),
            text('i', em),
            text(' '),
            text('c', code),
            text(' '),
            text('s', strike),
            text(' '),
            text('l', link('https://x.io')),
            text(' *no* snake_case')
        ]);
    });

    it('links bare URLs and keeps the punctuation after them', () => {
        expect(parseInline('See https://acme.atlassian.net/browse/ENG-1.')).toEqual([
            text('See '),
            text('https://acme.atlassian.net/browse/ENG-1', link('https://acme.atlassian.net/browse/ENG-1')),
            text('.')
        ]);
    });

    it('changes mentions to native mentions', () => {
        const adf = markdownToAdf('Hi @Ann Lee and @Ann', {
            mentions: [
                { id: 'a1', name: 'Ann' },
                { id: 'a2', name: 'Ann Lee' }
            ]
        });
        expect(adf.content[0].content).toEqual([
            text('Hi '),
            { type: 'mention', attrs: { id: 'a2', text: '@Ann Lee' } },
            text(' and '),
            { type: 'mention', attrs: { id: 'a1', text: '@Ann' } }
        ]);
    });
});

describe('ADF round trip', () => {
    const samples = [
        doc(p(text('Plain '), text('bold', strong), text(' and '), text('code', code))),
        doc(
            { type: 'heading', attrs: { level: 3 }, content: [text('Steps')] },
            bullets(item(p(text('One')), bullets(item(p(text('Nested'))))), item(p(text('Two'))))
        ),
        doc({ type: 'codeBlock', attrs: { language: 'sh' }, content: [text('npm test')] }),
        doc({ type: 'blockquote', content: [p(text('Quote'), { type: 'hardBreak' }, text('line'))] }),
        doc(p(text('snake_case *literal* [x]'), text(' link', link('https://example.com'))))
    ];

    it('gives the same document after Markdown and back', () => {
        for (const sample of samples) {
            expect(isRoundTripSafe(sample)).toBe(true);
            expect(markdownToAdf(adfToMarkdown(sample))).toEqual(sample);
        }
    });

    it('marks documents with attachments, mentions, panels, or colors as not safe to edit', () => {
        expect(isRoundTripSafe(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] }))).toBe(false);
        expect(isRoundTripSafe(doc(p({ type: 'mention', attrs: { id: 'a' } })))).toBe(false);
        expect(isRoundTripSafe(doc({ type: 'panel', content: [p(text('x'))] }))).toBe(false);
        expect(isRoundTripSafe(doc(p(text('red', { type: 'textColor', attrs: { color: '#f00' } }))))).toBe(false);
        expect(
            isRoundTripSafe(doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [] }] }] }))
        ).toBe(false);
        expect(isRoundTripSafe(null)).toBe(true);
    });
});
