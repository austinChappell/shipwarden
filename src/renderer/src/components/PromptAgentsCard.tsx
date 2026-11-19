import { useState } from 'react';
import { Bot } from 'lucide-react';
import { MAX_BATCH_PROMPT } from '@shared/batch-prompt';
import { pluralize } from '@shared/format';
import type { BatchSendResult } from '../github/pr-group-agents';
import { errorText } from '../util';
import { Button, Card, CardBody, CardHeader, Checkbox, TextArea } from './ui';

/** A pull request that can get the prompt. */
export interface PromptTarget {
    key: string;
    /** For example "octo/api #12". */
    label: string;
    title: string;
    /** Why the pull request cannot get a prompt now. A disabled target is not selected. */
    disabledReason?: string;
}

interface Props {
    targets: readonly PromptTarget[];
    description: string;
    /** Sends the prompt to the agents of the selected targets. Returns a result for each target. */
    onSend(keys: string[], prompt: string, push: boolean): Promise<BatchSendResult[]>;
}

/**
 * One prompt for the agents of more than one pull request. The user selects the pull requests, writes the prompt, and
 * selects "Send". The agent in the worktree of each selected pull request gets the prompt.
 */
export function PromptAgentsCard({ targets, description, onSend }: Props) {
    const enabled = targets.filter(target => !target.disabledReason);
    const [unselected, setUnselected] = useState<ReadonlySet<string>>(new Set());
    const [prompt, setPrompt] = useState('');
    const [push, setPush] = useState(true);
    const [sending, setSending] = useState(false);
    const [results, setResults] = useState<Record<string, string | undefined>>();
    const [error, setError] = useState<string>();

    const selected = enabled.filter(target => !unselected.has(target.key)).map(target => target.key);
    const all = selected.length === enabled.length && enabled.length > 0;
    const toggle = (key: string, on: boolean) =>
        setUnselected(current => {
            const next = new Set(current);
            if (on) next.delete(key);
            else next.add(key);
            return next;
        });

    const send = async () => {
        setSending(true);
        setError(undefined);
        setResults(undefined);
        try {
            const list = await onSend(selected, prompt, push);
            setResults(Object.fromEntries(list.map(item => [item.key, item.error ?? ''])));
            if (list.every(item => !item.error)) setPrompt('');
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSending(false);
        }
    };

    const failed = results ? Object.values(results).filter(Boolean).length : 0;
    const ok = results ? Object.keys(results).length - failed : 0;

    return (
        <Card as="section" className="prompt-agents">
            <CardHeader
                title="Prompt the agents"
                description={description}
                actions={
                    enabled.length > 1 && (
                        <Checkbox
                            checked={all}
                            indeterminate={!all && selected.length > 0}
                            label="All"
                            onChange={on => setUnselected(on ? new Set() : new Set(enabled.map(target => target.key)))}
                        />
                    )
                }
            />
            <CardBody className="prompt-agents-body">
                {targets.length === 0 ? (
                    <div className="flow-field-note">No pull request has a worktree yet.</div>
                ) : (
                    <ul className="prompt-agents-list">
                        {targets.map(target => {
                            const result = results?.[target.key];
                            return (
                                <li key={target.key}>
                                    <Checkbox
                                        checked={!target.disabledReason && !unselected.has(target.key)}
                                        disabled={!!target.disabledReason || sending}
                                        title={target.disabledReason}
                                        onChange={on => toggle(target.key, on)}
                                        label={
                                            <>
                                                <span className="prompt-agents-name">{target.label}</span> {target.title}
                                            </>
                                        }
                                        description={
                                            result === undefined ? (
                                                target.disabledReason
                                            ) : result ? (
                                                <span className="prompt-agents-error">{result}</span>
                                            ) : (
                                                'Sent'
                                            )
                                        }
                                    />
                                </li>
                            );
                        })}
                    </ul>
                )}
                <TextArea
                    rows={4}
                    value={prompt}
                    maxLength={MAX_BATCH_PROMPT}
                    placeholder="For example: Rename the field id to userId."
                    aria-label="Prompt for the agents"
                    disabled={sending}
                    onChange={event => setPrompt(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && prompt.trim() && selected.length > 0 && !sending) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                />
                {error && <div className="form-error">{error}</div>}
                {results && !error && (
                    <div className="flow-field-note" role="status">
                        {failed === 0 ? `${pluralize(ok, 'agent')} got the prompt.` : `${pluralize(ok, 'agent')} got the prompt. ${failed} failed.`}
                    </div>
                )}
                <div className="prompt-agents-tools">
                    <Checkbox
                        checked={push}
                        onChange={setPush}
                        label="Commit and push"
                        title="The agents commit their changes and push the branch, so that the pull requests get the changes."
                    />
                    <Button
                        variant="primary"
                        icon={<Bot size={14} />}
                        disabled={sending || !prompt.trim() || selected.length === 0}
                        title="Send the prompt (⌘ Enter)"
                        onClick={() => void send()}
                    >
                        {sending ? 'Sending…' : selected.length > 1 ? `Send to ${selected.length} agents` : 'Send'}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
