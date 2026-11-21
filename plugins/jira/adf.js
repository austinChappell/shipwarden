// Converts the Atlassian Document Format (ADF) of Jira to Markdown, and Markdown to ADF.
// The module is pure: it has no state and sends no requests.
// The ADF structure: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
//
// The Markdown follows GitHub and the task view of ShipWarden, where a single newline is a line break.

/** The order of the marks from the outside to the inside. A link is the outermost mark. */
const MARK_ORDER = ['link', 'strong', 'em', 'strike'];

/** Characters that have a meaning in Markdown text. The converter puts a backslash before them. */
const ESCAPED = /[\\*_`[\]~]/g;

/** Returns the Markdown of an ADF document. An empty or absent document gives an empty string. */
export function adfToMarkdown(doc) {
    if (!doc) {
        return '';
    }
    if (typeof doc === 'string') {
        return doc;
    }
    return blocks(doc.content ?? [])
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Returns the Markdown of a list of block nodes. A blank line separates two blocks. */
function blocks(nodes) {
    return nodes
        .map(block)
        .filter(text => text !== '')
        .join('\n\n');
}

function block(node) {
    switch (node.type) {
        case 'paragraph':
            return inline(node.content ?? []);
        case 'heading': {
            const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
            return `${'#'.repeat(level)} ${inline(node.content ?? [])}`;
        }
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
        case 'decisionList':
            return list(node);
        case 'codeBlock':
            return codeBlock(node);
        case 'blockquote':
        case 'panel':
            return quote(blocks(node.content ?? []));
        case 'rule':
            return '---';
        case 'table':
            return table(node);
        case 'mediaSingle':
        case 'mediaGroup':
            return (node.content ?? []).map(media).join(' ');
        case 'media':
            return media(node);
        case 'expand':
        case 'nestedExpand': {
            const title = node.attrs?.title ? `**${escapeText(node.attrs.title)}**` : '';
            return [title, blocks(node.content ?? [])].filter(Boolean).join('\n\n');
        }
        case 'blockCard':
        case 'embedCard':
            return node.attrs?.url ? `<${node.attrs.url}>` : '';
        default:
            return unknown(node, blocks);
    }
}

/** A node that the converter does not know: its child nodes, else its text, else nothing. */
function unknown(node, convert) {
    if (Array.isArray(node.content) && node.content.length > 0) {
        return convert(node.content);
    }
    if (typeof node.text === 'string') {
        return escapeText(node.text);
    }
    if (typeof node.attrs?.text === 'string') {
        return escapeText(node.attrs.text);
    }
    return '';
}

/** A placeholder for an attachment. ADF has no URL for a file, only an ID, so the Markdown has no link. */
function media(node) {
    const name = node.attrs?.alt || node.attrs?.fileName;
    return name ? `[Attachment: ${escapeText(name)}]` : '[Attachment]';
}

function codeBlock(node) {
    const text = (node.content ?? []).map(child => child.text ?? '').join('');
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${node.attrs?.language ?? ''}\n${text}\n${fence}`;
}

function quote(text) {
    return text
        .split('\n')
        .map(line => (line ? `> ${line}` : '>'))
        .join('\n');
}

/** A list. The child nodes of an item go below the first line, with the indent of the marker. */
function list(node) {
    let number = Number(node.attrs?.order) || 1;
    return (node.content ?? [])
        .map(item => {
            let marker = '- ';
            if (node.type === 'orderedList') {
                marker = `${number++}. `;
            } else if (item.type === 'taskItem') {
                marker = item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] ';
            }
            return listItem(item, marker);
        })
        .join('\n');
}

