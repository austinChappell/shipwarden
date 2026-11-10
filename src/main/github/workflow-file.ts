import { load } from 'js-yaml';
import type { WorkflowInput } from '@shared/pipelines';

/**
 * Reads a workflow file. `dispatchable` is true when it has a `workflow_dispatch` trigger, and `inputs` are the
 * inputs of that trigger. A file that is not valid YAML returns no trigger.
 */
export function parseWorkflowFile(text: string): { dispatchable: boolean; inputs: WorkflowInput[] } {
    let document: unknown;
    try {
        document = load(text);
    } catch {
        return { dispatchable: false, inputs: [] };
    }
    const on = (document as { on?: unknown } | null)?.on;
    if (on === 'workflow_dispatch') return { dispatchable: true, inputs: [] };
    if (Array.isArray(on)) return { dispatchable: on.includes('workflow_dispatch'), inputs: [] };
    if (!on || typeof on !== 'object' || !('workflow_dispatch' in on)) return { dispatchable: false, inputs: [] };
    const trigger = (on as Record<string, unknown>).workflow_dispatch as { inputs?: unknown } | null;
    const raw = trigger && typeof trigger.inputs === 'object' && trigger.inputs ? (trigger.inputs as Record<string, unknown>) : {};
    const inputs = Object.entries(raw).map(([name, value]): WorkflowInput => {
        const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const type = typeof item.type === 'string' ? item.type : 'string';
        return {
            name,
            ...(typeof item.description === 'string' ? { description: item.description } : {}),
            required: item.required === true,
            type,
            ...(item.default !== undefined && item.default !== null ? { default: String(item.default) } : {}),
            ...(Array.isArray(item.options) ? { options: item.options.map(String) } : {})
        };
    });
    return { dispatchable: true, inputs };
}
