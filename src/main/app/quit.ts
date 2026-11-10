import type { ConfirmRequest } from '@shared/api';

/** The fields of a terminal session that the quit question reads. */
interface RunningSession {
    exited?: boolean;
    isAgent?: boolean;
}

/** The parts that the "Quit and Stop All Agents" item needs. */
export interface QuitDependencies {
    /** Returns the sessions of the PTY host. It returns an empty list when the app has no connection to the host. */
    sessions(): Promise<RunningSession[]>;
    confirm(request: ConfirmRequest): Promise<boolean>;
    shutdownHost(): Promise<void>;
    quit(): void;
}

/** Returns the question before the app stops the running sessions, for example "Stop 2 agents and 1 shell and quit?". */
export function stopSessionsQuestion(running: RunningSession[]): ConfirmRequest {
    const agents = running.filter(session => session.isAgent).length;
    const shells = running.length - agents;
    const parts = [agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : '', shells ? `${shells} ${shells === 1 ? 'shell' : 'shells'}` : ''].filter(
        Boolean
    );
    return {
        title: `Stop ${parts.join(' and ')} and quit?`,
        message: 'The processes stop now. Work that an agent did not finish stops too. A normal Quit (⌘Q) keeps the sessions running.',
        confirmLabel: 'Stop and Quit',
        danger: true
    };
}

/**
 * Stops all terminal sessions and the PTY host, then quits.
 * The app asks first when sessions run, because the agents lose their work in progress.
 */
export async function quitAndStopSessions(deps: QuitDependencies): Promise<void> {
    const running = (await deps.sessions()).filter(session => !session.exited);
    if (running.length > 0 && !(await deps.confirm(stopSessionsQuestion(running)))) {
        return;
    }
    await deps.shutdownHost();
    deps.quit();
}
