import { useState } from 'react';
import { Camera } from 'lucide-react';
import type { PullRequest, SourceHostKind } from '@shared/github';
import { pluralize } from '@shared/format';
import { viewportWidthOf, type ScreenshotPage, type ScreenshotSettings, type ScreenshotShot, type ScreenshotSide } from '@shared/screenshots';
import { EmptyState } from '../components/EmptyState';
import { confirmDialog } from '../components/ConfirmDialog';
import { MediaDialog, type ZoomedMedia } from '../components/MediaDialog';
import { Age, Button, ButtonGroup, SkeletonRows } from '../components/ui';
import { radioGroupKeys } from '../components/keyboard';
import { invalidatePullRequest } from '../github/pull-request-cache';
import { queryClient } from '../query-client';
import { errorText } from '../util';
import { captureScreenshots, clearScreenshots, useCaptureProgress, useScreenshotImage, useScreenshots } from './screenshot-queries';

const api = window.shipwarden;

type ViewMode = 'both' | ScreenshotSide;

const VIEW_LABELS: Record<ViewMode, string> = { both: 'Side by side', base: 'Base', branch: 'Branch' };

interface Props {
    worktreePath: string;
    /** The screenshot settings of the repository. Undefined means that the repository has none. */
    settings: ScreenshotSettings | undefined;
    /** The pull request of the branch, for "Add to PR". */
    pullRequest: PullRequest | undefined;
    /** The kind of the review provider of the pull request. */
    hostKind: SourceHostKind | undefined;
    /** Opens the settings of the repository. */
    onOpenRepoSettings?(): void;
}

/** True when ShipWarden can add the images to a comment on the provider. Bitbucket Cloud has no upload API for comments. */
function hostCanPostImages(kind: SourceHostKind | undefined): boolean {
    return kind !== 'bitbucket';
}

/** Where the images go for each provider. The confirm dialog shows it. */
function uploadNote(kind: SourceHostKind | undefined): string {
    if (kind === 'azure') return 'The images become attachments of the pull request.';
    if (kind === 'gitlab') return 'The images go to the uploads of the GitLab project.';
    if (kind === 'gitea') return 'The images become attachments of the pull request.';
    return 'GitHub has no API for images in comments. ShipWarden commits the images to the branch "shipwarden-screenshots" of the repository. For a private repository, readers must be signed in to GitHub to see them.';
}

/** The image of one side of a page. A click opens the large view. */
function ShotImage({ worktree, side, page, shot }: { worktree: string; side: ScreenshotSide; page: string; shot: ScreenshotShot | undefined }) {
    const image = useScreenshotImage(worktree, side, page, shot && !shot.error ? shot.capturedAt : undefined);
    const [zoomed, setZoomed] = useState<ZoomedMedia | null>(null);
    const label = side === 'base' ? 'Base' : 'Branch';
    let body: React.ReactNode;
    if (!shot) body = <span className="screenshot-missing">Not captured</span>;
    else if (shot.error) body = <span className="screenshot-missing form-error">{shot.error}</span>;
    else if (image.isPending) body = <span className="screenshot-missing">Loading…</span>;
    else if (!image.data) body = <span className="screenshot-missing">The image file is missing.</span>;
    else {
        const src = image.data;
        body = (
            <button
                className="screenshot-image"
                title="Show the large view"
                onClick={event => {
                    const img = event.currentTarget.querySelector('img');
                    if (img) setZoomed({ kind: 'image', src, alt: `${label} ${page}`, origin: img, width: img.naturalWidth, height: img.naturalHeight });
                }}
            >
                <img src={src} alt={`${label} ${page}`} />
            </button>
        );
    }
    return (
        <figure className="screenshot-side">
            <figcaption>
                {label}
                {shot && !shot.error && <span className="mono"> {shot.sha.slice(0, 7)}</span>}
            </figcaption>
            {body}
            {zoomed && <MediaDialog media={zoomed} onClose={() => setZoomed(null)} />}
        </figure>
    );
}

