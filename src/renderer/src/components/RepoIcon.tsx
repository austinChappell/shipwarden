import type { CSSProperties } from 'react';
import { FolderGit2 } from 'lucide-react';
import { REPO_COLORS, type RepoColor } from '@shared/settings';

interface Props {
    /** The color of the repository. Without a color, the icon uses the text color. */
    color?: RepoColor;
    size?: number;
    strokeWidth?: number;
}

/**
 * The repository icon in the color of the repository.
 * ShipWarden uses an icon, not a dot, so that the color does not look like an agent status.
 */
export function RepoIcon({ color, size = 14, strokeWidth = 1.8 }: Props) {
    return <FolderGit2 className="repo-icon" size={size} strokeWidth={strokeWidth} style={color ? { color: REPO_COLORS[color] } : undefined} aria-hidden />;
}

/** The CSS variable that gives the repository color to the left line of a sidebar group. */
export function repoColorStyle(color: RepoColor | undefined): CSSProperties | undefined {
    return color ? ({ '--repo-color': REPO_COLORS[color] } as CSSProperties) : undefined;
}