function listItem(item, marker) {
    // A task item and a decision item have inline content. A list item has blocks.
    const isInline = (item.content ?? []).some(child => child.type === 'text' || child.type === 'hardBreak' || child.type === 'mention');
    let body;
    if (isInline) {
        body = inline(item.content ?? []);
    } else {
        // A nested list follows the text of the item on the next line, so the list stays tight.
        body = (item.content ?? [])
            .map((child, index) => {
                const text = block(child);
                const isList = /List$/.test(child.type);
                return index === 0 ? text : `${isList ? '\n' : '\n\n'}${text}`;
            })
            .join('');
    }
    const indent = ' '.repeat(marker.length);
    return (
        marker +
        body
            .split('\n')
            .map((line, index) => (index === 0 || line === '' ? line : indent + line))
            .join('\n')
    );
}

/** A table. Markdown tables need a header row, so the first row is the header. */
function table(node) {
    const rows = (node.content ?? []).map(row => (row.content ?? []).map(cell => cellText(cell)));
    if (rows.length === 0) {
        return '';
    }
    const width = Math.max(...rows.map(row => row.length));
    const line = cells => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
    return [line(rows[0]), line(Array.from({ length: width }, () => '---')), ...rows.slice(1).map(line)].join('\n');
}

/** The text of a table cell on one line. A Markdown cell cannot have a line break or a "|". */
function cellText(cell) {
    return blocks(cell.content ?? [])
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
}

/** Returns the Markdown of inline nodes. The marks of adjacent text nodes merge, so "**a b**" stays one bold part. */
function inline(nodes) {
    let out = '';
    /** The marks that are open now, from the outside to the inside. */
    const open = [];
    const closeTo = count => {
        while (open.length > count) {
            out += closer(open.pop());
        }
    };
    for (const node of nodes) {
        const marks = node.type === 'text' ? sortedMarks(node.marks) : [];
        let same = 0;
        while (same < open.length && same < marks.length && markKey(open[same]) === markKey(marks[same])) {
            same++;
        }
        closeTo(same);
        for (const mark of marks.slice(same)) {
            out += opener(mark);
            open.push(mark);
        }
        out += inlineNode(node);
    }
    closeTo(0);
    return out;
}

