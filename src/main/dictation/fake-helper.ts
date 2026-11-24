import { EventEmitter } from 'events';
import type { HelperProcess } from './dictation-session';

/** A fake dictation helper for the tests. `say` writes stdout, and `stdinText` has all that the session wrote. */
export class FakeHelper extends EventEmitter implements HelperProcess {
    readonly stdout = new EventEmitter();
    stdinText = '';
    stdinEnded = false;
    killed: NodeJS.Signals[] = [];
    readonly stdin = {
        write: (text: string) => {
            this.stdinText += text;
            return true;
        },
        end: () => {
            this.stdinEnded = true;
        },
        on: () => this.stdin
    };

    /** Writes a chunk to stdout. */
    say(chunk: string): void {
        this.stdout.emit('data', Buffer.from(chunk));
    }

    /** Writes one event as a line. */
    send(event: object): void {
        this.say(`${JSON.stringify(event)}\n`);
    }

    exit(code: number | null, signal: NodeJS.Signals | null = null): void {
        this.emit('exit', code, signal);
    }

    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        this.killed.push(signal);
        return true;
    }
}
