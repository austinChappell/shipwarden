import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { DASHBOARD_WINDOW_DAYS, matchesRule, ruleRegex } from '@shared/dashboard';
import type { AppSettings, HiddenCommentMatch, HiddenCommentRule } from '@shared/settings';
import { useDashboard } from '../dashboard-store';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button, IconButton, Input, Select } from './ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
    /** A new rule from a comment on the Dashboard. A new `nonce` fills in the form again. */
    prefill?: { author: string; text: string; nonce: number };
}

const MATCH_LABELS: Record<HiddenCommentMatch, string> = {
    startsWith: 'Starts with',
    contains: 'Contains',
    regex: 'Regular expression'
};

/** The last pre-fill that the form used. When the settings page opens again later, the form must not use it again. */
let appliedPrefill = 0;

/** The first line of a comment. */
function firstLine(text: string): string {
    return text.trim().split('\n')[0].trim().slice(0, 120);
}

/**
 * The fixed start of a comment, for a new "starts with" rule: the words before the first word with a digit.
 * An automation comment often ends with an ID or a number, for example "Linked to ClickUp task: ABC-1234".
 */
export function fixedStart(text: string): string {
    const words = firstLine(text).split(/\s+/);
    const index = words.findIndex(word => /\d/.test(word));
    return index >= 2 ? words.slice(0, index).join(' ') : firstLine(text);
}

