import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { installSkill, SKILL_TEXT } from './skill';

describe('the skill file', () => {
    it('has the front matter that agents read', () => {
        expect(SKILL_TEXT.startsWith('---\nname: shipwarden\ndescription: ')).toBe(true);
    });

    it('installs into <folder>/shipwarden/SKILL.md', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'sw-skill-'));
        try {
            const file = await installSkill(folder);
            expect(file).toBe(join(folder, 'shipwarden', 'SKILL.md'));
            expect(readFileSync(file, 'utf8')).toBe(SKILL_TEXT);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });
});
