import type { ReactNode } from 'react';
import { CircleHelp, OctagonAlert, Shapes, Sparkle, Tag, TriangleAlert } from 'lucide-react';
import { COMMENT_CATEGORIES, COMMENT_CATEGORY_TEXT, type CommentCategory } from '@shared/comment-category';
import { Chip, Select, type ChipTone, type SelectOption } from './ui';

/** The chip tone of each category. The tone shows how important the comment is. */
const TONES: Record<CommentCategory, ChipTone> = {
    'must-fix': 'danger',
    concern: 'warning',
    pattern: 'info',
    nit: 'neutral',
    question: 'review'
};

/** Returns the icon of a category, in the color of its tone. */
function categoryIcon(category: CommentCategory, size: number): ReactNode {
    const props = { size, strokeWidth: 1.8, className: `comment-category-icon tone-${TONES[category]}` };
    switch (category) {
        case 'must-fix':
            return <OctagonAlert {...props} />;
        case 'concern':
            return <TriangleAlert {...props} />;
        case 'pattern':
            return <Shapes {...props} />;
        case 'nit':
            return <Sparkle {...props} />;
        case 'question':
            return <CircleHelp {...props} />;
    }
}

/** A colored chip with the icon and the name of a comment category. */
export function CommentCategoryChip({ category }: { category: CommentCategory }) {
    const text = COMMENT_CATEGORY_TEXT[category];
    return (
        <Chip tone={TONES[category]} icon={categoryIcon(category, 12)} title={text.description} className="comment-category">
            {text.label}
        </Chip>
    );
}

/** The value of the "No category" option. */
const NONE = 'none';

const OPTIONS: SelectOption[] = [
    { value: NONE, label: 'No category', icon: <Tag size={13} strokeWidth={1.6} className="comment-category-icon" /> },
    ...COMMENT_CATEGORIES.map(category => ({ value: category, label: COMMENT_CATEGORY_TEXT[category].label, icon: categoryIcon(category, 13) }))
];

/** A select for the category of a review comment. The category goes into the comment as a prefix. */
export function CommentCategorySelect({ value, onChange }: { value: CommentCategory | undefined; onChange(value: CommentCategory | undefined): void }) {
    return (
        // Monaco must not handle the keys of the select. The wrapper stops them.
        <span className="composer-target-keys" onKeyDown={event => event.stopPropagation()}>
            <Select
                size="sm"
                className="comment-category-select"
                aria-label="Comment category"
                title="The category of the comment. It shows how important the comment is."
                value={value ?? NONE}
                options={OPTIONS}
                onChange={next => onChange(next === NONE ? undefined : (next as CommentCategory))}
            />
        </span>
    );
}
