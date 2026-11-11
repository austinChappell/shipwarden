import { randomBytes } from 'crypto';
import { promises as fs, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import {
    AutomationError,
    EMPTY_RUN_STATE,
    exportAutomation,
    firedKey,
    isAutomationId,
    normalizeAutomation,
    normalizeRunState,
    pruneRunState,
    type Automation,
    type AutomationList,
    type AutomationProblem,
    type AutomationRun,
    type AutomationRunState
} from '@shared/automations';
import { JsonStore } from '../tasks/json-store';

/** The fields of a run that `updateRun` can change. */
export type RunChange = Partial<Pick<AutomationRun, 'status' | 'detail' | 'worktreePath' | 'sessionId' | 'noteName' | 'tokens' | 'turn'>>;

/**
 * Keeps the automations and their runs.
 * - Each automation is one JSON file in the folder (~/.shipwarden/automations/<id>.json). The user can read, change, copy
 *   and share the files. The store watches the folder, so a change from another app shows at once.
 * - The runs are in one file in the app data folder. They are local to this Mac, so an export never contains them.
 */
export class AutomationStore {
    private readonly runs: JsonStore<AutomationRunState>;
    private watcher: FSWatcher | undefined;

    /** `trash` moves a file to the Trash. The tests replace it. */
    constructor(
        readonly folder: string,
        runsFile: string,
        private readonly trash: (file: string) => Promise<void>
    ) {
        this.runs = new JsonStore<AutomationRunState>(runsFile, () => structuredClone(EMPTY_RUN_STATE));
    }

    /** Reads all automation files. A file that is not valid goes into `problems`, with the reason. */
    async list(): Promise<AutomationList> {
        await fs.mkdir(this.folder, { recursive: true });
        const files = (await fs.readdir(this.folder)).filter(file => file.endsWith('.json') && !file.startsWith('.')).sort();
        const automations: Automation[] = [];
        const problems: AutomationProblem[] = [];
        for (const file of files) {
            try {
                const automation = normalizeAutomation(JSON.parse(await fs.readFile(path.join(this.folder, file), 'utf8')));
                // The file name is the ID. A copied file keeps the ID of the first file in its text.
                const id = file.slice(0, -'.json'.length);
                if (!isAutomationId(id)) {
                    throw new AutomationError('The file name must have only lowercase letters, digits and hyphens.');
                }
                automations.push({ ...automation, id });
            } catch (error) {
                problems.push({ file, error: error instanceof SyntaxError ? `The file is not valid JSON: ${error.message}` : errorText(error) });
            }
        }
        automations.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return { folder: this.folder, automations, problems };
    }

    /**
     * Writes an automation to its file and returns it in its clean form. With `previousId`, an automation with a new ID
     * replaces the file of the old ID.
     */
    async save(value: unknown, previousId?: string): Promise<Automation> {
        const automation = normalizeAutomation(value);
        if (!isAutomationId(automation.id)) throw new AutomationError('The ID must have only lowercase letters, digits and hyphens.');
        await fs.mkdir(this.folder, { recursive: true });
        await writeAtomic(this.fileOf(automation.id), `${JSON.stringify(automation, null, 2)}\n`);
        if (previousId && previousId !== automation.id && isAutomationId(previousId)) {
            await fs.rm(this.fileOf(previousId), { force: true });
        }
        return automation;
    }

    /** Moves the file of the automation to the Trash. The runs of the automation stay in the history. */
    async remove(id: string): Promise<void> {
        if (!isAutomationId(id)) return;
        const file = this.fileOf(id);
        if (await exists(file)) await this.trash(file);
    }

    /** Returns the JSON text of the portable part of a saved automation. */
    async exportText(id: string): Promise<string> {
        const automation = (await this.list()).automations.find(item => item.id === id);
        if (!automation) throw new Error(`The automation "${id}" does not exist.`);
        return exportAutomation(automation);
    }

    /** Returns the path of the file of an automation. */
    fileOf(id: string): string {
        if (!isAutomationId(id)) throw new Error(`"${id}" is not a valid automation ID.`);
        return path.join(this.folder, `${id}.json`);
    }

    async runState(): Promise<AutomationRunState> {
        return normalizeRunState(await this.runs.get());
    }

    /**
     * Records a new run, but only when its automation did not fire for the same event before. Returns null for a
     * second run of the same event. The check and the write are one step, so two calls cannot both record a run.
     */
    async claim(run: AutomationRun): Promise<AutomationRun | null> {
        const key = firedKey(run.automationId, run.event);
        let claimed = false;
        await this.runs.update(value => {
            const state = normalizeRunState(value);
            if (state.fired[key] !== undefined) return state;
            claimed = true;
            return pruneRunState({ ...state, fired: { ...state.fired, [key]: run.createdAt }, runs: [run, ...state.runs] }, run.createdAt);
        });
        return claimed ? run : null;
    }

    /** Changes a run. Returns the changed run, or undefined when the history does not have it. */
    async updateRun(id: string, change: RunChange): Promise<AutomationRun | undefined> {
        let result: AutomationRun | undefined;
        await this.runs.update(value => {
            const state = normalizeRunState(value);
            const runs = state.runs.map(run => {
                if (run.id !== id) return run;
                result = { ...run, ...change, updatedAt: Date.now() };
                return result;
            });
            return { ...state, runs };
        });
        return result;
    }

    /**
     * Records the keys of events as fired, without runs. A new task automation does this for the tasks of its first
     * list, so that only tasks that come later start agents.
     */
    async seed(automationId: string, keys: string[]): Promise<void> {
        const now = Date.now();
        await this.runs.update(value => {
            const state = normalizeRunState(value);
            const fired = { ...state.fired };
            for (const key of keys) fired[firedKey(automationId, { key })] ??= now;
            return { ...state, fired, seeded: [...new Set([...state.seeded, automationId])] };
        });
    }

    /** Records the time of the last run of a schedule. */
    async setScheduleRun(automationId: string, at: number): Promise<void> {
        await this.runs.update(value => {
            const state = normalizeRunState(value);
            return { ...state, scheduleRuns: { ...state.scheduleRuns, [automationId]: at } };
        });
    }

    /** Removes the closed runs from the history. Open runs and the fired keys stay, so old events do not run again. */
    async clearHistory(): Promise<void> {
        await this.runs.update(value => {
            const state = normalizeRunState(value);
            return { ...state, runs: state.runs.filter(run => run.status === 'pending' || run.status === 'held' || run.status === 'running') };
        });
    }

    /** Calls `onChange` when a file in the folder changes, also from another app. */
    async watch(onChange: () => void): Promise<void> {
        await fs.mkdir(this.folder, { recursive: true });
        let timer: NodeJS.Timeout | undefined;
        this.watcher?.close();
        this.watcher = watch(this.folder, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, 150);
        });
    }

    close(): void {
        this.watcher?.close();
        this.watcher = undefined;
    }
}

/** Writes a temporary file, then renames it. The rename is atomic, so a reader never sees half a file. */
async function writeAtomic(file: string, content: string): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
        await fs.writeFile(temp, content, { mode: 0o600 });
        await fs.rename(temp, file);
    } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
