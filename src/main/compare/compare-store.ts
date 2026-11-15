import { MAX_COMPARE_GROUPS, normalizeCompareGroup, type CompareGroup } from '@shared/agent-compare';
import { JsonStore } from '../tasks/json-store';

interface CompareFile {
    groups?: unknown[];
}

/** Keeps the agent comparisons (one task, several agents) in one JSON file in the app data folder. */
export class CompareStore {
    private readonly store: JsonStore<CompareFile>;

    constructor(file: string) {
        this.store = new JsonStore<CompareFile>(file, () => ({ groups: [] }));
    }

    /** All comparisons, the newest change first. */
    async list(): Promise<CompareGroup[]> {
        return groupsOf(await this.store.get());
    }

    /** Writes a comparison. A comparison with the same ID is replaced. Returns the saved comparison. Throws an error when the comparison is not valid. */
    async save(value: unknown): Promise<CompareGroup> {
        const group = normalizeCompareGroup(value);
        if (!group) throw new Error('The comparison is not valid. It needs an ID, a repository, a task, and a run.');
        await this.store.update(file => {
            const others = groupsOf(file).filter(item => item.id !== group.id);
            return { groups: [group, ...others].slice(0, MAX_COMPARE_GROUPS) };
        });
        return group;
    }

    async remove(id: string): Promise<void> {
        await this.store.update(file => ({ groups: groupsOf(file).filter(item => item.id !== id) }));
    }
}

function groupsOf(file: CompareFile): CompareGroup[] {
    const groups = (Array.isArray(file.groups) ? file.groups : []).map(normalizeCompareGroup).filter((group): group is CompareGroup => !!group);
    return groups.sort((a, b) => b.updatedAt - a.updatedAt);
}
