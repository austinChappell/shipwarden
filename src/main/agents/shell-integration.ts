import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

/**
 * The .zshenv file of ShipWarden's zsh folder. ShipWarden sets ZDOTDIR to this folder, so zsh reads this file first.
 * The file sets ZDOTDIR back to the user's value and reads the user's .zshenv. Then zsh reads the user's other
 * startup files as usual.
 * Before the first prompt, the file adds a `claude` function. The function starts Claude Code with ShipWarden's hook
 * settings, so a `claude` that the user types in a shell tab reports its state. The function does not replace a
 * `claude` function of the user, and it does not add a second --settings option.
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
