import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

/**
 * The .zshenv file of ShipWarden's zsh folder. ShipWarden sets ZDOTDIR to this folder, so zsh reads this file first.
 * The file sets ZDOTDIR back to the user's value and reads the user's .zshenv. Then zsh reads the user's other
 * startup files as usual.
 * Before the first prompt, the file adds a `claude` function. The function starts Claude Code with ShipWarden's hook
 * settings, so a `claude` that the user types in a shell tab reports its state. The function does not replace a
 * `claude` function of the user, and it does not add a second --settings option.
 * The file also adds a `gemini` function. The function starts Gemini CLI with ShipWarden's hook settings as its
 * system defaults file (GEMINI_CLI_SYSTEM_DEFAULTS_PATH). It does not replace a `gemini` function of the user, and it
 * does not replace a GEMINI_CLI_SYSTEM_DEFAULTS_PATH value of the user.
 * The file also adds an `opencode` function. The function starts opencode with an inline config that loads
 * ShipWarden's plugin (OPENCODE_CONFIG_CONTENT). It does not replace an `opencode` function of the user, and it does
 * not replace an OPENCODE_CONFIG_CONTENT value of the user.
 * Only an interactive shell gets the function. Scripts and the shells of agent tools do not get it.
 */
export const ZSHENV = `# ShipWarden shell integration. ShipWarden writes this file. Do not edit it.
if [[ -n "\${SHIPWARDEN_USER_ZDOTDIR-}" ]]; then
    export ZDOTDIR="$SHIPWARDEN_USER_ZDOTDIR"
else
    unset ZDOTDIR
fi
if [[ -r "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then
    source "\${ZDOTDIR:-$HOME}/.zshenv"
fi
if [[ -o interactive ]]; then
    _shipwarden_setup() {
        precmd_functions=(\${precmd_functions:#_shipwarden_setup})
        unfunction _shipwarden_setup
        if (( ! $+functions[claude] )); then
            claude() {
                if [[ -r "\${SHIPWARDEN_HOOK_SETTINGS-}" && " $* " != *" --settings"* ]]; then
                    command claude --settings "$SHIPWARDEN_HOOK_SETTINGS" "$@"
                else
                    command claude "$@"
                fi
            }
        fi
        if (( ! $+functions[gemini] )); then
            gemini() {
                if [[ -r "\${SHIPWARDEN_GEMINI_HOOK_SETTINGS-}" && -z "\${GEMINI_CLI_SYSTEM_DEFAULTS_PATH-}" ]]; then
                    GEMINI_CLI_SYSTEM_DEFAULTS_PATH="$SHIPWARDEN_GEMINI_HOOK_SETTINGS" command gemini "$@"
                else
                    command gemini "$@"
                fi
            }
        fi
        if (( ! $+functions[opencode] )); then
            opencode() {
                if [[ -n "\${SHIPWARDEN_OPENCODE_CONFIG_CONTENT-}" && -z "\${OPENCODE_CONFIG_CONTENT-}" ]]; then
                    OPENCODE_CONFIG_CONTENT="$SHIPWARDEN_OPENCODE_CONFIG_CONTENT" command opencode "$@"
                else
                    command opencode "$@"
                fi
            }
        fi
    }
    precmd_functions+=(_shipwarden_setup)
fi
`;

/** Writes ShipWarden's zsh folder. Returns the path of the folder. */
export function writeZshIntegration(folder: string): string {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '.zshenv'), ZSHENV);
    return folder;
}

export interface ShellIntegration {
    /** The hook settings file that `claude` gets with --settings. */
    hookSettingsPath: string;
    /** The hook settings file that `gemini` gets in GEMINI_CLI_SYSTEM_DEFAULTS_PATH. */
    geminiHookSettingsPath?: string;
    /** The inline config that `opencode` gets in OPENCODE_CONFIG_CONTENT, or undefined when the plugin was not written. */
    opencodeConfigContent?: string;
    /** ShipWarden's zsh folder, or undefined when it was not written. */
    zshFolder?: string;
}

/**
 * Returns the variables that a terminal process gets in addition to `env`.
 * A zsh shell gets ZDOTDIR, so it reads ShipWarden's .zshenv first. The user's own ZDOTDIR goes to
 * SHIPWARDEN_USER_ZDOTDIR, and the .zshenv sets it back.
 */
export function shellIntegrationEnv(env: NodeJS.ProcessEnv, integration: ShellIntegration): Record<string, string> {
    const result: Record<string, string> = { SHIPWARDEN_HOOK_SETTINGS: integration.hookSettingsPath };
    if (integration.geminiHookSettingsPath) {
        result.SHIPWARDEN_GEMINI_HOOK_SETTINGS = integration.geminiHookSettingsPath;
    }
    if (integration.opencodeConfigContent) {
        result.SHIPWARDEN_OPENCODE_CONFIG_CONTENT = integration.opencodeConfigContent;
    }
    const shell = env.SHELL || '/bin/zsh';
    if (!integration.zshFolder || basename(shell) !== 'zsh') {
        return result;
    }
    result.SHIPWARDEN_ZDOTDIR = integration.zshFolder;
    result.ZDOTDIR = integration.zshFolder;
    const userZdotdir = env.SHIPWARDEN_USER_ZDOTDIR ?? env.ZDOTDIR;
    if (userZdotdir && userZdotdir !== integration.zshFolder) {
        result.SHIPWARDEN_USER_ZDOTDIR = userZdotdir;
    }
    return result;
}
