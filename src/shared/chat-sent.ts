/** A prompt that the chat gave to the agent. */
export interface SentPromptMark {
    text: string;
    /** The number of user prompts in the transcript when the chat sent the prompt. */
    users: number;
}

/** Makes text easy to compare: one space between the words, and no space at the start or the end. */
function normalized(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Returns the sent prompts that the transcript does not have yet, in their order. `userTexts` are the texts of the
 * user prompts in the transcript, oldest first. A sent prompt is in the transcript when a user prompt after the
 * count of the prompt has the same text, or contains the text. Claude Code can join prompts into one. Each user
 * prompt settles one sent prompt with the same text. A prompt with only images settles at the next user prompt.
 */
export function unsettledPrompts<T extends SentPromptMark>(sent: readonly T[], userTexts: readonly string[]): T[] {
    const texts = userTexts.map(normalized);
    const used = new Set<number>();
    return sent.filter(prompt => {
        const wanted = normalized(prompt.text);
        for (let index = prompt.users; index < texts.length; index++) {
            if (used.has(index)) continue;
            if (!wanted || texts[index] === wanted || texts[index].includes(wanted)) {
                // A joined prompt can settle more than one sent prompt. An exact match settles only one.
                if (texts[index] === wanted || !wanted) used.add(index);
                return false;
            }
        }
        return true;
    });
}
