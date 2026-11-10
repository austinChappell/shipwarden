import { describe, expect, it } from 'vitest';
import * as os from 'os';
import { runScript } from './run-script';

describe('runScript', () => {
    it('runs the script in the folder with the variables and keeps the output', async () => {
        const result = await runScript(
            'echo "$SHIPWARDEN_BRANCH in $(pwd -P)"; echo oops >&2',
            os.tmpdir(),
            { SHIPWARDEN_BRANCH: 'feat/a' },
            10_000,
            '/bin/sh'
        );
        expect(result.code).toBe(0);
        expect(result.output).toContain('feat/a in /');
        expect(result.output).toContain('oops');
    });

    it('reports the exit code and a timeout', async () => {
        expect((await runScript('exit 3', os.tmpdir(), {}, 10_000, '/bin/sh')).code).toBe(3);
        const slow = await runScript('sleep 5', os.tmpdir(), {}, 200, '/bin/sh');
        expect(slow).toMatchObject({ code: null, timedOut: true });
    });
});
