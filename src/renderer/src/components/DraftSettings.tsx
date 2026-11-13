import { useEffect, useState } from 'react';
import type { DraftSettings, RepoDraftSettings } from '@shared/drafts';
import type { AppSettings } from '@shared/settings';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Select, Switch, TextArea } from './ui';

/** A text field for agent instructions. It saves when the field loses focus. An empty field saves undefined. */
function InstructionsField({
    label,
    value,
    placeholder,
    onSave
}: {
    label: string;
    value: string | undefined;
    placeholder: string;
    onSave(value: string | undefined): void;
}) {
    const [text, setText] = useState(value ?? '');
    useEffect(() => setText(value ?? ''), [value]);
    return (
        <TextArea
            className="script-field"
            aria-label={label}
            value={text}
            placeholder={placeholder}
            onChange={event => setText(event.target.value)}
            onBlur={() => {
                const next = text.trim() || undefined;
                if ((next ?? '') !== (value ?? '')) onSave(next);
            }}
        />
    );
}

const COMMIT_PLACEHOLDER = 'For example: Write the subject in the imperative mood. Add the ticket ID from the branch name to the body.';
const PULL_REQUEST_PLACEHOLDER = 'For example: Start with a one-sentence summary. Add a "Risks" section.';

/** The global settings of the ✨ drafts of commit messages and pull request descriptions. */
export function DraftSettingsGroup({ settings, onSave }: { settings: AppSettings; onSave(change: Partial<AppSettings>): Promise<void> }) {
    const drafts = settings.drafts;
    const save = (change: Partial<DraftSettings>) => {
        const next: DraftSettings = { ...drafts, ...change };
        if (!next.commitInstructions) delete next.commitInstructions;
        if (!next.pullRequestInstructions) delete next.pullRequestInstructions;
        void onSave({ drafts: next });
    };
    return (
        <SettingsGroup
            title="Commit messages and pull requests"
            description="The ✨ buttons of the Changes tab and the pull request form ask the agent of the repository for a draft. A repository can add its own instructions in its repository settings."
            card
        >
            <SettingsRow
                label="Use Conventional Commits"
                description='Commit messages start with a type, for example "feat: add a sign-out button" or "fix(auth): keep the session".'
                control={
                    <Switch
                        checked={drafts.conventionalCommits}
                        title="Use Conventional Commits"
                        onChange={conventionalCommits => save({ conventionalCommits })}
                    />
                }
            />
            <SettingsRow label="Commit message instructions" description="The agent follows these instructions for each commit message.">
                <InstructionsField
                    label="Commit message instructions"
                    value={drafts.commitInstructions}
                    placeholder={COMMIT_PLACEHOLDER}
                    onSave={commitInstructions => save({ commitInstructions })}
                />
            </SettingsRow>
            <SettingsRow
                label="Pull request instructions"
                description="The agent follows these instructions for each pull request description. When the repository has a pull request template, the agent fills in the template."
            >
                <InstructionsField
                    label="Pull request instructions"
                    value={drafts.pullRequestInstructions}
                    placeholder={PULL_REQUEST_PLACEHOLDER}
                    onSave={pullRequestInstructions => save({ pullRequestInstructions })}
                />
            </SettingsRow>
        </SettingsGroup>
    );
}

/** The draft settings of one repository. They add to the global instructions, and they can change the Conventional Commits switch. */
export function RepoDraftGroup({
    settings,
    current,
    onChange
}: {
    settings: AppSettings;
    current: RepoDraftSettings | undefined;
    onChange(value: RepoDraftSettings | undefined): void;
}) {
    /** Saves a change. Empty values are removed, so the global setting applies again. */
    const save = (change: Partial<RepoDraftSettings>) => {
        const next: RepoDraftSettings = { ...current, ...change };
        for (const key of Object.keys(next) as (keyof RepoDraftSettings)[]) {
            if (next[key] === undefined) delete next[key];
        }
        onChange(Object.keys(next).length > 0 ? next : undefined);
    };
    const globalConventional = settings.drafts.conventionalCommits ? 'on' : 'off';
    return (
        <SettingsGroup
            title="Commit messages and pull requests"
            description="The ✨ drafts of this repository. The agent follows the global instructions in Settings › Agents first, then these instructions."
            card
        >
            <SettingsRow
                label="Use Conventional Commits"
                description='Commit messages start with a type, for example "feat: add a sign-out button".'
                control={
                    <Select
                        value={current?.conventionalCommits === undefined ? '' : current.conventionalCommits ? 'on' : 'off'}
                        options={[
                            { value: '', label: `Global (${globalConventional})` },
                            { value: 'on', label: 'On' },
                            { value: 'off', label: 'Off' }
                        ]}
                        onChange={value => save({ conventionalCommits: value === '' ? undefined : value === 'on' })}
                    />
                }
            />
            <SettingsRow label="Commit message instructions" description="Extra instructions for the commit messages of this repository.">
                <InstructionsField
                    label="Commit message instructions"
                    value={current?.commitInstructions}
                    placeholder={COMMIT_PLACEHOLDER}
                    onSave={commitInstructions => save({ commitInstructions })}
                />
            </SettingsRow>
            <SettingsRow label="Pull request instructions" description="Extra instructions for the pull request descriptions of this repository.">
                <InstructionsField
                    label="Pull request instructions"
                    value={current?.pullRequestInstructions}
                    placeholder={PULL_REQUEST_PLACEHOLDER}
                    onSave={pullRequestInstructions => save({ pullRequestInstructions })}
                />
            </SettingsRow>
        </SettingsGroup>
    );
}
