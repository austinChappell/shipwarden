import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { GitHubOwner } from '@shared/github';
import type { AzureTokenStatus } from '@shared/azure-devops';
import type { AppSettings } from '@shared/settings';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

/** The code review settings: the provider and the GitHub organizations whose pull requests the Review view shows. */
export function CodeReviewSettings({ settings, onSave }: Props) {
    const [owners, setOwners] = useState<GitHubOwner[]>();
    const [error, setError] = useState<string>();
    const selected = settings.reviewOwners;

    useEffect(() => {
        window.shipwarden.github.owners().then(setOwners, err => setError(errorText(err)));
    }, []);

    const save = (reviewOwners: string[] | 'all') => onSave({ reviewOwners }).catch(err => setError(errorText(err)));
    const mode = selected === 'all' ? 'all' : selected ? 'some' : undefined;

    return (
        <>
            <SettingsGroup title="Provider" card>
                <SettingsRow
                    label="Pull requests"
                    description="ShipWarden uses the GitHub CLI login (gh auth login) or GITHUB_TOKEN. A worktree with an Azure Repos remote uses Azure DevOps (see below)."
                    control={(
                        <div className="segmented compact">
                            <button className="selected">GitHub</button>
                        </div>
                    )}
                />
            </SettingsGroup>

            <AzureDevOpsSettings />

            <SettingsGroup
                title="Organizations"
                description="The Review view lists the repositories of these organizations. You select one repository at a time there."
                card
            >
                <SettingsRow
                    label={(
                        <label className="scope-option">
                            <input type="radio" checked={mode === 'all'} onChange={() => save('all')} />
                            All organizations, also new ones
                        </label>
                    )}
                />
                <SettingsRow
                    label={(
                        <label className="scope-option">
                            <input type="radio" checked={mode === 'some'} onChange={() => save(owners ? owners.map(owner => owner.login) : [])} />
                            Only these:
                        </label>
                    )}
                >
                    {error && <div className="form-error">{error}</div>}
                    {!owners && !error && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading your organizations…</div>}
                    {owners && (
                        <div className={`scope-list${mode === 'some' ? '' : ' disabled'}`}>
                            {owners.map(owner => {
                                const list = Array.isArray(selected) ? selected : [];
                                return (
                                    <label key={owner.login} className="scope-item">
                                        <input
                                            type="checkbox"
                                            disabled={mode !== 'some'}
                                            checked={mode === 'some' && list.includes(owner.login)}
                                            onChange={event => save(event.target.checked ? [...list, owner.login] : list.filter(item => item !== owner.login))}
                                        />
                                        <span>{owner.login}</span>
                                        {owner.kind === 'user' && <span className="scope-detail">your account</span>}
                                    </label>
                                );
                            })}
                        </div>
                    )}
                </SettingsRow>
            </SettingsGroup>
        </>
    );
}

const TOKEN_SOURCE_TEXT: Record<NonNullable<AzureTokenStatus['source']>, string> = {
    env: 'ShipWarden uses AZURE_DEVOPS_EXT_PAT from the environment.',
    saved: 'ShipWarden uses the saved token.',
    az: 'ShipWarden uses the az CLI login (az login).'
};

/**
 * The Azure DevOps token. Pull requests and pipelines of worktrees with an Azure Repos remote use it.
 * The token goes to the main process, which encrypts it with the macOS keychain. The page never reads it back.
 */
function AzureDevOpsSettings() {
    const [status, setStatus] = useState<AzureTokenStatus>();
    const [token, setToken] = useState('');
    const [organization, setOrganization] = useState('');
    const [message, setMessage] = useState<string>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const api = window.shipwarden.azureDevOps;

    useEffect(() => {
        api.tokenStatus().then(setStatus, err => setError(errorText(err)));
    }, [api]);

    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(undefined);
        setMessage(undefined);
        try {
            await action();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <SettingsGroup
            title="Azure DevOps"
            description="For repositories on Azure Repos (dev.azure.com or visualstudio.com). Make a personal access token with these scopes: Code (Read & write), Code (Status), Build (Read & execute), Identity (Read) and Project and Team (Read)."
            card
        >
            <SettingsRow
                label="Personal access token"
                description={status ? (status.source ? TOKEN_SOURCE_TEXT[status.source] : 'No token. Save a token, or run "az login" with the az CLI.') : 'Loading…'}
                control={(
                    <div className="row-buttons">
                        <input
                            type="password"
                            value={token}
                            placeholder={status?.saved ? 'A token is saved' : 'Paste a token'}
                            onChange={event => setToken(event.target.value)}
                            disabled={busy}
                        />
                        <button className="button" disabled={busy || !token.trim()} onClick={() => act(async () => {
                            setStatus(await api.saveToken(token));
                            setToken('');
                            setMessage('The token is saved.');
                        })}>Save</button>
                        {status?.saved && (
                            <button className="button" disabled={busy} onClick={() => act(async () => {
                                setStatus(await api.clearToken());
                                setMessage('The token is removed.');
                            })}>Remove</button>
                        )}
                    </div>
                )}
            />
            <SettingsRow
                label="Test the token"
                description='Type the name of an organization, for example "contoso" for dev.azure.com/contoso.'
                control={(
                    <div className="row-buttons">
                        <input value={organization} placeholder="Organization" onChange={event => setOrganization(event.target.value)} disabled={busy} />
                        <button className="button" disabled={busy || !organization.trim()} onClick={() => act(async () => {
                            const user = await api.test(organization);
                            setMessage(`The token works. It belongs to ${user}.`);
                        })}>Test</button>
                    </div>
                )}
            >
                {message && <div className="panel-note">{message}</div>}
                {error && <div className="form-error">{error}</div>}
            </SettingsRow>
        </SettingsGroup>
    );
}