function PageShots({ worktree, page, mode }: { worktree: string; page: ScreenshotPage; mode: ViewMode }) {
    return (
        <section className="processes-section">
            <div className="section-title">
                <span className="mono">{page.path}</span>
            </div>
            <div className={`screenshot-pair${mode === 'both' ? ' both' : ''}`}>
                {mode !== 'branch' && <ShotImage worktree={worktree} side="base" page={page.path} shot={page.base} />}
                {mode !== 'base' && <ShotImage worktree={worktree} side="branch" page={page.path} shot={page.branch} />}
            </div>
        </section>
    );
}

/** The newest capture of one side, for the step text. */
function latestShot(pages: ScreenshotPage[], side: ScreenshotSide): ScreenshotShot | undefined {
    return pages
        .map(page => page[side])
        .filter((shot): shot is ScreenshotShot => !!shot)
        .sort((a, b) => b.capturedAt - a.capturedAt)[0];
}

/**
 * The Screenshots tab of the right panel. The user runs the dev server, and ShipWarden captures the pages of the
 * repository settings in two steps: first the branch (dev server in this worktree), then the base (dev server in the
 * main worktree). The tab shows both images of each page. "Add to PR" uploads them in a comment.
 */
export function ScreenshotsPanel({ worktreePath, settings, pullRequest, hostKind, onOpenRepoSettings }: Props) {
    const query = useScreenshots(worktreePath);
    const progress = useCaptureProgress(worktreePath);
    const [busy, setBusy] = useState<ScreenshotSide | 'post' | 'clear'>();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [mode, setMode] = useState<ViewMode>('both');

    if (!settings) {
        return (
            <div className="processes-panel">
                <EmptyState
                    icon={Camera}
                    title="No screenshot settings"
                    size="compact"
                    actions={
                        onOpenRepoSettings && (
                            <Button size="lg" variant="primary" onClick={onOpenRepoSettings}>
                                Open settings
                            </Button>
                        )
                    }
                >
                    Add the preview URL and the pages to capture in the settings of this repository.
                </EmptyState>
            </div>
        );
    }
    if (query.isPending) {
        return (
            <div className="processes-panel">
                <SkeletonRows count={3} dot={false} label="Loading screenshots" />
            </div>
        );
    }

    const state = query.data;
    const set = state?.set ?? null;
    const pages = set?.pages ?? [];
    const imageCount = pages.reduce((count, page) => count + (page.base && !page.base.error ? 1 : 0) + (page.branch && !page.branch.error ? 1 : 0), 0);
    const widthChanged = set && set.viewportWidth !== viewportWidthOf(settings);

    const run = async (kind: NonNullable<typeof busy>, task: () => Promise<string | undefined>) => {
        setBusy(kind);
        setError(undefined);
        setNotice(undefined);
        try {
            setNotice(await task());
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(undefined);
        }
    };

    const capture = (side: ScreenshotSide) =>
        run(side, async () => {
            const next = await captureScreenshots(worktreePath, side);
            const failed = next.set?.pages.filter(page => page[side]?.error).length ?? 0;
            return failed > 0 ? `${pluralize(failed, 'page')} failed. The error shows at each page.` : undefined;
        });

    const post = (pr: PullRequest) =>
        run('post', async () => {
            const ok = await confirmDialog({
                title: `Add ${pluralize(imageCount, 'screenshot')} to #${pr.number}?`,
                message: `ShipWarden uploads the images and adds one comment to the pull request.\n\n${uploadNote(hostKind)}`,
                confirmLabel: 'Add to PR'
            });
            if (!ok) return undefined;
            await api.screenshots.post(worktreePath, pr.number);
            // The page cannot know the new comment, so only this pull request loads again.
            await invalidatePullRequest(queryClient, pr.url);
            return `Added the screenshots to #${pr.number}.`;
        });

    const clear = () =>
        run('clear', async () => {
            const ok = await confirmDialog({ title: 'Remove the screenshots of this branch?', confirmLabel: 'Remove', danger: true });
            if (ok) await clearScreenshots(worktreePath);
            return undefined;
        });

    const branchShot = latestShot(pages, 'branch');
    const baseShot = latestShot(pages, 'base');
    const step = (side: ScreenshotSide, text: React.ReactNode, shot: ScreenshotShot | undefined) => (
        <div className="screenshot-step">
            <div className="screenshot-step-text">
                {text}
                {shot && (
                    <div className="panel-note">
                        Captured <span className="mono">{shot.branch}</span> at <span className="mono">{shot.sha.slice(0, 7)}</span>{' '}
                        <Age date={new Date(shot.capturedAt).toISOString()} plain />
                    </div>
                )}
            </div>
            <Button size="sm" disabled={!!busy} onClick={() => void capture(side)}>
                {busy === side ? 'Capturing…' : side === 'branch' ? 'Capture branch' : 'Capture base'}
            </Button>
        </div>
    );

    return (
        <div className="processes-panel screenshots-panel">
            <div className="processes-header">
                <span className="processes-summary">
                    {pluralize(settings.pages.length, 'page')} · {viewportWidthOf(settings)} px
                </span>
                {set && (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void clear()}>
                        Clear
                    </Button>
                )}
            </div>
            <div className="screenshot-steps">
                {step(
                    'branch',
                    <>
                        <strong>1. Branch.</strong> Run the dev server in this worktree (<span className="mono">{state?.branch}</span>).
                    </>,
                    branchShot
                )}
                {step(
                    'base',
                    state?.isMain ? (
                        <>
                            <strong>2. Base.</strong> This is the main worktree. Check out the base branch here, run the dev server, and capture again.
                        </>
                    ) : (
                        <>
                            <strong>2. Base.</strong> Stop the dev server here. Run it in the main worktree (<span className="mono">{state?.baseBranch}</span>).
                        </>
                    ),
                    baseShot
                )}
                <p className="panel-note">
                    ShipWarden opens {settings.previewUrl}. It does not start or stop the dev server, and it cannot see which worktree the server uses.
                </p>
                {progress && (
                    <p className="panel-note" role="status">
                        Capturing page {progress.done + 1} of {progress.total}…
                    </p>
                )}
                {widthChanged && <p className="panel-note">The width in the settings changed. The next capture removes the images of the other side.</p>}
                {error && <div className="form-error">{error}</div>}
                {notice && <p className="panel-note">{notice}</p>}
            </div>
            {pages.length > 0 && (
                <>
                    <div className="screenshot-toolbar">
                        <ButtonGroup size="sm" role="radiogroup" label="Screenshot view" onKeyDown={radioGroupKeys}>
                            {(['both', 'base', 'branch'] as ViewMode[]).map(item => (
                                <Button key={item} size="sm" role="radio" aria-checked={mode === item} onClick={() => setMode(item)}>
                                    {VIEW_LABELS[item]}
                                </Button>
                            ))}
                        </ButtonGroup>
                        {pullRequest && imageCount > 0 && hostCanPostImages(hostKind) && (
                            <Button
                                size="sm"
                                disabled={!!busy}
                                onClick={() => void post(pullRequest)}
                                title={`Upload the images in a comment on #${pullRequest.number}`}
                            >
                                {busy === 'post' ? 'Adding…' : 'Add to PR'}
                            </Button>
                        )}
                    </div>
                    {pullRequest && imageCount > 0 && !hostCanPostImages(hostKind) && (
                        <p className="panel-note">
                            Bitbucket Cloud has no API that adds images to a pull request comment. Open the images here and add them to the pull request on
                            Bitbucket.
                        </p>
                    )}
                    {pages.map(page => (
                        <PageShots key={page.path} worktree={worktreePath} page={page} mode={mode} />
                    ))}
                </>
            )}
        </div>
    );
}
