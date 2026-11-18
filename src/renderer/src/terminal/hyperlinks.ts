/**
 * Removes the OSC 8 hyperlinks from terminal output. The text of each link stays.
 *
 * ghostty-web 0.4 can stop in an endless loop when it resizes a terminal that has OSC 8 hyperlinks. Two or three
 * resizes between a wide and a narrow width are sufficient, for example a window that goes to full screen and back.
 * The loop is in the WASM engine and blocks the main thread, so the full window stops. The engine can also fail with
 * "memory access out of bounds" for these links. Then the draw loop of the terminal stops, and the terminal does not
 * show new output. Agents such as Claude Code write OSC 8 links for file paths and URLs.
 *
 * A link has the form ESC ] 8 ; params ; URI ST before the text, and ESC ] 8 ; ; ST after the text. ST is BEL or
 * ESC \. Output arrives in chunks, and a sequence can start in one chunk and end in the next chunk. Thus each
 * terminal has its own filter, and the filter keeps its state between chunks.
 *
 * The terminal finds plain URLs in the text itself, so a URL that is also the text of the link can still open.
 */

const LINK_START = '\x1b]8;';
const ESC = 0x1b;
const BEL = 0x07;

export class HyperlinkFilter {
    /** True while the filter is in a link sequence and removes its characters. */
    private inSequence = false;
    /** The end of the last chunk, when it can be the start of a sequence or of its ST. The next chunk completes it. */
    private tail = '';

    /** Returns the chunk without the link sequences. Holds a part of a sequence at the end until the next chunk. */
    filter(chunk: string): string {
        const data = this.tail + chunk;
        this.tail = '';
        let out = '';
        let index = 0;
        while (index < data.length) {
            if (this.inSequence) {
                const end = sequenceEnd(data, index);
                if (end === undefined) {
                    // The sequence continues in the next chunk. An ESC at the end can be the start of its ST.
                    if (data.charCodeAt(data.length - 1) === ESC) {
                        this.tail = '\x1b';
                    }
                    return out;
                }
                this.inSequence = false;
                index = end;
                continue;
            }
            const escAt = data.indexOf('\x1b', index);
            if (escAt < 0) {
                out += data.slice(index);
                break;
            }
            out += data.slice(index, escAt);
            if (data.startsWith(LINK_START, escAt)) {
                this.inSequence = true;
                index = escAt + LINK_START.length;
                continue;
            }
            const rest = data.slice(escAt);
            if (rest.length < LINK_START.length && LINK_START.startsWith(rest)) {
                // The chunk ends with the first characters of a link sequence. The next chunk tells if it is one.
                this.tail = rest;
                break;
            }
            out += '\x1b';
            index = escAt + 1;
        }
        return out;
    }
}

/**
 * Returns the index after the ST of the sequence that starts before `from`.
 * An ESC that does not start an ST also ends the sequence. Then the function returns the index of that ESC, so that
 * the filter keeps the next escape sequence.
 * Returns undefined when the data ends before the sequence ends.
 */
function sequenceEnd(data: string, from: number): number | undefined {
    for (let index = from; index < data.length; index++) {
        const code = data.charCodeAt(index);
        if (code === BEL) {
            return index + 1;
        }
        if (code === ESC) {
            if (index + 1 >= data.length) {
                return undefined;
            }
            return data[index + 1] === '\\' ? index + 2 : index;
        }
    }
    return undefined;
}