function sortedMarks(marks = []) {
    return marks.filter(mark => MARK_ORDER.includes(mark.type)).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function markKey(mark) {
    return mark.type === 'link' ? `link:${mark.attrs?.href}` : mark.type;
}

function opener(mark) {
    return { link: '[', strong: '**', em: '*', strike: '~~' }[mark.type];
}

function closer(mark) {
    return mark.type === 'link' ? `](${mark.attrs?.href ?? ''})` : opener(mark);
}

function inlineNode(node) {
    switch (node.type) {
        case 'text':
            return (node.marks ?? []).some(mark => mark.type === 'code') ? code(node.text ?? '') : escapeText(node.text ?? '');
        case 'hardBreak':
            return '\n';
        case 'mention': {
            const text = node.attrs?.text || node.attrs?.id || '';
            return escapeText(text.startsWith('@') ? text : `@${text}`);
        }
        case 'emoji':
            return node.attrs?.text || node.attrs?.shortName || '';
        case 'inlineCard':
            return node.attrs?.url ? `<${node.attrs.url}>` : '';
        case 'date': {
            const time = Number(node.attrs?.timestamp);
            return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
        }
        case 'status':
            return node.attrs?.text ? `[${escapeText(node.attrs.text)}]` : '';
        case 'mediaInline':
            return media(node);
        case 'placeholder':
            return '';
        default:
            return unknown(node, inline);
    }
}

function code(text) {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
    const ticks = '`'.repeat(longest + 1);
    const pad = longest > 0 ? ' ' : '';
    return `${ticks}${pad}${text}${pad}${ticks}`;
}

function escapeText(text) {
    return text.replace(ESCAPED, '\\$&');
}

/** The node types that `markdownToAdf` can make again. A description with other nodes loses parts after an edit. */
const SAFE_NODES = new Set([
    'doc',
    'paragraph',
    'text',
    'heading',
    'bulletList',
    'orderedList',
    'listItem',
    'codeBlock',
    'blockquote',
    'rule',
    'hardBreak',
    'emoji',
    'table',
    'tableRow',
    'tableHeader',
    'tableCell'
]);
const SAFE_MARKS = new Set(['strong', 'em', 'code', 'strike', 'link']);

/**
 * Returns true when Markdown from `adfToMarkdown` gives the same document again after `markdownToAdf`.
 * Attachments, mentions, panels, colors, and other nodes do not come back, so an edit of such a description loses them.
 */
export function isRoundTripSafe(doc) {
    if (!doc || typeof doc === 'string') {
        return true;
    }
    const safe = node => {
        if (!SAFE_NODES.has(node.type)) {
            return false;
        }
        if ((node.marks ?? []).some(mark => !SAFE_MARKS.has(mark.type))) {
            return false;
        }
        if (node.type === 'tableHeader' || node.type === 'tableCell') {
            const content = node.content ?? [];
            const spans = Number(node.attrs?.colspan ?? 1) > 1 || Number(node.attrs?.rowspan ?? 1) > 1;
            if (spans || content.length > 1 || content.some(child => child.type !== 'paragraph')) {
                return false;
            }
        }
        return (node.content ?? []).every(safe);
    };
    return safe(doc);
}

// Markdown to ADF.

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HEADING = /^#{1,6}\s+/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Returns the ADF document of Markdown text. Empty text gives null, so Jira clears the field.
 * `mentions` ({ id, name }) change "@" and the name to native mentions, so Jira notifies the person.
 */
export function markdownToAdf(markdown, { mentions = [] } = {}) {
    const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
    if (!text.trim()) {
        return null;
    }
    const context = { mentions: [...mentions].filter(item => item?.id && item?.name).sort((a, b) => b.name.length - a.name.length) };
    return { type: 'doc', version: 1, content: parseBlocks(text.split('\n'), context) };
}

function isTableStart(lines, index) {
    return lines[index]?.includes('|') && TABLE_SEPARATOR.test(lines[index + 1] ?? '') && lines[index + 1].includes('-');
}

/** True when a line starts a block, so it ends the paragraph before it. */
function startsBlock(lines, index) {
    const line = lines[index];
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(lines, index);
}

function parseBlocks(lines, context) {
    const nodes = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            index++;
            continue;
        }
        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[2];
            const body = [];
            index++;
            while (
                index < lines.length &&
                !(lines[index].trim().startsWith(marker[0].repeat(marker.length)) && !lines[index].trim().slice(marker.length).trim())
            ) {
                body.push(lines[index]);
                index++;
            }
            index++;
            const text = body.join('\n');
            nodes.push({
                type: 'codeBlock',
                ...(fence[3] ? { attrs: { language: fence[3] } } : {}),
                ...(text ? { content: [{ type: 'text', text }] } : {})
            });
            continue;
        }
        if (HEADING.test(line)) {
            const level = /^#+/.exec(line)[0].length;
            nodes.push({ type: 'heading', attrs: { level }, content: parseInline(line.replace(HEADING, '').replace(/\s+#+\s*$/, ''), context) });
            index++;
            continue;
        }
        if (RULE.test(line)) {
            nodes.push({ type: 'rule' });
            index++;
            continue;
        }
        if (QUOTE.test(line)) {
            const body = [];
            while (index < lines.length && QUOTE.test(lines[index])) {
                body.push(lines[index].replace(/^\s{0,3}> ?/, ''));
                index++;
            }
            nodes.push({ type: 'blockquote', content: parseBlocks(body, context) });
            continue;
        }
        if (LIST_ITEM.test(line)) {
            const { node, next } = parseList(lines, index, context);
            nodes.push(node);
            index = next;
            continue;
        }
        if (isTableStart(lines, index)) {
            const rows = [splitRow(line)];
            index += 2;
            while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
                rows.push(splitRow(lines[index]));
                index++;
            }
            nodes.push(tableNode(rows, context));
            continue;
        }
        const body = [line];
        index++;
        while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
            body.push(lines[index]);
            index++;
        }
        nodes.push(paragraph(body, context));
    }
    return nodes;
}

