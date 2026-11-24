import { useState } from 'react';
import { FolderOpen, MessageSquareText, Plus } from 'lucide-react';
import { normalizePromptTemplate, promptTemplateId, promptVariables, shortcutConflict, STARTER_PROMPTS, type PromptTemplate } from '@shared/prompt-templates';
import type { TextKeybind } from '@shared/terminal';
import { confirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { Button, Checkbox, Field, Input, TextArea } from '../components/ui';
import { KeyField } from '../keyboard/KeyField';
import { errorText } from '../util';
import { removePromptTemplate, savePromptTemplate, usePromptTemplates } from './prompt-queries';

const api = window.shipwarden.prompts;

/** The template that the form edits. `previousId` is the ID of a saved template, or undefined for a new one. */
interface Draft {
    previousId?: string;
    name: string;
    prompt: string;
    shortcut?: string;
    send: boolean;
}

const EMPTY_DRAFT: Draft = { name: '', prompt: '', send: false };

/**
 * Settings › Prompt templates: the list of the templates, and a form to add, change, and delete them. Each template is
 * a file in ~/.shipwarden/prompts, so the user can also change the files in a text editor.
 */
export function PromptTemplatesSettings({ terminalKeybinds }: { terminalKeybinds: readonly TextKeybind[] }) {
    const { list, loaded } = usePromptTemplates();
    const [draft, setDraft] = useState<Draft>();
    const [error, setError] = useState<string>();
    const templates = list.templates;

    const edit = (template: PromptTemplate) => {
        setError(undefined);
        setDraft({ previousId: template.id, name: template.name, prompt: template.prompt, shortcut: template.shortcut, send: template.send === true });
    };
    const remove = async (template: PromptTemplate) => {
        const ok = await confirmDialog({
            title: `Delete "${template.name}"?`,
            message: 'ShipWarden moves the file of the template to the Trash.',
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;
        await removePromptTemplate(template.id).catch(reason => setError(errorText(reason)));
        if (draft?.previousId === template.id) setDraft(undefined);
    };
    const addStarters = async () => {
        setError(undefined);
        try {
            const taken = templates.map(template => template.id);
            for (const starter of STARTER_PROMPTS) {
                const id = taken.includes(starter.id) ? promptTemplateId(starter.name, taken) : starter.id;
                taken.push(id);
                await savePromptTemplate({ ...starter, id });
            }
        } catch (reason) {
            setError(errorText(reason));
        }
    };

    return (
        <>
            <SettingsGroup
                title="Prompt templates"
                description={
                    <>
                        Saved prompts with variables, for example "Write tests for {'{{file}}'}". Each template is a JSON file in{' '}
                        <code>~/.shipwarden/prompts</code>, so you can share it.
                    </>
                }
                actions={
                    <>
                        <Button size="sm" icon={<FolderOpen size={13} strokeWidth={1.8} />} onClick={() => api.reveal()}>
                            Show in Finder
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            icon={<Plus size={13} strokeWidth={1.8} />}
                            disabled={draft !== undefined && draft.previousId === undefined}
                            onClick={() => {
                                setError(undefined);
                                setDraft(EMPTY_DRAFT);
                            }}
                        >
                            New template
                        </Button>
                    </>
                }
                card
            >
                {draft && draft.previousId === undefined && (
                    <TemplateForm draft={draft} templates={templates} terminalKeybinds={terminalKeybinds} onClose={() => setDraft(undefined)} />
                )}
                {templates.map(template =>
                    draft?.previousId === template.id ? (
                        <TemplateForm
                            key={template.id}
                            draft={draft}
                            templates={templates}
                            terminalKeybinds={terminalKeybinds}
                            onClose={() => setDraft(undefined)}
                        />
                    ) : (
                        <SettingsRow
                            key={template.id}
                            label={template.shortcut ? `${template.name} (${template.shortcut})` : template.name}
                            description={
                                <>
                                    <span className="prompt-template-text">{template.prompt}</span>
                                    <TemplateKeyWarning template={template} templates={templates} terminalKeybinds={terminalKeybinds} />
                                </>
                            }
                            control={
                                <div className="prompt-template-actions">
                                    <Button size="sm" onClick={() => edit(template)}>
                                        Edit
                                    </Button>
                                    <Button size="sm" variant="danger" onClick={() => void remove(template)}>
                                        Delete
                                    </Button>
                                </div>
                            }
                        />
                    )
                )}
                {loaded && templates.length === 0 && !draft && (
                    <EmptyState
                        icon={MessageSquareText}
                        title="No templates"
                        size="compact"
                        actions={
                            <Button size="sm" onClick={() => void addStarters()}>
                                Add starter templates
                            </Button>
                        }
                    >
                        Insert a template from the Prompts list of an agent terminal, from the command palette, or with its shortcut.
                    </EmptyState>
                )}
                {error && (
                    <div className="settings-row">
                        <div className="form-error">{error}</div>
                    </div>
                )}
            </SettingsGroup>
            {list.problems.length > 0 && (
                <SettingsGroup title="Files with problems" description="ShipWarden could not read these files. Correct them in a text editor." card>
                    {list.problems.map(problem => (
                        <SettingsRow key={problem.file} label={problem.file} description={problem.error} />
                    ))}
                </SettingsGroup>
            )}
        </>
    );
}

interface FormProps {
    draft: Draft;
    templates: readonly PromptTemplate[];
    terminalKeybinds: readonly TextKeybind[];
    onClose(): void;
}

/** The form of one template. Save writes the file. */
function TemplateForm({ draft: initial, templates, terminalKeybinds, onClose }: FormProps) {
    const [draft, setDraft] = useState(initial);
    const [error, setError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const conflict = draft.shortcut ? shortcutConflict(draft.shortcut, templates, draft.previousId, terminalKeybinds) : undefined;
    const variables = promptVariables();

    const save = async () => {
        if (conflict) return;
        setSaving(true);
        setError(undefined);
        try {
            const taken = templates.map(template => template.id).filter(id => id !== draft.previousId);
            const id = draft.previousId ?? promptTemplateId(draft.name, taken);
            const template = normalizePromptTemplate({ id, name: draft.name, prompt: draft.prompt, shortcut: draft.shortcut, send: draft.send });
            await savePromptTemplate(template, draft.previousId);
            onClose();
        } catch (reason) {
            setError(errorText(reason));
        } finally {
            setSaving(false);
        }
    };

    return (
        <form
            className="settings-row prompt-template-form"
            onSubmit={event => {
                event.preventDefault();
                void save();
            }}
        >
            <Field label="Name" htmlFor="prompt-template-name">
                <Input
                    id="prompt-template-name"
                    autoFocus
                    value={draft.name}
                    placeholder="Write tests"
                    onChange={event => setDraft({ ...draft, name: event.target.value })}
                />
            </Field>
            <Field
                label="Prompt"
                htmlFor="prompt-template-prompt"
                hint={
                    <>
                        ShipWarden fills these variables from the worktree of the agent:{' '}
                        {variables.map((variable, index) => (
                            <span key={variable.name} title={variable.description}>
                                <code>{`{{${variable.name}}}`}</code>
                                {index < variables.length - 1 ? ', ' : ''}
                            </span>
                        ))}
                        . Other variables, for example <code>{'{{focus}}'}</code>, and variables without a value get a field before the insert.
                    </>
                }
            >
                <TextArea
                    id="prompt-template-prompt"
                    mono
                    rows={5}
                    value={draft.prompt}
                    placeholder="Write tests for {{file}}."
                    onChange={event => setDraft({ ...draft, prompt: event.target.value })}
                />
            </Field>
            <Field
                label="Shortcut"
                htmlFor="prompt-template-shortcut"
                error={conflict}
                hint="Click the field and press the keys, for example ⌃⌥T. The shortcut inserts the template into the agent on the screen."
            >
                <KeyField id="prompt-template-shortcut" value={draft.shortcut} invalid={!!conflict} onChange={shortcut => setDraft({ ...draft, shortcut })} />
            </Field>
            <Checkbox
                checked={draft.send}
                onChange={send => setDraft({ ...draft, send })}
                label="Send at once"
                description="Press Enter after the insert. Without this option, you can edit the prompt in the terminal first."
            />
            {error && <div className="form-error">{error}</div>}
            <div className="prompt-template-form-buttons">
                <Button onClick={onClose} disabled={saving}>
                    Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={saving || !!conflict || !draft.name.trim() || !draft.prompt.trim()}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </form>
    );
}

/**
 * Shows a warning when the shortcut of a saved template is now a key of ShipWarden, of macOS, or of the terminal. A
 * new version of ShipWarden can take a key that a template uses. The template then does not get the key.
 */
function TemplateKeyWarning({
    template,
    templates,
    terminalKeybinds
}: {
    template: PromptTemplate;
    templates: readonly PromptTemplate[];
    terminalKeybinds: readonly TextKeybind[];
}) {
    const conflict = template.shortcut ? shortcutConflict(template.shortcut, templates, template.id, terminalKeybinds) : undefined;
    if (!conflict) return null;
    return <div className="form-error">{conflict} Select a different shortcut.</div>;
}
