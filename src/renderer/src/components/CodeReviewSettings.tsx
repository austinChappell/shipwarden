import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import {
    REVIEW_PROVIDER_KINDS,
    providerKindName,
    providerScopeSummary,
    type ReviewProviderChange,
    type ReviewProviderInfo,
    type ReviewProviderKind,
    type ReviewTokenSource
} from '@shared/review-providers';
import { providerAdded, providerChanged, providerRemoved, providerTokenChanged, reviewProviderKeys, useReviewProviders } from '../review-providers-store';
import { optionalErrorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { SettingsGroup } from './settings-ui';
import { Select } from './Select';

const api = window.shipwarden.reviewProviders;

/** The scopes that a personal access token needs, by kind. */
const TOKEN_SCOPES: Record<ReviewProviderKind, string> = {
    github: 'Make a token with these scopes: repo, read:org and workflow.',
    azure: 'Make a token with these scopes: Code (Read & write), Code (Status), Build (Read & execute), Identity (Read) and Project and Team (Read).'
};

function tokenSourceText(provider: ReviewProviderInfo, source: ReviewTokenSource | undefined): string {
    if (source === 'saved') return 'ShipWarden uses the saved token.';
    if (provider.kind === 'github') {
        if (source === 'env') return 'ShipWarden uses GITHUB_TOKEN from the environment.';
        if (source === 'cli') {
            return provider.cliAccount
                ? `ShipWarden uses the GitHub CLI account "${provider.cliAccount}".`
                : 'ShipWarden uses the GitHub CLI login (gh auth login).';
        }
        return 'No token. Save a token, or run "gh auth login" with the GitHub CLI.';
    }
    if (source === 'env') return 'ShipWarden uses AZURE_DEVOPS_EXT_PAT from the environment.';
    if (source === 'cli') return 'ShipWarden uses the az CLI login (az login).';
    return 'No token. Save a token, or run "az login" with the az CLI.';
}

/** A short text for the summary row, for example "GitHub · 2 organizations · saved token". */
function providerMeta(provider: ReviewProviderInfo): string {
    const parts: string[] = [];
    if (provider.name !== providerKindName(provider.kind)) parts.push(providerKindName(provider.kind));
    parts.push(providerScopeSummary(provider.scope));
    if (provider.tokenSaved) parts.push('saved token');
    else if (provider.cliAccount) parts.push(`gh account ${provider.cliAccount}`);
    return parts.join(' · ');
}

/**
 * The code review settings: the providers (for example two GitHub accounts and Azure DevOps), each with an on/off
 * switch, its token and its organizations. The layout is the same as the task managers.
 */
export function CodeReviewSettings() {
    const queryClient = useQueryClient();
    const providers = useReviewProviders();
    const [openId, setOpenId] = useState<string>();
    const [adding, setAdding] = useState<ReviewProviderKind | ''>('');

    const addMutation = useMutation({
        mutationFn: (kind: ReviewProviderKind) => {
            const existing = (providers ?? []).filter(item => item.kind === kind).length;
            const name = providerKindName(kind);
            return api.add(kind, existing ? `${name} ${existing + 1}` : name);
        },
        onSuccess: created => {
            setAdding('');
            setOpenId(created.id);
            providerAdded(queryClient, created);
        }
    });
    const error = optionalErrorText(addMutation.error);

    const add = () => {
        if (adding) addMutation.mutate(adding);
    };

    return (
        <div className="task-managers">
            <SettingsGroup
                title="Providers"
                description="A worktree uses a provider of the kind of its remote. When two providers have the same kind, ShipWarden uses the provider whose organizations include the organization of the remote."
                actions={
                    <div className="add-connection">
                        <Select<ReviewProviderKind | ''>
                            className="tasks-select"
                            value={adding}
                            aria-label="Provider to add"
                            options={[{ value: '', label: 'Add a provider…' }, ...REVIEW_PROVIDER_KINDS.map(item => ({ value: item.kind, label: item.name }))]}
                            onChange={setAdding}
                        />
                        <button className="button" disabled={!adding} onClick={add}>
                            <Plus size={13} strokeWidth={1.8} />
                            Add
                        </button>
                    </div>
                }
            >
                <div className="connection-list">
                    {!providers && (
                        <p className="panel-note">
                            <LoaderCircle size={12} className="spin" /> Loading the providers…
                        </p>
                    )}
                    {providers?.map(provider => (
                        <ProviderCard
                            key={provider.id}
                            provider={provider}
                            open={openId === provider.id}
                            onToggle={() => setOpenId(id => (id === provider.id ? undefined : provider.id))}
                        />
                    ))}
                    {providers?.length === 0 && <p className="panel-note">No providers yet. Add GitHub or Azure DevOps above.</p>}
                </div>
            </SettingsGroup>

            {error && <div className="form-error">{error}</div>}
        </div>
    );
}

/** One provider: a summary row that opens to its name, token and organizations. */
function ProviderCard({ provider, open, onToggle }: { provider: ReviewProviderInfo; open: boolean; onToggle(): void }) {
    const queryClient = useQueryClient();
    const [name, setName] = useState(provider.name);
    useEffect(() => setName(provider.name), [provider.name]);

    const updateMutation = useMutation({
        mutationFn: (change: ReviewProviderChange) => api.update(provider.id, change),
        onSuccess: (_result, change) => providerChanged(queryClient, provider, change)
    });
    const removeMutation = useMutation({
        mutationFn: () => api.remove(provider.id),
        onSuccess: () => providerRemoved(queryClient, provider)
    });
    const error = optionalErrorText(updateMutation.error ?? removeMutation.error);
    const update = (change: ReviewProviderChange) => updateMutation.mutate(change);

    const remove = async () => {
        if (
            !(await confirmDialog({
                title: `Remove the provider "${provider.name}"?`,
                message:
                    'ShipWarden forgets its settings and its token. Worktrees with a remote of this kind use another provider of the same kind, if there is one.',
                confirmLabel: 'Remove',
                danger: true
            }))
        ) {
            return;
        }
        removeMutation.mutate();
    };

    return (
        <div className={`connection-card${open ? ' open' : ''}`}>
            <div className="connection-row">
                <label className="switch" title={provider.enabled ? 'On' : 'Off'}>
                    <input type="checkbox" checked={provider.enabled} onChange={event => update({ enabled: event.target.checked })} />
                    <span />
                </label>
                <button className="connection-summary" aria-expanded={open} onClick={onToggle}>
                    <span className="connection-name">{provider.name}</span>
                    <span className="connection-meta">{providerMeta(provider)}</span>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                </button>
            </div>
            {open && (
                <div className="connection-body">
                    <label className="setting-row">
                        <span className="setting-label">Name</span>
                        <input
                            value={name}
                            onChange={event => setName(event.target.value)}
                            onBlur={() => name.trim() && name !== provider.name && update({ name })}
                        />
                    </label>
                    {provider.kind === 'github' && <CliAccountField provider={provider} onChange={cliAccount => update({ cliAccount })} />}
                    <TokenFields provider={provider} />
                    <div className="connection-section-label">Organizations</div>
                    {provider.kind === 'github' ? (
                        <GitHubScope provider={provider} onChange={scope => update({ scope })} />
                    ) : (
                        <AzureScope provider={provider} onChange={scope => update({ scope })} />
                    )}
                    {error && <div className="form-error">{error}</div>}
                    <div className="row-buttons">
                        <button className="button danger" onClick={remove}>
                            <Trash2 size={13} strokeWidth={1.8} />
                            Remove
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

/** The account of the GitHub CLI. With more than one account in `gh`, each GitHub provider can use another account. */
function CliAccountField({ provider, onChange }: { provider: ReviewProviderInfo; onChange(account: string | null): void }) {
    const [value, setValue] = useState(provider.cliAccount ?? '');
    useEffect(() => setValue(provider.cliAccount ?? ''), [provider.cliAccount]);
    const save = () => {
        const account = value.trim();
        if (account !== (provider.cliAccount ?? '')) onChange(account || null);
    };
    return (
        <label className="setting-row">
            <span className="setting-label">GitHub CLI account</span>
            <input
                value={value}
                placeholder="The active account"
                spellCheck={false}
                onChange={event => setValue(event.target.value)}
                onBlur={save}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
            <span className="panel-note">
                Without a saved token, ShipWarden gets the token of this account from "gh auth token". Empty: the active account of the GitHub CLI.
            </span>
        </label>
    );
}

/** The personal access token of a provider and a test of the token. The page never reads the token back. */
function TokenFields({ provider }: { provider: ReviewProviderInfo }) {
    const queryClient = useQueryClient();
    const [token, setToken] = useState('');
    const [organization, setOrganization] = useState('');

    // A new token or CLI account marks the source as stale. The settings page shows the current source each time that it opens.
    const sourceQuery = useQuery({
        queryKey: reviewProviderKeys.tokenSource(provider.id),
        // A query cannot keep undefined, so "no token" is null in the cache.
        queryFn: async () => (await api.tokenSource(provider.id)) ?? null,
        staleTime: 0
    });
    /** Null while the source loads. Undefined when no token is available or the request failed. */
    const source: ReviewTokenSource | undefined | null = sourceQuery.isPending ? null : (sourceQuery.data ?? undefined);

    /** The token actions of the page. Each one returns the message to show after it. */
    const action = useMutation({
        mutationFn: async (run: () => Promise<string>) => run()
    });
    const busy = action.isPending;
    const message = action.data;
    const error = optionalErrorText(action.error);
    const act = (run: () => Promise<string>) => action.mutate(run);

    const azure = provider.kind === 'azure';
    return (
        <>
            <div className="setting-row">
                <span className="setting-label">Personal access token</span>
                <div className="row-buttons inline-field">
                    <input
                        type="password"
                        value={token}
                        placeholder={provider.tokenSaved ? 'Saved. Type a new value to change it.' : 'Paste a token'}
                        onChange={event => setToken(event.target.value)}
                        disabled={busy}
                    />
                    <button
                        className="button"
                        disabled={busy || !token.trim()}
                        onClick={() =>
                            act(async () => {
                                await api.saveToken(provider.id, token);
                                setToken('');
                                providerTokenChanged(queryClient, provider, true);
                                return 'The token is saved.';
                            })
                        }
                    >
                        Save
                    </button>
                    {provider.tokenSaved && (
                        <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                                act(async () => {
                                    await api.clearToken(provider.id);
                                    providerTokenChanged(queryClient, provider, false);
                                    return 'The token is removed.';
                                })
                            }
                        >
                            Remove
                        </button>
                    )}
                </div>
                <span className="panel-note">
                    {source === null ? 'Loading…' : tokenSourceText(provider, source)} {TOKEN_SCOPES[provider.kind]}
                </span>
            </div>
            <div className="setting-row">
                <span className="setting-label">Test the token</span>
                <div className="row-buttons inline-field">
                    {azure && (
                        <input
                            value={organization}
                            placeholder={provider.scope?.[0] ?? 'Organization'}
                            onChange={event => setOrganization(event.target.value)}
                            disabled={busy}
                        />
                    )}
                    <button
                        className="button"
                        disabled={busy || (azure && !organization.trim() && !provider.scope?.[0])}
                        onClick={() =>
                            act(async () => {
                                const user = await api.test(provider.id, azure ? organization : undefined);
                                return `The token works. It belongs to ${user}.`;
                            })
                        }
                    >
                        Test
                    </button>
                </div>
                {azure && <span className="panel-note">Type the name of an organization, for example "contoso" for dev.azure.com/contoso.</span>}
            </div>
            {message && <div className="panel-note">{message}</div>}
            {error && <div className="form-error">{error}</div>}
        </>
    );
}

/** The GitHub organizations of a provider: all of them, or a list from the account of the token. */
function GitHubScope({ provider, onChange }: { provider: ReviewProviderInfo; onChange(scope: string[] | null): void }) {
    // The organizations come from GitHub. A new token or CLI account marks them as stale.
    const ownersQuery = useQuery({
        queryKey: reviewProviderKeys.githubOwners(provider.id),
        queryFn: () => api.githubOwners(provider.id)
    });
    const owners = ownersQuery.data;
    const error = optionalErrorText(ownersQuery.error);

    const value = provider.scope;
    const mode = value ? 'some' : 'all';
    return (
        <div className="scope-picker">
            <p className="panel-note">The Review view, the Pipelines view and the Dashboard show the repositories of these organizations.</p>
            <label className="scope-option">
                <input type="radio" checked={mode === 'all'} onChange={() => onChange(null)} />
                All organizations, also new ones
            </label>
            <label className="scope-option">
                <input type="radio" checked={mode === 'some'} onChange={() => onChange(value ?? (owners ?? []).map(owner => owner.login))} />
                Only these organizations:
            </label>
            {error && <div className="form-error">{error}</div>}
            {!owners && !error && (
                <div className="panel-note">
                    <LoaderCircle size={12} className="spin" /> Loading the organizations…
                </div>
            )}
            {owners && (
                <div className={`scope-list${mode === 'some' ? '' : ' disabled'}`}>
                    {owners.map(owner => (
                        <label key={owner.login} className="scope-item">
                            <input
                                type="checkbox"
                                disabled={mode !== 'some'}
                                checked={mode === 'some' && !!value?.some(item => item.toLowerCase() === owner.login.toLowerCase())}
                                onChange={event => {
                                    const current = value ?? [];
                                    onChange(
                                        event.target.checked
                                            ? [...current, owner.login]
                                            : current.filter(item => item.toLowerCase() !== owner.login.toLowerCase())
                                    );
                                }}
                            />
                            <span>{owner.login}</span>
                            {owner.kind === 'user' && <span className="scope-detail">your account</span>}
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}

/** The Azure DevOps organizations of a provider, as a list of names. Empty means all organizations. */
function AzureScope({ provider, onChange }: { provider: ReviewProviderInfo; onChange(scope: string[] | null): void }) {
    const text = (provider.scope ?? []).join(', ');
    const [value, setValue] = useState(text);
    useEffect(() => setValue(text), [text]);
    const save = () => {
        const names = value
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
        if (names.join(', ') !== text) onChange(names.length ? names : null);
    };
    return (
        <label className="setting-row">
            <input
                value={value}
                placeholder="All organizations"
                spellCheck={false}
                onChange={event => setValue(event.target.value)}
                onBlur={save}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
            <span className="panel-note">
                The names of the organizations, with a comma between them. For example "contoso" for dev.azure.com/contoso. Empty: all organizations.
            </span>
        </label>
    );
}