/** A paragraph. Each newline is a hard break, as in the task view. */
function paragraph(lines, context) {
    const content = [];
    lines.forEach((line, index) => {
        if (index > 0) {
            content.push({ type: 'hardBreak' });
        }
        content.push(...parseInline(line.trim().replace(/\\$/, ''), context));
    });
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function leadingSpaces(line) {
    return /^\s*/.exec(line)[0].length;
}

/** Parses a list that starts at `start`. An item holds the lines that have more indent than its marker. */
function parseList(lines, start, context) {
    const first = LIST_ITEM.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let index = start;
    while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index]);
        if (!match || match[1].length !== indent || /\d/.test(match[2]) !== ordered) {
            break;
        }
        const contentIndent = indent + match[2].length + 1;
        const body = [match[3]];
        index++;
        while (index < lines.length) {
            const line = lines[index];
            if (!line.trim()) {
                const next = lines.slice(index + 1).find(item => item.trim());
                if (next !== undefined && leadingSpaces(next) > indent) {
                    body.push('');
                    index++;
                    continue;
                }
                break;
            }
            if (leadingSpaces(line) > indent) {
                body.push(line.slice(Math.min(contentIndent, leadingSpaces(line))));
                index++;
                continue;
            }
            if (!startsBlock(lines, index) && body.at(-1)?.trim()) {
                // A lazy line continues the text of the item.
                body.push(line.trim());
                index++;
                continue;
            }
            break;
        }
        const content = parseBlocks(body, context);
        items.push({ type: 'listItem', content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content] });
        // A blank line between items does not end the list.
        if (!lines[index]?.trim()) {
            const nextIndex = lines.findIndex((item, position) => position > index && item.trim());
            const next = nextIndex === -1 ? undefined : LIST_ITEM.exec(lines[nextIndex]);
            if (next && next[1].length === indent && /\d/.test(next[2]) === ordered) {
                index = nextIndex;
            }
        }
    }
    const node = ordered
        ? { type: 'orderedList', attrs: { order: Number.parseInt(first[2], 10) || 1 }, content: items }
        : { type: 'bulletList', content: items };
    return { node, next: index };
}

