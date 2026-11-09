import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEMINI_HOOK_NAME } from '@shared/agents';
import { defaultGeminiSystemDefaultsPath, writeGeminiHookSettings } from './gemini-settings';

describe('writeGeminiHookSettings', () => {
    let folder: string;

    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'shipwarden-gemini-'));
    });

    afterEach(() => {
        rmSync(folder, { recursive: true, force: true });
    });

    type Settings = { hooks: Record<string, { hooks: { name?: string }[] }[]>; [key: string]: unknown };
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Settings;

    it('writes the hooks when there is no system defaults file', () => {
        const target = join(folder, 'gemini-hooks.json');
        writeGeminiHookSettings(target, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(folder, 'missing.json') });
        expect(read(target).hooks.AfterAgent[0].hooks[0].name).toBe(GEMINI_HOOK_NAME);
    });

    it('keeps the values of the system defaults file that the user set', () => {
        const base = join(folder, 'defaults.json');
        writeFileSync(base, JSON.stringify({ general: { vimMode: true }, hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
        const target = join(folder, 'gemini-hooks.json');
        writeGeminiHookSettings(target, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: base });
        const settings = read(target);
        expect(settings.general).toEqual({ vimMode: true });
        expect(settings.hooks.AfterAgent).toHaveLength(2);
        expect(settings.hooks.AfterAgent[1].hooks[0].name).toBe(GEMINI_HOOK_NAME);
    });

    it('does not read its own file as the base', () => {
        const target = join(folder, 'gemini-hooks.json');
        writeGeminiHookSettings(target, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(folder, 'missing.json') });
        // The variable points to the file of ShipWarden, for example when the app starts from a ShipWarden terminal.
        // The hooks must not occur two times.
        writeGeminiHookSettings(target, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: target }, 'freebsd');
        expect(read(target).hooks.AfterAgent).toHaveLength(1);
    });
});

describe('defaultGeminiSystemDefaultsPath', () => {
    it('returns the path for each platform', () => {
        expect(defaultGeminiSystemDefaultsPath('darwin')).toBe('/Library/Application Support/GeminiCli/system-defaults.json');
        expect(defaultGeminiSystemDefaultsPath('linux')).toBe('/etc/gemini-cli/system-defaults.json');
        expect(defaultGeminiSystemDefaultsPath('win32')).toBe('C:\\ProgramData\\gemini-cli\\system-defaults.json');
    });
});
