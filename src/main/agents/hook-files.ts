import { join } from 'path';
import { writeFileSync } from 'fs';
import { claudeHookSettings, opencodeHookConfig, type HookSettingsPaths } from '@shared/agents';
import { writeGeminiHookSettings } from './gemini-settings';
import { writeOpencodePlugin } from './opencode-plugin';
import { writeBashIntegration, writeZshIntegration, type ShellIntegration } from './shell-integration';

/**
 * The hook settings files of the agents. They are the same for each session.
 * Claude Code gets its file with --settings. Gemini CLI gets its file in GEMINI_CLI_SYSTEM_DEFAULTS_PATH.
 * opencode gets an inline config in OPENCODE_CONFIG_CONTENT that loads the plugin file.
 */
export function hookSettingsPaths(userData: string): HookSettingsPaths {
    return {
        claude: join(userData, 'claude-hooks.json'),
        gemini: join(userData, 'gemini-hooks.json'),
        opencode: join(userData, 'opencode', 'shipwarden-agent-state.js')
    };
}

/** Returns the message of an error, or the error as text. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Writes the hook settings files and the shell integration into `shellFolder`: the `zsh` folder and `init.bash`.
 * It adds the opencode config, the zsh folder and the bash file to `shellIntegration`. A file that fails gives a warning only.
 */
export function writeAgentHookFiles(paths: HookSettingsPaths, shellIntegration: ShellIntegration, shellFolder: string): void {
    try {
        writeFileSync(paths.claude, JSON.stringify(claudeHookSettings(), null, 2));
    } catch (error) {
        // Without the hook settings, agents still run. ShipWarden then shows no agent state.
        console.warn(`[agents] The hook settings were not written: ${messageOf(error)}`);
    }
    try {
        writeGeminiHookSettings(paths.gemini);
    } catch (error) {
        // Without the hook settings, Gemini CLI still runs. ShipWarden then shows no state for it.
        console.warn(`[agents] The Gemini CLI hook settings were not written: ${messageOf(error)}`);
    }
    try {
        writeOpencodePlugin(paths.opencode);
        shellIntegration.opencodeConfigContent = opencodeHookConfig(paths.opencode);
    } catch (error) {
        // Without the plugin, opencode still runs. ShipWarden then shows no state for it.
        console.warn(`[agents] The opencode plugin was not written: ${messageOf(error)}`);
    }
    try {
        shellIntegration.zshFolder = writeZshIntegration(join(shellFolder, 'zsh'));
    } catch (error) {
        // Without the zsh folder, shells start as usual. A `claude` that the user types then shows no agent state.
        console.warn(`[agents] The zsh integration was not written: ${messageOf(error)}`);
    }
    try {
        shellIntegration.bashInitFile = writeBashIntegration(join(shellFolder, 'init.bash'));
    } catch (error) {
        // Without the file, bash starts as usual. A `claude` that the user types then shows no agent state.
        console.warn(`[agents] The bash integration was not written: ${messageOf(error)}`);
    }
}
