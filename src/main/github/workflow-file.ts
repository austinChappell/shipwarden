import { load } from 'js-yaml';
import type { WorkflowInput } from '@shared/pipelines';
import type { WorkflowJobSpec } from '@shared/workflow-graph';

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

/**
 * Reads the jobs of a workflow file, with their names and needs. Returns null when the file is not valid YAML or has
 * no jobs.
 */
export function parseWorkflowJobs(text: string): WorkflowJobSpec[] | null {
    let document: unknown;
    try {
        document = load(text);
    } catch {
        return null;
    }
    const jobs = (document as { jobs?: unknown } | null)?.jobs;
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null;
    const specs = Object.entries(jobs as Record<string, unknown>).map(([id, value]): WorkflowJobSpec => {
        const job = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const needs = typeof job.needs === 'string' ? [job.needs] : Array.isArray(job.needs) ? job.needs.map(String) : [];
        const strategy = job.strategy && typeof job.strategy === 'object' ? (job.strategy as Record<string, unknown>) : undefined;
        const name = typeof job.name === 'string' || typeof job.name === 'number' ? String(job.name) : undefined;
        return {
            id,
            ...(name ? { name } : {}),
            needs,
            matrix: !!strategy?.matrix,
            reusable: typeof job.uses === 'string'
        };
    });
    return specs.length > 0 ? specs : null;
}
