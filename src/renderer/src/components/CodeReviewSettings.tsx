import { useEffect, useId, useState, type ReactNode } from 'react';
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
import { Button, Card, CardBody, CardFooter, Checkbox, Field, Input, Radio, Select, Switch } from './ui';

const api = window.shipwarden.reviewProviders;

/** The scopes that a personal access token needs, by kind. */
const TOKEN_SCOPES: Record<ReviewProviderKind, string> = {
    github: 'Make a token with these scopes: repo, read:org and workflow.',
    azure: 'Make a token with these scopes: Code (Read & write), Code (Status), Build (Read & execute), Identity (Read) and Project and Team (Read).',
    gitlab: 'Make a token with the "api" scope.',
    bitbucket:
        'Make an Atlassian API token for Bitbucket, or a workspace, project, or repository access token. Give it these scopes: account (read), repositories (read & write), pull requests (read & write), pipelines (read & write), and workspace membership (read).',
    gitea: 'Make a token in Settings › Applications of your server. Give it these scopes: repository (read & write), issue (read & write), user (read), and organization (read).'
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
    if (provider.kind === 'bitbucket') {
        if (source === 'env') return 'ShipWarden uses BITBUCKET_TOKEN from the environment.';
        return 'No token. Save a token, or set BITBUCKET_TOKEN.';
    }
    if (provider.kind === 'gitea') {
        if (source === 'env') return 'ShipWarden uses GITEA_TOKEN from the environment.';
        return 'No token. Save a token, or set GITEA_TOKEN.';
    }
    if (provider.kind === 'gitlab') {
        if (source === 'env') return 'ShipWarden uses GITLAB_TOKEN from the environment.';
        if (source === 'cli') return 'ShipWarden uses the glab CLI login (glab auth login).';
        return 'No token. Save a token, or run "glab auth login" with the glab CLI.';
    }
    if (source === 'env') return 'ShipWarden uses AZURE_DEVOPS_EXT_PAT from the environment.';
    if (source === 'cli') return 'ShipWarden uses the az CLI login (az login).';
    return 'No token. Save a token, or run "az login" with the az CLI.';
}

