import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { AppSettings } from '@shared/settings';
import { parseSlackUserIds, type SlackStatus, type SlackTokenInput } from '@shared/slack';
import { keyRoots } from '../query-client';
import { optionalErrorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button, Combobox, Input, sortedGroups, Switch } from './ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

const api = window.shipwarden.slack;
const statusKey = [...keyRoots.slack, 'status'];
const channelsKey = [...keyRoots.slack, 'channels'];

/** The line under the switch: the state of the connection. */
function ConnectionNote({ status, enabled }: { status: SlackStatus | undefined; enabled: boolean }) {
    if (!status || !enabled) return null;
    if (!status.tokens.bot || !status.tokens.app) {
        return <div className="panel-note">Save the bot token and the app-level token to connect.</div>;
    }
    switch (status.state) {
        case 'connected':
            return (
                <>
                    <div className="panel-note">
                        <CircleCheck size={12} strokeWidth={2} className="ok-icon" /> Connected
                        {status.team ? ` to ${status.team}` : ''}
                        {status.botName ? ` as @${status.botName}` : ''}.
                    </div>
                    {status.error && (
                        <div className="form-error">
                            <TriangleAlert size={12} /> {status.error}
                        </div>
                    )}
                </>
            );
        case 'connecting':
            return (
                <div className="panel-note">
                    <LoaderCircle size={12} className="spin" /> Connecting to Slack…
                </div>
            );
        case 'standby':
            return <div className="panel-note">The background helper runs the Slack connection while the ShipWarden window is closed.</div>;
        case 'error':
            return (
                <div className="form-error">
                    <TriangleAlert size={12} /> {status.error ?? 'The Slack connection failed.'}
                </div>
            );
        default:
            return null;
    }
}

/**
 * Settings › Slack: the tokens of the Slack app, the switch, the channel, and the people who can start and answer
 * agents. The tokens go to the keychain, and the page never gets them back.
 */
