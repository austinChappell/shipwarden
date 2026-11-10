import { useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { REACTION_INFO, reactionKinds, type PullRequest, type Reaction, type ReactionContent, type RepoTarget } from '@shared/github';
import { setReaction } from '../github/pull-request-mutations';
import { errorText } from '../util';

/** The reactions that the host accepts, and the function that adds or removes a reaction of the user. */
export interface ReactionActions {
    kinds: readonly ReactionContent[];
    /** Adds (`on`) or removes a reaction. `subjectId` is the `id` of a comment or a review. */
    toggle(subjectId: string, content: ReactionContent, on: boolean): Promise<void>;
}

/** Returns the reaction actions for the comments and the reviews of a pull request. */
export function reactionActions(target: RepoTarget, pr: PullRequest): ReactionActions {
    return {
        kinds: reactionKinds(pr),
        toggle: (subjectId, content, on) => setReaction(target, pr, subjectId, content, on)
    };
}

function reactionTitle(reaction: Reaction): string {
    const { label } = REACTION_INFO[reaction.content];
    const users = reaction.count === 1 ? '1 person' : `${reaction.count} people`;
    return `${label}: ${users}. ${reaction.viewerHasReacted ? 'Click to remove your reaction.' : 'Click to add your reaction.'}`;
}

/**
 * The reactions of a comment or a review, and a button that adds a reaction.
 * A click on a reaction adds it or removes it. The picker shows only the reactions that the host accepts.
 * Nothing shows when the item has no reactions from the host (for example a comment that exists only in the cache).
 */
export function Reactions({ subjectId, reactions, actions }: { subjectId: string; reactions: readonly Reaction[] | undefined; actions?: ReactionActions }) {
    const [picking, setPicking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    if (!actions || !reactions || actions.kinds.length === 0) return null;
    const { kinds } = actions;

    const toggle = async (content: ReactionContent, on: boolean) => {
        setBusy(true);
        setError(undefined);
        setPicking(false);
        try {
            await actions.toggle(subjectId, content, on);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const has = (content: ReactionContent) => reactions.some(reaction => reaction.content === content && reaction.viewerHasReacted);
    // With one reaction (for example the like of Azure DevOps), the add button adds it at once.
    const single = kinds.length === 1 ? kinds[0] : undefined;
    const canAdd = kinds.some(content => !has(content));

    return (
        <div className="reactions">
            {reactions.map(reaction => (
                <button
                    key={reaction.content}
                    type="button"
                    className={`reaction-chip${reaction.viewerHasReacted ? ' on' : ''}`}
                    aria-pressed={reaction.viewerHasReacted}
                    title={reactionTitle(reaction)}
                    disabled={busy}
                    onClick={() => toggle(reaction.content, !reaction.viewerHasReacted)}
                >
                    <span className="reaction-emoji">{REACTION_INFO[reaction.content].emoji}</span>
                    {reaction.count}
                </button>
            ))}
            {canAdd && (
                <button
                    type="button"
                    className={`reaction-add${picking ? ' on' : ''}`}
                    title={single ? `Add ${REACTION_INFO[single].label.toLowerCase()}` : 'Add a reaction'}
                    aria-expanded={single ? undefined : picking}
                    disabled={busy}
                    onClick={() => (single ? toggle(single, true) : setPicking(value => !value))}
                >
                    <SmilePlus size={14} strokeWidth={1.6} />
                </button>
            )}
            {picking && (
                <div className="reaction-picker" role="group" aria-label="Reactions">
                    {kinds.map(content => (
                        <button
                            key={content}
                            type="button"
                            className={`reaction-option${has(content) ? ' on' : ''}`}
                            title={REACTION_INFO[content].label}
                            aria-pressed={has(content)}
                            disabled={busy}
                            onClick={() => toggle(content, !has(content))}
                        >
                            {REACTION_INFO[content].emoji}
                        </button>
                    ))}
                </div>
            )}
            {error && <div className="form-error reaction-error">{error}</div>}
        </div>
    );
}