/** A short text for the summary row, for example "GitHub · 2 organizations · saved token". */
function providerMeta(provider: ReviewProviderInfo): string {
    const parts: string[] = [];
    if (provider.name !== providerKindName(provider.kind)) parts.push(providerKindName(provider.kind));
    if ((provider.kind === 'gitlab' || provider.kind === 'gitea') && provider.baseUrl) parts.push(provider.baseUrl.replace(/^https?:\/\//, ''));
    if (provider.kind === 'gitea' && !provider.baseUrl) parts.push('no server URL');
    parts.push(providerScopeSummary(provider.scope, provider.kind));
    if (provider.kind === 'bitbucket' && provider.username) parts.push(provider.username);
    if (provider.tokenSaved) parts.push('saved token');
    else if (provider.cliAccount) parts.push(`gh account ${provider.cliAccount}`);
    return parts.join(' · ');
}

/**
 * The code review settings: the providers (for example two GitHub accounts, Azure DevOps, and GitLab), each with an on/off
 * switch, its token and its organizations. The layout is the same as the task managers. `children` are more settings
 * groups after the providers. They are siblings of the providers group, so the space between the groups applies.
 */
export function CodeReviewSettings({ children }: { children?: ReactNode }) {
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
                description="A worktree uses a provider of the kind of its remote. When two providers have the same kind, ShipWarden uses the provider whose organizations include the organization of the remote. A GitLab, Gitea, or Forgejo remote uses a provider of its server."
                actions={
                    <div className="add-connection">
                        <Select<ReviewProviderKind | ''>
                            value={adding}
                            aria-label="Provider to add"
                            options={[{ value: '', label: 'Add a provider…' }, ...REVIEW_PROVIDER_KINDS.map(item => ({ value: item.kind, label: item.name }))]}
                            onChange={setAdding}
                        />
                        <Button
                            icon={addMutation.isPending ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} strokeWidth={1.8} />}
                            disabled={!adding || addMutation.isPending}
                            onClick={add}
                        >
                            Add
                        </Button>
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
                    {providers?.length === 0 && <p className="panel-note">No providers yet. Add GitHub, Azure DevOps, GitLab, Bitbucket, or Gitea above.</p>}
                </div>
            </SettingsGroup>

            {children}

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
    const nameId = useId();

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
        <Card tone={open ? 'accent' : 'default'}>
            <div className="card-header">
                <Switch checked={provider.enabled} title={provider.enabled ? 'On' : 'Off'} onChange={enabled => update({ enabled })} />
                <button className="connection-summary" aria-expanded={open} onClick={onToggle}>
                    <span className="connection-name">{provider.name}</span>
                    <span className="connection-meta">{providerMeta(provider)}</span>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                </button>
            </div>
            {open && (
                <CardBody className="connection-body">
                    <Field label="Name" htmlFor={nameId}>
                        <Input
                            id={nameId}
                            value={name}
                            onChange={event => setName(event.target.value)}
                            onBlur={() => name.trim() && name !== provider.name && update({ name })}
                        />
                    </Field>
                    {provider.kind === 'github' && <CliAccountField provider={provider} onChange={cliAccount => update({ cliAccount })} />}
                    {(provider.kind === 'gitlab' || provider.kind === 'gitea') && (
                        <ServerUrlField provider={provider} onChange={baseUrl => update({ baseUrl })} />
                    )}
                    {provider.kind === 'bitbucket' && <UsernameField provider={provider} onChange={username => update({ username })} />}
                    <TokenFields provider={provider} />
                    {provider.kind === 'github' ? (
                        <GitHubScope provider={provider} onChange={scope => update({ scope })} />
                    ) : (
                        <NameScope provider={provider} onChange={scope => update({ scope })} />
                    )}
                    {error && <div className="form-error">{error}</div>}
                </CardBody>
            )}
            {open && (
                <CardFooter>
                    <Button variant="danger" icon={<Trash2 size={13} strokeWidth={1.8} />} onClick={remove}>
                        Remove
                    </Button>
                </CardFooter>
            )}
        </Card>
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
    const id = useId();
    return (
        <Field
            label="GitHub CLI account"
            htmlFor={id}
            hint='Without a saved token, ShipWarden gets the token of this account from "gh auth token". Empty: the active account of the GitHub CLI.'
        >
            <Input
                id={id}
                value={value}
                placeholder="The active account"
                spellCheck={false}
                onChange={event => setValue(event.target.value)}
                onBlur={save}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
        </Field>
    );
}

/** The help text of the server field of each kind that has a server. */
const SERVER_URL_TEXT: Partial<Record<ReviewProviderKind, { placeholder: string; hint: string }>> = {
    gitlab: {
        placeholder: 'https://gitlab.com',
        hint: 'The URL of your self-hosted GitLab server, for example https://git.example.com. Empty: gitlab.com. ShipWarden uses the CA certificates of Settings › Network.'
    },
    gitea: {
        placeholder: 'https://git.example.com',
        hint: 'The URL of your Gitea or Forgejo server, for example https://codeberg.org. When you add the provider, ShipWarden looks for the server in the remotes of your projects. ShipWarden uses the CA certificates of Settings › Network.'
    }
};

/** The server of a GitLab provider (empty means gitlab.com), or of a Gitea or Forgejo provider. */
function ServerUrlField({ provider, onChange }: { provider: ReviewProviderInfo; onChange(url: string | null): void }) {
    const [value, setValue] = useState(provider.baseUrl ?? '');
    useEffect(() => setValue(provider.baseUrl ?? ''), [provider.baseUrl]);
    const save = () => {
        const url = value.trim();
        if (url !== (provider.baseUrl ?? '')) onChange(url || null);
    };
    const id = useId();
    return (
        <Field label="Server URL" htmlFor={id} hint={(SERVER_URL_TEXT[provider.kind] ?? SERVER_URL_TEXT.gitlab!).hint}>
            <Input
                id={id}
                value={value}
                placeholder={(SERVER_URL_TEXT[provider.kind] ?? SERVER_URL_TEXT.gitlab!).placeholder}
                spellCheck={false}
                onChange={event => setValue(event.target.value)}
                onBlur={save}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
        </Field>
    );
}

/** The email or the username of a Bitbucket provider, for Basic auth. Empty means an access token (Bearer). */
function UsernameField({ provider, onChange }: { provider: ReviewProviderInfo; onChange(username: string | null): void }) {
    const [value, setValue] = useState(provider.username ?? '');
    useEffect(() => setValue(provider.username ?? ''), [provider.username]);
    const save = () => {
        const username = value.trim();
        if (username !== (provider.username ?? '')) onChange(username || null);
    };
    const id = useId();
    return (
        <Field
            label="Email or username"
            htmlFor={id}
            hint="For an Atlassian API token, type the email of your Atlassian account. For an app password, type your Bitbucket username. For a workspace, project, or repository access token, keep it empty."
        >
            <Input
                id={id}
                value={value}
                placeholder="Empty for an access token"
                spellCheck={false}
                autoComplete="off"
                onChange={event => setValue(event.target.value)}
                onBlur={save}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
        </Field>
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
    const tokenId = useId();
    const testId = useId();
    return (
        <>
            <Field
                label={provider.kind === 'bitbucket' ? 'Token' : 'Personal access token'}
                htmlFor={tokenId}
                hint={`${source === null ? 'Loading…' : tokenSourceText(provider, source)} ${TOKEN_SCOPES[provider.kind]}`}
            >
                <div className="row-buttons inline-field">
                    <Input
                        id={tokenId}
                        type="password"
                        value={token}
                        placeholder={provider.tokenSaved ? 'Saved. Type a new value to change it.' : 'Paste a token'}
                        onChange={event => setToken(event.target.value)}
                        disabled={busy}
                    />
                    <Button
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
                    </Button>
                    {provider.tokenSaved && (
                        <Button
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
                        </Button>
                    )}
                </div>
            </Field>
            <Field
                label="Test the token"
                htmlFor={azure ? testId : undefined}
                hint={azure ? 'Type the name of an organization, for example "contoso" for dev.azure.com/contoso.' : undefined}
            >
                <div className="row-buttons inline-field">
                    {azure && (
                        <Input
                            id={testId}
                            value={organization}
                            placeholder={provider.scope?.[0] ?? 'Organization'}
                            onChange={event => setOrganization(event.target.value)}
                            disabled={busy}
                        />
                    )}
                    <Button
                        disabled={busy || (azure && !organization.trim() && !provider.scope?.[0])}
                        onClick={() =>
                            act(async () => {
                                const user = await api.test(provider.id, azure ? organization : undefined);
                                return `The token works. It belongs to ${user}.`;
                            })
                        }
                    >
                        Test
                    </Button>
                </div>
            </Field>
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
        <Field label="Organizations" hint="The Review view, the Pipelines view and the Dashboard show the repositories of these organizations.">
            <div className="scope-picker">
                <Radio checked={mode === 'all'} onSelect={() => onChange(null)} label="All organizations, also new ones" />
                <Radio
                    checked={mode === 'some'}
                    onSelect={() => onChange(value ?? (owners ?? []).map(owner => owner.login))}
                    label="Only these organizations:"
                />
                {error && <div className="form-error">{error}</div>}
                {!owners && !error && (
                    <div className="panel-note">
                        <LoaderCircle size={12} className="spin" /> Loading the organizations…
                    </div>
                )}
                {owners && (
                    <div className="scope-list">
                        {owners.map(owner => (
                            <Checkbox
                                key={owner.login}
                                disabled={mode !== 'some'}
                                checked={mode === 'some' && !!value?.some(item => item.toLowerCase() === owner.login.toLowerCase())}
                                onChange={checked => {
                                    const current = value ?? [];
                                    onChange(checked ? [...current, owner.login] : current.filter(item => item.toLowerCase() !== owner.login.toLowerCase()));
                                }}
                                label={
                                    <>
                                        {owner.login}
                                        {owner.kind === 'user' && <span className="scope-detail"> your account</span>}
                                    </>
                                }
                            />
                        ))}
                    </div>
                )}
            </div>
        </Field>
    );
}

/** The help text of the scope field of each kind that has a list of names. */
const NAME_SCOPE_TEXT: Partial<Record<ReviewProviderKind, { label: string; placeholder: string; hint: string }>> = {
    azure: {
        label: 'Organizations',
        placeholder: 'All organizations',
        hint: 'The names of the organizations, with a comma between them. For example "contoso" for dev.azure.com/contoso. Empty: all organizations.'
    },
    bitbucket: {
        label: 'Workspaces',
        placeholder: 'All workspaces',
        hint: 'The slugs of the workspaces, with a comma between them. For example "acme" for bitbucket.org/acme. Empty: the workspaces of your account (at most 10). An access token needs its workspace here.'
    },
    gitea: {
        label: 'Owners',
        placeholder: 'All owners',
        hint: 'The names of the organizations and users, with a comma between them. For example "acme" for git.example.com/acme. Empty: all repositories that you can access.'
    },
    gitlab: {
        label: 'Groups',
        placeholder: 'All groups',
        hint: 'The paths of the groups, with a comma between them. For example "acme" or "acme/platform". Subgroups are included. Empty: all projects that you are a member of.'
    }
};

/** The Azure DevOps organizations, the GitLab groups, the Bitbucket workspaces, or the Gitea owners of a provider, as a list of names. Empty means all of them. */
function NameScope({ provider, onChange }: { provider: ReviewProviderInfo; onChange(scope: string[] | null): void }) {
    const labels = NAME_SCOPE_TEXT[provider.kind] ?? NAME_SCOPE_TEXT.azure!;
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
    const id = useId();
    return (
        <Field label={labels.label} htmlFor={id} hint={labels.hint}>
            <Input
                id={id}
                value={value}
                placeholder={labels.placeholder}
                spellCheck={false}
                onChange={event => setValue(event.target.value)}
                onBlur={save}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
        </Field>
    );
}
