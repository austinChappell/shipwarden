import { useMutation } from '@tanstack/react-query';
import type { PipelineApprovalItem } from '@shared/dashboard';
import { applyApprovedToDashboard } from '../dashboard-store';
import { confirmDialog } from '../components/ConfirmDialog';

/**
 * Approves a pipeline run that waits for the user. The Dashboard and the Pipelines view use it.
 * `approve` asks the user to confirm first. After the approval, the run leaves the cached Dashboard data.
 */
export function useApprovePipeline() {
    const mutation = useMutation({
        mutationFn: (item: PipelineApprovalItem) => window.shipwarden.github.approvePipeline(item.target),
        onSuccess: (_data, item) => applyApprovedToDashboard(item.id)
    });

    const approve = async (item: PipelineApprovalItem): Promise<void> => {
        const where = item.environments.length
            ? `The run continues to ${new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(item.environments)}.`
            : 'The run continues to the next stage.';
        const ok = await confirmDialog({
            title: `Approve "${item.title}"?`,
            message: [`${item.sourceTitle} · ${item.workflow}${item.branch ? ` · ${item.branch}` : ''}`, where].join('\n\n'),
            confirmLabel: 'Approve'
        });
        if (ok) mutation.mutate(item);
    };

    return {
        approve,
        /** The ID of the item that is approving now. */
        approvingId: mutation.isPending ? mutation.variables?.id : undefined,
        error: mutation.error,
        /** The item of the last approval, for the error text. */
        last: mutation.variables,
        reset: mutation.reset
    };
}
