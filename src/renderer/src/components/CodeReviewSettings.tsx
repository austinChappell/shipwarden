import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { GitHubOwner } from '@shared/github';
import type { AzureTokenStatus } from '@shared/azure-devops';
import type { AppSettings } from '@shared/settings';
import { errorText } from '../util';
import { SettingsGroup } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

type ProviderId = 'github' | 'azure';

/**
 * The code review settings: one card for each provider, in the same layout as the task managers.
 * ShipWarden uses the provider that agrees with the remote of each worktree, so all providers are on.
 */
export function CodeReviewSettings({ settings, onSave }: Props) {
    const [openId, setOpenId] = useState<ProviderId>();
    const toggle = (id: ProviderId) => setOpenId(current => (current === id ? undefined : id));

    return (
        <SettingsGroup
            title="Providers"
            description="ShipWarden uses the provider of the remote of each worktree. Open a provider to change its settings."
        >
            <div className="connection-list">
                <GitHubProvider settings={settings} onSave={onSave} open={openId === 'github'} onToggle={() => toggle('github')} />
                <AzureDevOpsProvider open={openId === 'azure'} onToggle={() => toggle('azure')} />
            </div>
        </SettingsGroup>
    );
}

interface ProviderCardProps {
    name: string;
    meta: ReactNode;
    open: boolean;
    onToggle(): void;
    children: ReactNode;
}

/** One provider: a summary row that opens to its settings. */
function ProviderCard({ name, meta, open, onToggle, children }: ProviderCardProps) {
    return (
        <div className={`connection-card${open ? ' open' : ''}`}>
            <div className="connection-row">
                <button className="connection-summary" aria-expanded={open} onClick={onToggle}>
                    <span className="connection-name">{name}</span>
                    <span className="connection-meta">{meta}</span>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                </button>
            </div>
            {open && <div className="connection-body">{children}</div>}
        </div>
    );
}

interface GitHubProviderProps extends Props {
    open: boolean;
    onToggle(): void;
}

/** GitHub: the login and the organizations whose pull requests the Review view shows. */
function GitHubProvider({ settings, onSave, open, onToggle }: GitHubProviderProps) {
    const [owners, setOwners] = useState<GitHubOwner[]>();
    const [error, setError] = useState<string>();
    const selected = settings.reviewOwners;

    useEffect(() => {
        window.shipwarden.github.owners().then(setOwners, err => setError(errorText(err)));
    }, []);

    const save = (reviewOwners: string[] | 'all') => onSave({ reviewOwners }).catch(err => setError(errorText(err)));
    const mode = selected === 'all' ? 'all' : selected ? 'some' : undefined;
    const list = Array.isArray(selected) ? selected : [];
    const meta = mode === 'all'
        ? 'github.com · All organizations'
        : mode === 'some'
            ? `github.com · ${list.length} organization${list.length === 1 ? '' : 's'}`
            : <>github.com<span className="connection-warning"> · select the organizations</span></>;

    return (
        <ProviderCard name="GitHub" meta={meta} open={open} onToggle={onToggle}>
            <p className="panel-note">ShipWarden uses the GitHub CLI login (gh auth login) or GITHUB_TOKEN.</p>
            <div className="connection-section-label">Organizations</div>
            <p className="panel-note">The Review view lists the repositories of these organizations. You select one repository at a time there.</p>
            <div className="scope-picker">
                <label className="scope-option">
                    <input type="radio" checked={mode === 'all'} onChange={() => save('all')} />
                    All organizations, also new ones
                </label>
                <label className="scope-option">
                    <input type="radio" checked={mode === 'some'} onChange={() => save(owners ? owners.map(owner => owner.login) : [])} />
                    Only these organizations:
                </label>
                {error && <div className="form-error">{error}</div>}
                {!owners && !error && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading your organizations…</div>}
                {owners && (
                    <div className={`scope-list${mode === 'some' ? '' : ' disabled'}`}>
                        {owners.map(owner => (
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
                        ))}
                    </div>
                )}
            </div>
        </ProviderCard>
    );
}

const TOKEN_SOURCE_TEXT: Record<NonNullable<AzureTokenStatus['source']>, string> = {
    env: 'ShipWarden uses AZURE_DEVOPS_EXT_PAT from the environment.',
    saved: 'ShipWarden uses the saved token.',
    az: 'ShipWarden uses the az CLI login (az login).'
};

const TOKEN_SOURCE_META: Record<NonNullable<AzureTokenStatus['source']>, string> = {
    env: 'AZURE_DEVOPS_EXT_PAT',
    saved: 'Saved token',
    az: 'az CLI login'
};

/**
 * Azure DevOps: the token. Pull requests and pipelines of worktrees with an Azure Repos remote use it.
 * The token goes to the main process, which encrypts it with the macOS keychain. The page never reads it back.
 */
function AzureDevOpsProvider({ open, onToggle }: { open: boolean; onToggle(): void }) {
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

    const meta = !status
        ? 'Loading…'
        : status.source
            ? `Azure Repos · ${TOKEN_SOURCE_META[status.source]}`
            : <>Azure Repos<span className="connection-warning"> · needs a token</span></>;

    return (
        <ProviderCard name="Azure DevOps" meta={meta} open={open} onToggle={onToggle}>
            <p className="panel-note">
                For repositories on Azure Repos (dev.azure.com or visualstudio.com). Make a personal access token with these scopes:
                Code (Read & write), Code (Status), Build (Read & execute), Identity (Read) and Project and Team (Read).
            </p>
            <div className="setting-row">
                <span className="setting-label">Personal access token</span>
                <div className="row-buttons inline-field">
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
                <span className="panel-note">
                    {status ? (status.source ? TOKEN_SOURCE_TEXT[status.source] : 'No token. Save a token, or run "az login" with the az CLI.') : 'Loading…'}
                </span>
            </div>
            <div className="setting-row">
                <span className="setting-label">Test the token</span>
                <div className="row-buttons inline-field">
                    <input value={organization} placeholder="Organization" onChange={event => setOrganization(event.target.value)} disabled={busy} />
                    <button className="button" disabled={busy || !organization.trim()} onClick={() => act(async () => {
                        const user = await api.test(organization);
                        setMessage(`The token works. It belongs to ${user}.`);
                    })}>Test</button>
                </div>
                <span className="panel-note">Type the name of an organization, for example "contoso" for dev.azure.com/contoso.</span>
            </div>
            {message && <div className="panel-note">{message}</div>}
            {error && <div className="form-error">{error}</div>}
        </ProviderCard>
    );
}
