import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyData } from './legacy-migration';

describe('migrateLegacyData', () => {
    let root: string;
    let server: Server | undefined;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'shipwarden-migration-'));
    });
    afterEach(() => {
        server?.close();
        server = undefined;
        rmSync(root, { recursive: true, force: true });
    });

    const paths = () => ({ appData: join(root, 'appData'), userData: join(root, 'appData', 'ShipWarden'), home: join(root, 'home') });

    it('copies the app data, the notes and the plugins one time, without caches and sockets', async () => {
        const legacy = join(root, 'appData', 'Yardmaster');
        mkdirSync(join(legacy, 'Cache'), { recursive: true });
        mkdirSync(join(legacy, 'Local Storage'), { recursive: true });
        writeFileSync(join(legacy, 'settings.json'), '{"a":1}');
        writeFileSync(join(legacy, 'Local Storage', 'data'), 'x');
        writeFileSync(join(legacy, 'Cache', 'big'), 'x');
        // A short socket path: Unix sockets have a path limit.
        const socket = join(legacy, 'h.sock');
        server = createServer();
        await new Promise<void>(resolve => server!.listen(socket, resolve));
        mkdirSync(join(root, 'home', '.yardmaster', 'notes'), { recursive: true });
        mkdirSync(join(root, 'home', '.yardmaster', 'worktrees', 'x'), { recursive: true });
        writeFileSync(join(root, 'home', '.yardmaster', 'notes', 'a.md'), 'note');
        writeFileSync(join(root, 'home', '.yardmaster', 'notes', '.yardmaster-notes.json'), '{}');

        const result = migrateLegacyData(paths());
        expect(result.errors).toEqual([]);
        const user = paths().userData;
        expect(readFileSync(join(user, 'settings.json'), 'utf8')).toBe('{"a":1}');
        expect(existsSync(join(user, 'Local Storage', 'data'))).toBe(true);
        expect(existsSync(join(user, 'Cache'))).toBe(false);
        expect(existsSync(join(user, 'h.sock'))).toBe(false);
        expect(readFileSync(join(root, 'home', '.shipwarden', 'notes', 'a.md'), 'utf8')).toBe('note');
        expect(existsSync(join(root, 'home', '.shipwarden', 'notes', '.shipwarden-notes.json'))).toBe(true);
        expect(existsSync(join(root, 'home', '.shipwarden', 'worktrees'))).toBe(false);
        // The old data stays.
        expect(existsSync(join(legacy, 'settings.json'))).toBe(true);

        // A second run does not copy again over newer data.
        writeFileSync(join(user, 'settings.json'), '{"a":2}');
        migrateLegacyData(paths());
        expect(readFileSync(join(user, 'settings.json'), 'utf8')).toBe('{"a":2}');
    });

    it('does nothing without old data', () => {
        expect(migrateLegacyData(paths())).toEqual({ copied: [], errors: [] });
    });
});
