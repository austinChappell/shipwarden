import { answerProse, applyProposal, explorePrompt, parseProposal, type PromptRepo } from '@shared/plans';
import { errorText } from '../util';
import { cachedPlan, exploreStateOf, setExploreState, updatePlan } from './plan-queries';

const api = window.shipwarden.plans;

/** The error text of a cancelled run. A cancel is not an error for the user. */
const CANCELLED = 'cancelled';

/**
 * Asks the agent for a plan. With `feedback`, the agent revises the current steps. The result replaces the steps of the
 * draft. The run continues when the view closes. `useExploreState` shows its state and its error.
 */
export async function explorePlan(planId: string, repos: readonly PromptRepo[], feedback?: string): Promise<void> {
    const plan = cachedPlan(planId);
    if (!plan || exploreStateOf(planId).running) return;
    setExploreState(planId, { running: true });
    try {
        const revise = !!feedback?.trim() && plan.steps.length > 0;
        const prompt = explorePrompt({ idea: plan.idea, repos, ...(revise ? { current: plan, feedback } : {}) });
        const result = await api.explore({ id: planId, repos: repos.map(repo => repo.path), prompt });
        const proposal = parseProposal(result.answer, repos);
        const prose = answerProse(result.answer);
        await updatePlan(planId, current => {
            const applied = applyProposal(current, proposal, result.agent, Date.now());
            const summary = prose || proposal.summary;
            return summary ? { ...applied, summary } : applied;
        });
        setExploreState(planId, { running: false });
    } catch (error) {
        const text = errorText(error);
        setExploreState(planId, text.includes(CANCELLED) ? { running: false } : { running: false, error: text });
    }
}

/** Stops the exploration of a plan. */
export async function cancelExplore(planId: string): Promise<void> {
    await api.cancelExplore(planId);
}