/** The Dashboard settings: hidden authors and rules that hide comments. */
export function DashboardSettings({ settings, onSave, prefill }: Props) {
    const [name, setName] = useState('');
    const [error, setError] = useState<string>();
    const [author, setAuthor] = useState('');
    const [match, setMatch] = useState<HiddenCommentMatch>('startsWith');
    const [text, setText] = useState('');
    const hidden = settings.dashboardHiddenAuthors ?? [];
    const rules = settings.dashboardHiddenRules ?? [];
    const dashboard = useDashboard();

    // biome-ignore lint/correctness/useExhaustiveDependencies: The form fills only for a new nonce. Other prefill changes must not overwrite the user's edits.
    useEffect(() => {
        if (prefill && prefill.nonce !== appliedPrefill) {
            appliedPrefill = prefill.nonce;
            setAuthor(prefill.author);
            setMatch('startsWith');
            setText(fixedStart(prefill.text));
        }
    }, [prefill?.nonce]);

    const save = (change: Partial<AppSettings>) => onSave(change).catch(err => setError(errorText(err)));
    const addAuthor = () => {
        const value = name.trim();
        if (value && !hidden.some(item => item.toLowerCase() === value.toLowerCase())) {
            void save({ dashboardHiddenAuthors: [...hidden, value] });
        }
        setName('');
    };

    const regexError = match === 'regex' && text.trim() ? ruleRegex(text) : undefined;
    const regexValid = typeof regexError !== 'string';
    const draft = useMemo<HiddenCommentRule | undefined>(
        () => (text.trim() && regexValid ? { id: 'draft', author: author.trim() || undefined, match, text } : undefined),
        [author, match, text, regexValid]
    );

    /** The comments on the Dashboard now that the draft rule hides, so the user can check the rule before adding it. */
    const matches = useMemo(() => {
        if (!draft) return [];
        const comments = [
            ...(dashboard.prComments ?? []).map(item => ({ author: item.author, text: item.text })),
            ...dashboard.tasks.flatMap(source => (source.comments ?? []).map(item => ({ author: item.author, text: item.body })))
        ];
        return comments.filter(comment => matchesRule(draft, comment.author, comment.text));
    }, [dashboard, draft]);

    const addRule = async () => {
        if (!draft) return;
        const id = crypto.randomUUID();
        setError(undefined);
        try {
            await onSave({ dashboardHiddenRules: [...rules, { ...draft, id }] });
            // An app process from an older build drops settings that it does not know. Check that the rule is in the file.
            const saved = await window.shipwarden.settings.get();
            if (!saved.dashboardHiddenRules?.some(rule => rule.id === id)) {
                setError('ShipWarden did not save the rule. The app process is older than this window. Quit ShipWarden and open it again.');
                return;
            }
        } catch (err) {
            setError(errorText(err));
            return;
        }
        setAuthor('');
        setText('');
        setMatch('startsWith');
    };

    return (
        <>
            <SettingsGroup
                title="What the Dashboard shows"
                description={
                    <>
                        Pull requests that wait for your review, your pull requests that need an action, and new comments from the last {DASHBOARD_WINDOW_DAYS}{' '}
                        days on your pull requests and tasks. A comment stays new until you open it in ShipWarden. ShipWarden keeps this record on this computer
                        only.
                    </>
                }
            >
                {null}
            </SettingsGroup>

            <SettingsGroup
                title="Hiding rules"
                description="The Dashboard does not show a comment that matches a rule. A rule with an author applies only to that author. The text match ignores case."
                card
            >
                {rules.length === 0 && <SettingsRow label={<span className="panel-note">No rules.</span>} />}
                {rules.map(rule => (
                    <SettingsRow
                        key={rule.id}
                        label={
                            <span className="rule-summary">
                                <span className="rule-author">{rule.author ?? 'Any author'}</span>
                                <span className="rule-match">{MATCH_LABELS[rule.match].toLowerCase()}</span>
                                <code>{rule.text}</code>
                            </span>
                        }
                        control={
                            <IconButton
                                icon={<X size={14} strokeWidth={1.8} />}
                                label="Remove the rule"
                                size="sm"
                                onClick={() => save({ dashboardHiddenRules: rules.filter(other => other.id !== rule.id) })}
                            />
                        }
                    />
                ))}
                <SettingsRow label="New rule" description="Tip: the filter button on a Dashboard comment fills in this form from that comment.">
                    <div className="rule-form">
                        <Input
                            className="rule-field"
                            value={author}
                            placeholder="Author (optional)"
                            spellCheck={false}
                            onChange={event => setAuthor(event.target.value)}
                        />
                        <Select<HiddenCommentMatch>
                            className="rule-field"
                            value={match}
                            options={(Object.keys(MATCH_LABELS) as HiddenCommentMatch[]).map(value => ({ value, label: MATCH_LABELS[value] }))}
                            onChange={setMatch}
                        />
                        <Input
                            className="rule-field rule-text"
                            mono={match === 'regex'}
                            value={text}
                            placeholder={match === 'regex' ? '^Linked to ClickUp task: ENG-\\d+$' : 'Linked to ClickUp task:'}
                            spellCheck={false}
                            onChange={event => setText(event.target.value)}
                            onKeyDown={event => event.key === 'Enter' && void addRule()}
                        />
                        <Button variant="primary" className="rule-add" disabled={!draft} onClick={() => void addRule()}>
                            Add rule
                        </Button>
                    </div>
                    {error && <div className="form-error">{error}</div>}
                    {typeof regexError === 'string' && <div className="form-error">The regular expression is not valid: {regexError}</div>}
                    {draft && (
                        <div className="panel-note rule-preview">
                            {matches.length === 0
                                ? 'The rule hides no comment on the Dashboard now.'
                                : `The rule hides ${matches.length} comment${matches.length === 1 ? '' : 's'} on the Dashboard now, for example:`}
                            {matches.slice(0, 3).map((comment, index) => (
                                <div key={index} className="rule-example">
                                    <strong>{comment.author ?? 'unknown'}</strong> {firstLine(comment.text)}
                                </div>
                            ))}
                        </div>
                    )}
                </SettingsRow>
            </SettingsGroup>

            <SettingsGroup
                title="Hidden authors"
                description="The Dashboard does not show comments from these GitHub logins or task manager users, for example accounts of automations."
                card
            >
                {hidden.length === 0 && <SettingsRow label={<span className="panel-note">No hidden authors.</span>} />}
                {hidden.map(item => (
                    <SettingsRow
                        key={item}
                        label={item}
                        control={
                            <IconButton
                                icon={<X size={14} strokeWidth={1.8} />}
                                label={`Show comments from ${item} again`}
                                size="sm"
                                onClick={() => save({ dashboardHiddenAuthors: hidden.filter(other => other !== item) })}
                            />
                        }
                    />
                ))}
                <SettingsRow
                    label={
                        <Input
                            className="settings-text-field"
                            value={name}
                            placeholder="A GitHub login or a user name"
                            onChange={event => setName(event.target.value)}
                            onKeyDown={event => event.key === 'Enter' && addAuthor()}
                        />
                    }
                    control={
                        <Button disabled={!name.trim()} onClick={addAuthor}>
                            Hide
                        </Button>
                    }
                />
            </SettingsGroup>
        </>
    );
}
