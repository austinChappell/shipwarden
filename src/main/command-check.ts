import { commandProgram, type CommandCheck } from '@shared/settings';
import { which } from './lsp/servers';

/**
 * Finds the program of a command in the login shell PATH. A path with a slash must be an executable file.
 * Settings › Agents and the setup checks use this function. Do not write a second PATH check.
 */
export async function checkCommand(command: string, shellReady: Promise<unknown>): Promise<CommandCheck> {
    await shellReady;
    const program = commandProgram(command);
    if (!program) {
        return { program };
    }
    return { program, path: await which(program) };
}
