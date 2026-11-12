import { normalizeGroup, type PrGroup } from '@shared/pr-groups';
import { JsonStore } from '../tasks/json-store';

interface GroupFile {
    groups?: unknown[];
}

/** The most groups that the file keeps. The groups with the oldest change go first. */
const MAX_GROUPS = 200;

/** Keeps the PR groups of the Review view in one JSON file in the app data folder. */
export class PrGroupStore {
    private readonly store: JsonStore<GroupFile>;

    constructor(file: string) {
        this.store = new JsonStore<GroupFile>(file, () => ({ groups: [] }));
    }

    /** All groups, the newest change first. */
    async list(): Promise<PrGroup[]> {
        return groupsOf(await this.store.get());
    }

    /** Writes a group. A group with the same ID is replaced. Returns the saved group. Throws an error when the group is not valid. */
    async save(value: unknown): Promise<PrGroup> {
        const group = normalizeGroup(value);
        if (!group) throw new Error('The group is not valid. It needs an ID.');
        await this.store.update(file => {
            const others = groupsOf(file).filter(item => item.id !== group.id);
            return { groups: [group, ...others].slice(0, MAX_GROUPS) };
        });
        return group;
    }

    async remove(id: string): Promise<void> {
        await this.store.update(file => ({ groups: groupsOf(file).filter(item => item.id !== id) }));
    }
}

function groupsOf(file: GroupFile): PrGroup[] {
    const groups = (Array.isArray(file.groups) ? file.groups : []).map(normalizeGroup).filter((group): group is PrGroup => !!group);
    return groups.sort((a, b) => b.updatedAt - a.updatedAt);
}
