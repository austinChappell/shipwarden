/** An input of a workflow that the user starts by hand (`on.workflow_dispatch.inputs`). */
export interface WorkflowInput {
    name: string;
    description?: string;
    required: boolean;
    /** "string", "boolean", "choice", "number" or "environment". Other types show as text. */
    type: string;
    default?: string;
    /** The choices of a "choice" input. */
    options?: string[];
}

/** A workflow run of GitHub Actions, for the runs list of the Pipelines view. */
export interface WorkflowRun {
    id: number;
    /** The title of the run, for example the commit message or the pull request title. */
    title: string;
    workflowId: number;
    workflowName: string;
    runNumber: number;
    branch: string | null;
    event: string;
    status: string;
    conclusion: string | null;
    actor: string | null;
    createdAt: string;
    updatedAt: string;
    /** When the run started its latest attempt. */
    startedAt: string | null;
    url: string;
    headSha: string;
}

/** True while a run waits or runs, so the view refreshes it more often. */
export function runIsActive(run: Pick<WorkflowRun, 'status'>): boolean {
    return run.status !== 'completed';
}

/**
 * Returns the values to send to GitHub for a dispatch: the values of the form, else the defaults.
 * Returns an error message when a required input has no value.
 */
export function dispatchInputs(inputs: WorkflowInput[], values: Record<string, string>): { inputs: Record<string, string> } | { error: string } {
    const result: Record<string, string> = {};
    for (const input of inputs) {
        const value = values[input.name] ?? input.default ?? '';
        if (input.required && value.trim() === '' && input.type !== 'boolean') {
            return { error: `The input "${input.name}" needs a value.` };
        }
        if (value !== '' || input.type === 'boolean') {
            result[input.name] = input.type === 'boolean' ? String(value === 'true') : value;
        }
    }
    return { inputs: result };
}
