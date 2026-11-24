import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { isAppToken, isBotToken, type SlackTokenInput } from '@shared/slack';

const SECURITY = '/usr/bin/security';

export interface SlackTokens {
    bot?: string;
    app?: string;
}

type TokenKind = keyof SlackTokens;

/** Runs the `security` tool. `input` goes to its standard input. Returns the standard output, or undefined after an error. */
export type SecurityRunner = (args: string[], input?: string) => Promise<string | undefined>;

const runSecurity: SecurityRunner = (args, input) =>
    new Promise(resolve => {
        if (input === undefined) {
            execFile(SECURITY, args, { timeout: 10_000 }, (error, stdout) => resolve(error ? undefined : stdout));
            return;
        }
        const child = spawn(SECURITY, args, { stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', chunk => {
            output += String(chunk);
        });
        child.on('error', () => resolve(undefined));
        child.on('close', code => resolve(code === 0 ? output : undefined));
        child.stdin.end(input);
    });

/**
 * Keeps the Slack tokens in the login keychain of macOS. The app and the background helper both read them. The helper
 * runs without Electron, so it cannot read values that Electron safeStorage encrypted. The `security` tool writes and
 * reads the items, so macOS asks for no permission.
 *
 * The tokens go to `security` on its standard input, not as arguments, so other processes cannot see them in the
 * process list.
 */
export class SlackTokenStore {
    private readonly service: string;

    /** `userData` is the app data folder. Each app data folder has its own items, so a test folder does not use the real tokens. */
    constructor(
        userData: string,
        private readonly run: SecurityRunner = runSecurity
    ) {
        this.service = `ShipWarden Slack ${createHash('sha256').update(userData).digest('hex').slice(0, 12)}`;
    }

    async get(): Promise<SlackTokens> {
        const [bot, app] = await Promise.all([this.read('bot'), this.read('app')]);
        return { ...(bot ? { bot } : {}), ...(app ? { app } : {}) };
    }

    /** Saves the given tokens. An empty value keeps the saved token. Throws for a value that is not a token of its type. */
    async save(input: SlackTokenInput): Promise<void> {
        const bot = input.bot?.trim();
        const app = input.app?.trim();
        if (bot && !isBotToken(bot)) throw new Error('The bot token must start with "xoxb-". Copy it from OAuth & Permissions of the Slack app.');
        if (app && !isAppToken(app)) throw new Error('The app-level token must start with "xapp-". Copy it from Basic Information of the Slack app.');
        if (bot) await this.write('bot', bot);
        if (app) await this.write('app', app);
    }

    /** Removes both tokens. */
    async clear(): Promise<void> {
        await Promise.all((['bot', 'app'] as const).map(kind => this.run(['delete-generic-password', '-s', this.service, '-a', kind])));
    }

    private async read(kind: TokenKind): Promise<string | undefined> {
        const value = (await this.run(['find-generic-password', '-s', this.service, '-a', kind, '-w']))?.trim();
        return value || undefined;
    }

    private async write(kind: TokenKind, token: string): Promise<void> {
        // The token has only letters, digits, and "-" (checked above), and the service has only letters, digits, and spaces. The quotes are safe.
        const command = `add-generic-password -U -s "${this.service}" -a "${kind}" -l "${this.service}" -w "${token}"\n`;
        // The interactive mode of `security` can exit with 0 after a failed command, so a read checks the result.
        await this.run(['-i'], command);
        if ((await this.read(kind)) !== token) throw new Error('ShipWarden cannot save the token in the keychain.');
    }
}