/** Splits a table row at each "|" that has no backslash before it. */
function splitRow(line) {
    let text = line.trim();
    if (text.startsWith('|')) {
        text = text.slice(1);
    }
    if (text.endsWith('|') && !text.endsWith('\\|')) {
        text = text.slice(0, -1);
    }
    return text.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function tableNode(rows, context) {
    const width = rows[0].length;
    return {
        type: 'table',
        content: rows.map((row, rowIndex) => ({
            type: 'tableRow',
            content: Array.from({ length: width }, (_, cellIndex) => {
                const inlineNodes = parseInline(row[cellIndex] ?? '', context);
                return {
                    type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
                    content: [inlineNodes.length ? { type: 'paragraph', content: inlineNodes } : { type: 'paragraph' }]
                };
            })
        }))
    };
}

const URL_START = /^https?:\/\/[^\s<>]+/;

/** Parses inline Markdown: code, links, bold, italic, strikethrough, escapes, bare URLs, and mentions. */
export function parseInline(text, context = { mentions: [] }, marks = []) {
    const nodes = [];
    let plain = '';
    const flush = () => {
        if (plain) {
            pushText(nodes, plain, marks);
            plain = '';
        }
    };
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const rest = text.slice(index);
        if (char === '\\' && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1])) {
            plain += text[index + 1];
            index += 2;
            continue;
        }
        if (char === '`') {
            const ticks = /^`+/.exec(rest)[0];
            const end = text.indexOf(ticks, index + ticks.length);
            if (end !== -1) {
                flush();
                let body = text.slice(index + ticks.length, end);
                if (body.startsWith(' ') && body.endsWith(' ') && body.trim()) {
                    body = body.slice(1, -1);
                }
                const codeMarks = [...marks.filter(mark => mark.type === 'link'), { type: 'code' }];
                pushText(nodes, body, codeMarks);
                index = end + ticks.length;
                continue;
            }
        }
        if (char === '[') {
            const link = linkAt(text, index);
            if (link) {
                flush();
                nodes.push(...parseInline(link.label, context, withMark(marks, { type: 'link', attrs: { href: link.href } })));
                index = link.end;
                continue;
            }
        }
        if (char === '<') {
            const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest);
            if (auto) {
                flush();
                pushText(nodes, auto[1], withMark(marks, { type: 'link', attrs: { href: auto[1] } }));
                index += auto[0].length;
                continue;
            }
        }
        if ((char === 'h' || char === 'H') && !/\w/.test(text[index - 1] ?? '') && !marks.some(mark => mark.type === 'link')) {
            const url = URL_START.exec(rest);
            if (url) {
                const href = url[0].replace(/[.,;:!?)]+$/, '');
                flush();
                pushText(nodes, href, withMark(marks, { type: 'link', attrs: { href } }));
                index += href.length;
                continue;
            }
        }
        if (char === '@') {
            const mention = context.mentions?.find(item => rest.startsWith(`@${item.name}`));
            if (mention) {
                flush();
                nodes.push({ type: 'mention', attrs: { id: mention.id, text: `@${mention.name}` } });
                index += mention.name.length + 1;
                continue;
            }
        }
        const emphasis = emphasisAt(text, index);
        if (emphasis) {
            flush();
            nodes.push(...parseInline(emphasis.body, context, withMark(marks, { type: emphasis.mark })));
            index = emphasis.end;
            continue;
        }
        plain += char;
        index++;
    }
    flush();
    return nodes;
}

/** Adds a text node, or joins the text to the last node when the marks are the same. */
function pushText(nodes, text, marks) {
    const last = nodes.at(-1);
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) {
        last.text += text;
        return;
    }
    nodes.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
}

function withMark(marks, mark) {
    return marks.some(item => markKey(item) === markKey(mark)) ? marks : [...marks, mark];
}

/** Finds "[label](href)" at `index`. The label can hold brackets in pairs. */
function linkAt(text, index) {
    let depth = 0;
    for (let position = index; position < text.length; position++) {
        const char = text[position];
        if (char === '\\') {
            position++;
        } else if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
            if (depth === 0) {
                const target = /^\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(text.slice(position + 1));
                if (!target) {
                    return undefined;
                }
                return { label: text.slice(index + 1, position), href: target[1], end: position + 1 + target[0].length };
            }
        }
    }
    return undefined;
}

/** Finds bold ("**" or "__"), strikethrough ("~~") or italic ("*" or "_") at `index`. */
function emphasisAt(text, index) {
    const delimiters = [
        ['**', 'strong'],
        ['__', 'strong'],
        ['~~', 'strike'],
        ['*', 'em'],
        ['_', 'em']
    ];
    for (const [delimiter, mark] of delimiters) {
        if (!text.startsWith(delimiter, index)) {
            continue;
        }
        const before = text[index - 1] ?? '';
        const after = text[index + delimiter.length] ?? '';
        // An underscore inside a word, as in "snake_case", is not emphasis. A delimiter before a space does not open.
        if ((delimiter[0] === '_' && /\w/.test(before)) || !after || /\s/.test(after)) {
            continue;
        }
        let search = index + delimiter.length;
        while (search < text.length) {
            const end = text.indexOf(delimiter, search);
            if (end === -1) {
                break;
            }
            const inside = text.slice(index + delimiter.length, end);
            const next = text[end + delimiter.length] ?? '';
            const isDouble = delimiter.length === 1 && next === delimiter;
            const escaped = text[end - 1] === '\\';
            if (inside && !/\s$/.test(inside) && !isDouble && !escaped && !(delimiter[0] === '_' && /\w/.test(next))) {
                return { mark, body: inside, end: end + delimiter.length };
            }
            search = end + (isDouble ? 2 : 1);
        }
    }
    return undefined;
}
