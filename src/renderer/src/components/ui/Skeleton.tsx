/** The widths of the title bars of the skeleton rows. They change from row to row, so the rows look like real rows. */
const TITLE_WIDTHS = ['46%', '38%', '52%', '34%', '44%', '40%'];

interface SkeletonRowsProps {
    /** The number of rows. */
    count?: number;
    /** Shows a dot at the start of each row, for a list with a status dot. */
    dot?: boolean;
    /** The name of the list for a screen reader, for example "Loading runs". */
    label: string;
}

/**
 * Rows that show while a list loads (docs/design, board 4). They have the height (44 px) and the shape of real rows.
 * Use them in place of a "Loading…" text.
 */
export function SkeletonRows({ count = 6, dot = true, label }: SkeletonRowsProps) {
    return (
        <div className="skeleton-rows" role="status" aria-label={label}>
            {Array.from({ length: count }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: The rows have no identity. Their number does not change.
                <div key={index} className="skeleton-row" aria-hidden="true">
                    {dot && <span className="skeleton-dot" />}
                    <span className="skeleton-bar" style={{ width: TITLE_WIDTHS[index % TITLE_WIDTHS.length] }} />
                    <span className="skeleton-space" />
                    <span className="skeleton-bar" style={{ width: 72 }} />
                    <span className="skeleton-bar" style={{ width: 28 }} />
                </div>
            ))}
        </div>
    );
}
