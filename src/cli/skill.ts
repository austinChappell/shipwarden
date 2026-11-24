import { promises as fs } from 'fs';
import { join } from 'path';
import skillText from '../../skills/shipwarden/SKILL.md?raw';

/** The text of the agent skill file. The build puts the file into the CLI script. */
export const SKILL_TEXT = skillText;

/** The folder of the skill in a skills folder. Claude Code finds `<skills>/shipwarden/SKILL.md`. */
export const SKILL_FOLDER = 'shipwarden';

/** Returns the default skills folder: the personal skills of Claude Code. */
export function defaultSkillsFolder(home: string): string {
    return join(home, '.claude', 'skills');
}

/** Writes the skill file into a skills folder. Returns the path of the file. An older copy gets the new text. */
export async function installSkill(skillsFolder: string): Promise<string> {
    const folder = join(skillsFolder, SKILL_FOLDER);
    await fs.mkdir(folder, { recursive: true });
    const file = join(folder, 'SKILL.md');
    await fs.writeFile(file, SKILL_TEXT, 'utf8');
    return file;
}