export function SlackSettings({ settings, onSave }: Props) {
    const slack = settings.slack;
    const queryClient = useQueryClient();
    const botId = useId();
    const appId = useId();
    const [tokens, setTokens] = useState<SlackTokenInput>({});
    const [people, setPeople] = useState(slack.allowedUserIds.join(', '));
    const [peopleError, setPeopleError] = useState<string>();
    const [channelsWanted, setChannelsWanted] = useState(false);
    useEffect(() => setPeople(slack.allowedUserIds.join(', ')), [slack.allowedUserIds]);

    const statusQuery = useQuery({ queryKey: statusKey, queryFn: () => api.status(), staleTime: 0 });
    const status = statusQuery.data;
    // The main process sends each change of the connection. It replaces the cached state, without a new request.
    useEffect(() => api.onChanged(next => queryClient.setQueryData(statusKey, next)), [queryClient]);

    // The channel list asks Slack, so it loads only when the picker opens, and the cache keeps it for 5 minutes.
    const channelsQuery = useQuery({
        queryKey: channelsKey,
        queryFn: () => api.channels(),
        enabled: channelsWanted && !!status?.tokens.bot,
        staleTime: 5 * 60_000
    });

    const saveSettings = useMutation({ mutationFn: (change: Partial<AppSettings['slack']>) => onSave({ slack: { ...slack, ...change } }) });
    const saveTokens = useMutation({
        mutationFn: (input: SlackTokenInput) => api.saveTokens(input),
        onSuccess: (next, input) => {
            queryClient.setQueryData(statusKey, next);
            setTokens({});
            // A new bot token can see different channels.
            if (input.bot) queryClient.removeQueries({ queryKey: channelsKey });
        }
    });
    const clearTokens = useMutation({
        mutationFn: () => api.clearTokens(),
        onSuccess: next => {
            queryClient.setQueryData(statusKey, next);
            queryClient.removeQueries({ queryKey: channelsKey });
        }
    });
    const error = optionalErrorText(saveSettings.error ?? saveTokens.error ?? clearTokens.error ?? statusQuery.error);
    const busy = saveTokens.isPending || clearTokens.isPending;

    const commitPeople = () => {
        const { ids, invalid } = parseSlackUserIds(people);
        if (invalid.length > 0) {
            setPeopleError(`These values are not Slack member IDs: ${invalid.join(', ')}. A member ID looks like U012AB3CD.`);
            return;
        }
        setPeopleError(undefined);
        if (ids.join(',') !== slack.allowedUserIds.join(',')) saveSettings.mutate({ allowedUserIds: ids });
    };

    const channels = channelsQuery.data ?? [];
    const groups = sortedGroups(
        channels,
        channel => (channel.isPrivate ? 'Private channels' : 'Public channels'),
        channel => ({ value: channel.id, label: `#${channel.name}` })
    );
    const selectChannel = (id: string) => {
        const channel = channels.find(item => item.id === id);
        if (channel) saveSettings.mutate({ channelId: channel.id, channelName: channel.name });
    };

    const tokenRow = (kind: 'bot' | 'app', id: string) => {
        const saved = status?.tokens[kind];
        return (
            <div className="row-buttons inline-field">
                <Input
                    id={id}
                    type="password"
                    mono
                    value={tokens[kind] ?? ''}
                    placeholder={saved ? 'Saved. Paste a new token to change it.' : kind === 'bot' ? 'xoxb-…' : 'xapp-…'}
                    spellCheck={false}
                    disabled={busy}
                    onChange={event => setTokens(current => ({ ...current, [kind]: event.target.value }))}
                />
                <Button disabled={busy || !tokens[kind]?.trim()} onClick={() => saveTokens.mutate({ [kind]: tokens[kind] })}>
                    Save
                </Button>
            </div>
        );
    };

    return (
        <SettingsGroup
            title="Slack"
            description={
                <>
                    ShipWarden posts a question in a Slack channel when an agent needs input for 10 seconds. A reply in the thread goes to the agent. A message
                    that mentions the app starts an agent in a new worktree, for example <code>@ShipWarden web Fix the login bug</code>. The app uses Socket
                    Mode, so it needs no public address. Create the Slack app from the manifest in <code>docs/slack.md</code>.
                </>
            }
            card
        >
            <SettingsRow
                label="Connect to Slack"
                description="The connection runs while a ShipWarden window is open. While ShipWarden is closed, the background helper runs it when “Run while ShipWarden is closed” is on in Automations."
                control={
                    <Switch
                        checked={slack.enabled}
                        title={slack.enabled ? 'On' : 'Off'}
                        disabled={saveSettings.isPending}
                        onChange={enabled => saveSettings.mutate({ enabled })}
                    />
                }
            >
                <ConnectionNote status={status} enabled={slack.enabled} />
            </SettingsRow>
            <SettingsRow label="Bot token" description="OAuth & Permissions › Bot User OAuth Token of the Slack app. It starts with “xoxb-”.">
                {tokenRow('bot', botId)}
            </SettingsRow>
            <SettingsRow
                label="App-level token"
                description="Basic Information › App-Level Tokens of the Slack app, with the scope connections:write. It starts with “xapp-”."
            >
                {tokenRow('app', appId)}
            </SettingsRow>
            {(status?.tokens.bot || status?.tokens.app) && (
                <SettingsRow
                    label="Remove the tokens"
                    description="Removes both tokens from the keychain and disconnects."
                    control={
                        <Button variant="danger" disabled={busy} onClick={() => clearTokens.mutate()}>
                            Remove
                        </Button>
                    }
                />
            )}
            <SettingsRow
                label="Channel"
                description="The questions go to this channel, and the app reads the mentions in it. The app joins a public channel. For a private channel, type /invite @ShipWarden in the channel first."
                control={
                    <Combobox
                        className="slack-channel-picker"
                        value={slack.channelId}
                        groups={groups}
                        onChange={selectChannel}
                        onOpen={() => setChannelsWanted(true)}
                        disabled={!status?.tokens.bot}
                        placeholder={channelsQuery.isFetching ? 'Loading…' : slack.channelName ? `#${slack.channelName}` : 'Select a channel'}
                        searchPlaceholder="Search channels"
                        aria-label="Slack channel"
                    />
                }
            >
                {channelsQuery.error && <div className="form-error">{optionalErrorText(channelsQuery.error)}</div>}
            </SettingsRow>
            <SettingsRow
                label="People who can start and answer agents"
                description="The Slack member IDs, for example U012AB3CD. In Slack, open a profile, click ⋮, then Copy member ID. ShipWarden ignores everybody else, and tells them their member ID."
            >
                <Input
                    mono
                    value={people}
                    placeholder="U012AB3CD, U045EF6GH"
                    spellCheck={false}
                    onChange={event => setPeople(event.target.value)}
                    onBlur={commitPeople}
                    onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                />
                {peopleError && <div className="form-error">{peopleError}</div>}
                {!peopleError && slack.allowedUserIds.length === 0 && (
                    <div className="panel-note">Nobody can start or answer agents from Slack until you add a member ID.</div>
                )}
            </SettingsRow>
            {error && (
                <div className="settings-row">
                    <div className="form-error">{error}</div>
                </div>
            )}
        </SettingsGroup>
    );
}
