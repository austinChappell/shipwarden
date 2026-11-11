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

/** The state and the actions of the reactions of one comment or review. */
export interface ReactionState {
    subjectId: string;
    reactions: readonly Reaction[];
    kinds: readonly ReactionContent[];
    /** The one reaction that the host accepts (for example the like of Azure DevOps). Undefined when there are more. */
    single: ReactionContent | undefined;
    /** True when the user can add one more reaction. */
    canAdd: boolean;
    picking: boolean;
    busy: boolean;
    error: string | undefined;
    has(content: ReactionContent): boolean;
    toggle(content: ReactionContent, on: boolean): Promise<void>;
    /** Opens or closes the picker. With one reaction, it adds that reaction at once. */
    add(): void;
}

/**
 * Returns the reaction state of a comment or a review.
 * Returns undefined when the item has no reactions from the host (for example a comment that exists only in the cache).
 */
export function useReactionState(
    subjectId: string,
    reactions: readonly Reaction[] | undefined,
    actions: ReactionActions | undefined
): ReactionState | undefined {
    const [picking, setPicking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    if (!actions || !reactions || actions.kinds.length === 0) return undefined;
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
    const single = kinds.length === 1 ? kinds[0] : undefined;
    return {
        subjectId,
        reactions,
        kinds,
        single,
        canAdd: kinds.some(content => !has(content)),
        picking,
        busy,
        error,
        has,
        toggle,
        add: () => (single ? void toggle(single, true) : setPicking(value => !value))
    };
}

/** The button that adds a reaction. It opens the picker, or it adds the one reaction that the host accepts. */
export function ReactionAddButton({ state, className }: { state: ReactionState; className?: string }) {
    if (!state.canAdd) return null;
    const { single, picking } = state;
    return (
        <button
            type="button"
            className={`${className ?? 'reaction-add'}${picking ? ' on' : ''}`}
            title={single ? `Add ${REACTION_INFO[single].label.toLowerCase()}` : 'Add a reaction'}
            aria-expanded={single ? undefined : picking}
            disabled={state.busy}
            onClick={state.add}
        >
            <SmilePlus size={14} strokeWidth={1.6} />
        </button>
    );
}

/**
 * The reaction chips, the picker and the error of a comment or a review. A click on a chip adds or removes the reaction.
 * With `addButton`, the add button follows the chips. Nothing shows when there is nothing to show.
 */
export function ReactionList({ state, addButton, className }: { state: ReactionState; addButton?: boolean; className?: string }) {
    const { reactions, kinds, picking, busy, error, has, toggle } = state;
    const showAdd = addButton && state.canAdd;
    if (reactions.length === 0 && !picking && !error && !showAdd) return null;
    return (
        <div className={`reactions${className ? ` ${className}` : ''}`}>
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
            {showAdd && <ReactionAddButton state={state} />}
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

/**
 * The reactions of a comment or a review, and a button that adds a reaction after them.
 * The picker shows only the reactions that the host accepts.
 */
export function Reactions({ subjectId, reactions, actions }: { subjectId: string; reactions: readonly Reaction[] | undefined; actions?: ReactionActions }) {
    const state = useReactionState(subjectId, reactions, actions);
    return state ? <ReactionList state={state} addButton /> : null;
}
