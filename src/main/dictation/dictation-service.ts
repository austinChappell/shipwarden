import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { type DictationUpdate, isDictationEnded } from '@shared/dictation';
import { DictationSession, DictationStartError, type HelperProcess } from './dictation-session';

/** The file name of the dictation helper. */
export const DICTATION_HELPER_NAME = 'shipwarden-dictation';

export interface DictationServiceOptions {
    /** The path of the helper binary. */
    helperPath: string;
    /** True in the app bundle. In development, the error for a missing helper tells the user how to build it. */
    packaged: boolean;
    platform?: NodeJS.Platform;
    /** Starts the helper. A test gives a fake process. */
    spawnHelper?: (path: string) => HelperProcess;
    exists?: (path: string) => boolean;
    stopTimeoutMs?: number;
}

/**
 * Runs the dictations. A Mac has one microphone for the app, so one dictation runs at a time. A new dictation cancels
 * the dictation before it.
 */
export class DictationService {
    private active: DictationSession | undefined;
    private readonly options: DictationServiceOptions;

    constructor(options: DictationServiceOptions) {
        this.options = options;
    }

    /**
     * Starts a dictation with an ID from the page. `onUpdate` gets each change, also the first state and the errors.
     * The page makes the ID, so it knows the ID before the first update comes.
     */
    start(id: string, onUpdate: (update: DictationUpdate) => void): void {
        this.active?.cancel();
        const { helperPath, packaged } = this.options;
        const platform = this.options.platform ?? process.platform;
        const exists = this.options.exists ?? existsSync;
        const run = this.options.spawnHelper ?? ((path: string) => spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] }));
        const session = new DictationSession({
            id,
            onUpdate: update => {
                if (isDictationEnded(update.state) && this.active === session) this.active = undefined;
                onUpdate(update);
            },
            stopTimeoutMs: this.options.stopTimeoutMs,
            spawn: () => {
                if (platform !== 'darwin') throw new DictationStartError('unsupportedPlatform', '');
                if (!exists(helperPath)) {
                    throw new DictationStartError(
                        'helperMissing',
                        packaged ? `The app has no file ${helperPath}. Install ShipWarden again.` : 'Run "npm run build:dictation" one time, then try again.'
                    );
                }
                return run(helperPath);
            }
        });
        this.active = session;
        session.start();
    }

    /** Stops the recording of a dictation. The dictation then sends its final text. */
    stop(id: string): void {
        if (this.active?.id === id) this.active.stop();
    }

    /** Stops a dictation without a text. */
    cancel(id: string): void {
        if (this.active?.id === id) this.active.cancel();
    }

    /** Stops the running dictation without a text, for example when its window closes. */
    cancelAll(): void {
        this.active?.cancel();
    }
}
