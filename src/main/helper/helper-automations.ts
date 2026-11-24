import { join } from 'path';
import type { AutomationHttpRequest } from '@shared/automation-engine';
import type { WorktreePlace } from '@shared/automation-events';
import type { HttpResponse } from '@shared/automation-templates';
import type { BranchSummary, CheckRun } from '@shared/github';
import type { AppSettings } from '@shared/settings';
import { AutomationStore } from '../automations/automation-store';
import { EngineLock, EngineLockKeeper, engineLockPath } from '../automations/engine-lock';
import { HeadlessEngine } from '../automations/headless-engine';
import { SummaryPoller } from '../automations/summary-poller';
import { HeadlessQueue } from '../queue/headless-queue';
import { QueueStore } from '../queue/queue-store';
import type { HelperAgents } from './headless-agents';

/** The engine checks the schedules, the held runs, and the queue at this interval. The page uses the same interval. */
const TICK_MS = 30_000;

export interface HelperAutomationsOptions {
    userData: string;
    /** The folder of the automation files (~/.shipwarden/automations). */
    automationsFolder: string;
    settings(): Promise<AppSettings>;
    /** The worktrees of all projects. */
    places(): Promise<WorktreePlace[]>;
    agents: HelperAgents;
    /** The GitHub requests. Only GitHub repositories give CI events in the helper. */
    github: {
        branchSummaries(root: string): Promise<Record<string, BranchSummary>>;
        checks(root: string, sha: string): Promise<CheckRun[]>;
        saveJobLog(root: string, jobId: number): Promise<string>;
    };
    http(request: AutomationHttpRequest): Promise<HttpResponse>;
    notify(title: string, body: string): void;
    log(message: string): void;
}

/** The parts that run while the helper holds the lock. */
interface Running {
    engine: HeadlessEngine;
    queue: HeadlessQueue;
    poller: SummaryPoller;
    timer: ReturnType<typeof setInterval>;
}

/**
 * Runs the automations and the task queue in the background helper while ShipWarden is closed, when the user turned
 * on "Run while ShipWarden is closed". The helper takes the automation lock only while the app does not hold it, and
 * gives it back when the app asks for it (a window opens).
 */
export class HelperAutomations {
    private readonly options: HelperAutomationsOptions;
    private readonly keeper: EngineLockKeeper;
    private running: Running | undefined;

    constructor(options: HelperAutomationsOptions) {
        this.options = options;
        this.keeper = new EngineLockKeeper({
            lock: new EngineLock({ file: engineLockPath(options.userData), owner: 'helper' }),
            wanted: async () => (await options.settings()).automations.runWhenClosed,
            onAcquire: () => this.startEngine(),
            onRelease: () => this.stopEngine(),
            log: options.log
        });
    }

    /** True while the helper runs the automations. */
    get owns(): boolean {
        return this.running !== undefined;
    }

    start(): void {
        this.keeper.start();
    }

    stop(): Promise<void> {
        return this.keeper.stop();
    }

    /**
     * Approves or skips a run for the phone. Returns false when the helper does not run the automations now. Throws
     * when the run is not waiting for approval.
     */
    async answerRun(id: string, approve: boolean): Promise<boolean> {
        const engine = this.running?.engine;
        if (!engine) return false;
        const answered = approve ? await engine.approve(id) : await engine.skip(id);
        if (!answered) throw new Error('The run is not waiting for approval anymore.');
        return true;
    }

    private async startEngine(): Promise<void> {
        const { options } = this;
        // New stores read the files again. The app changed them while it held the lock.
        const store = new AutomationStore(options.automationsFolder, join(options.userData, 'automation-runs.json'), async () => {
            throw new Error('The background helper does not remove automations.');
        });
        const queueStore = new QueueStore(join(options.userData, 'task-queue.json'));
        const engine = new HeadlessEngine({
            store,
            settings: async () => (await options.settings()).automations,
            places: options.places,
            agents: options.agents,
            http: options.http,
            checks: {
                list: (worktree, sha) => options.github.checks(worktree, sha),
                saveLog: (worktree, jobId) => options.github.saveJobLog(worktree, jobId)
            },
            notify: options.notify,
            log: options.log
        });
        const queue = new HeadlessQueue({
            store: queueStore,
            sessions: () => options.agents.sessions(),
            summaries: () => poller.summaries(),
            startTask: item => options.agents.startTask(item),
            log: message => options.log(`[queue] ${message}`)
        });
        const poller = new SummaryPoller({
            repos: () => this.reposToPoll(store, queue),
            fetch: repo => options.github.branchSummaries(repo),
            onSummaries: async summaries => {
                await engine.onSummaries(summaries);
                await queue.tick();
            },
            log: options.log
        });
        await engine.start();
        await queue.start();
        poller.start();
        const tick = () => void engine.tick().then(() => queue.tick());
        const timer = setInterval(tick, TICK_MS);
        this.running = { engine, queue, poller, timer };
        tick();
        options.log('The helper runs the automations and the task queue.');
    }

    private async stopEngine(): Promise<void> {
        const running = this.running;
        this.running = undefined;
        if (!running) return;
        clearInterval(running.timer);
        await running.poller.stop();
        await running.queue.stop();
        await running.engine.stop();
        this.options.log('The helper stopped the automations and the task queue.');
    }

    /**
     * The repositories to poll: the repositories with a worktree that a "CI failed" automation watches, and the
     * repositories of the running queue items in the "pull request" mode. An automation without repositories watches
     * all repositories.
     */
    private async reposToPoll(store: AutomationStore, queue: HeadlessQueue): Promise<string[]> {
        const ci = (await store.list()).automations.filter(automation => automation.status !== 'off' && automation.trigger.type === 'ci.failed');
        let repos: string[] = [];
        if (ci.length > 0) {
            const places = await this.options.places();
            const withWorktrees = [...new Set(places.filter(place => !place.worktree.isMain).map(place => place.repo))];
            const all = ci.some(automation => !automation.binding.repos?.length);
            const bound = new Set(ci.flatMap(automation => automation.binding.repos ?? []));
            repos = all ? withWorktrees : withWorktrees.filter(repo => bound.has(repo));
        }
        return [...new Set([...repos, ...(await queue.reposToWatch())])];
    }
}
