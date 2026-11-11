import { normalizePlan, type Plan } from '@shared/plans';
import { JsonStore } from '../tasks/json-store';

interface PlanFile {
    plans?: unknown[];
}

/** The most plans that the file keeps. The oldest finished plans go first. */
const MAX_PLANS = 300;

/** Keeps the plans of all projects in one JSON file in the app data folder. */
export class PlanStore {
    private readonly store: JsonStore<PlanFile>;

    constructor(file: string) {
        this.store = new JsonStore<PlanFile>(file, () => ({ plans: [] }));
    }

    /** All plans, the newest change first. */
    async list(): Promise<Plan[]> {
        const value = await this.store.get();
        return plansOf(value);
    }

    /** Writes a plan. A plan with the same ID is replaced. Returns the saved plan. Throws an error when the plan is not valid. */
    async save(value: unknown): Promise<Plan> {
        const plan = normalizePlan(value);
        if (!plan) throw new Error('The plan is not valid. It needs an ID and a project.');
        await this.store.update(file => {
            const others = plansOf(file).filter(item => item.id !== plan.id);
            return { plans: trim([plan, ...others]) };
        });
        return plan;
    }

    async remove(id: string): Promise<void> {
        await this.store.update(file => ({ plans: plansOf(file).filter(item => item.id !== id) }));
    }

    /** Removes the plans of a project that does not exist anymore. */
    async removeProject(projectId: string): Promise<void> {
        await this.store.update(file => ({ plans: plansOf(file).filter(item => item.projectId !== projectId) }));
    }
}

function plansOf(file: PlanFile): Plan[] {
    const plans = (Array.isArray(file.plans) ? file.plans : []).map(normalizePlan).filter((plan): plan is Plan => !!plan);
    return plans.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Keeps at most MAX_PLANS plans. Drafts and plans that run always stay. */
function trim(plans: Plan[]): Plan[] {
    if (plans.length <= MAX_PLANS) return plans;
    const sorted = [...plans].sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = new Set(sorted.filter(plan => plan.status !== 'done').map(plan => plan.id));
    for (const plan of sorted) {
        if (keep.size >= MAX_PLANS) break;
        keep.add(plan.id);
    }
    return sorted.filter(plan => keep.has(plan.id));
}
