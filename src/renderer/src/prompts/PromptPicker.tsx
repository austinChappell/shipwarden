import { useMemo } from 'react';
import type { ComboboxGroup } from '../components/ui';
import { Combobox } from '../components/ui';
import { showToast } from '../components/Toast';
import { errorText } from '../util';
import { usePromptTemplates } from './prompt-queries';
import { manageTemplates, runPromptTemplate } from './prompt-runner';

/** The value of the item that opens Settings › Prompt templates. A template ID cannot start with a colon. */
const MANAGE = ':manage';

/**
 * The list of the prompt templates on an agent terminal. A click on a template inserts it into this terminal. The
 * search field finds a template by its name.
 */
export function PromptPicker({ sessionId }: { sessionId: string }) {
    const { list } = usePromptTemplates();
    const groups = useMemo<ComboboxGroup[]>(
        () => [
            {
                label: '',
                items: list.templates.map(template => ({
                    value: template.id,
                    label: template.shortcut ? `${template.name} (${template.shortcut})` : template.name
                }))
            },
            { label: 'Settings', items: [{ value: MANAGE, label: list.templates.length ? 'Edit the templates…' : 'Add a template…' }] }
        ],
        [list.templates]
    );
    const choose = (value: string) => {
        if (value === MANAGE) {
            manageTemplates();
            return;
        }
        const template = list.templates.find(item => item.id === value);
        if (!template) return;
        runPromptTemplate(template, sessionId).catch(error => showToast('ShipWarden did not insert the template', errorText(error)));
    };
    return (
        <Combobox
            className="prompt-picker"
            size="sm"
            value={undefined}
            groups={groups}
            onChange={choose}
            placeholder="Prompts"
            searchPlaceholder="Find a template"
            title="Insert a prompt template into this agent"
            aria-label="Insert a prompt template"
        />
    );
}
