import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The accent changes with the theme. In one theme it is green, in a different theme it is purple.
 * Thus a status in the accent color has a different meaning in each theme.
 * A status must use a status color: --pending, --warning, --ok, --danger, --info, or --purple.
 */

const FILES = ['styles.css', 'components/ui/ui.css'];

/** A class name that shows a status. The class name must be a full word, so ".pending-pill" does not match. */
const STATUS_CLASS =
    /\.(working|running|pending|queued|in_progress|success|failure|failed|passing|done|approved|merged|waiting|wait|warning|warn|review_required|re-review|needs-decision|attention|tone-wait|tone-ok|tone-fail|tone-merged)(?![\w-])/;

/** Returns each CSS rule of a file as a selector and a body. */
function rules(css: string): { selector: string; body: string }[] {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return withoutComments
        .split('}')
        .map(chunk => {
            const open = chunk.lastIndexOf('{');
            return { selector: chunk.slice(0, open).trim(), body: chunk.slice(open + 1) };
        })
        .filter(rule => rule.selector !== '');
}

describe('status colors', () => {
    it('do not use the accent', () => {
        const wrong: string[] = [];
        for (const file of FILES) {
            const css = readFileSync(join(__dirname, file), 'utf8');
            for (const rule of rules(css)) {
                if (STATUS_CLASS.test(rule.selector) && rule.body.includes('var(--accent)')) wrong.push(`${file}: ${rule.selector}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('find a status rule that uses the accent', () => {
        const css = '.pending-pill { color: var(--accent); }\n.dot.working { color: var(--accent); }';
        const found = rules(css).filter(rule => STATUS_CLASS.test(rule.selector) && rule.body.includes('var(--accent)'));
        expect(found.map(rule => rule.selector)).toEqual(['.dot.working']);
    });
});
