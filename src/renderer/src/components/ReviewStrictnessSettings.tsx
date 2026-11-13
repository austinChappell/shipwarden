import { isReviewStrictness, REVIEW_STRICTNESS_LEVELS, REVIEW_STRICTNESS_TEXT, type ReviewStrictness } from '@shared/review-strictness';
import type { AppSettings } from '@shared/settings';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Select } from './ui';

const LEVEL_OPTIONS = REVIEW_STRICTNESS_LEVELS.map(level => ({ value: level, label: REVIEW_STRICTNESS_TEXT[level].label }));

/** The global default strictness of an agent review. */
export function ReviewStrictnessGroup({ settings, onSave }: { settings: AppSettings; onSave(change: Partial<AppSettings>): Promise<void> }) {
    return (
        <SettingsGroup
            title="Agent reviews"
            description="How many comments the agent writes when it reviews a pull request. A repository can have its own default in its repository settings. The arrow of the review button selects a different level for one review."
            card
        >
            <SettingsRow
                label="Default strictness"
                description={REVIEW_STRICTNESS_TEXT[settings.reviewStrictness].description}
                control={
                    <Select<ReviewStrictness>
                        value={settings.reviewStrictness}
                        aria-label="Default strictness"
                        options={LEVEL_OPTIONS}
                        onChange={reviewStrictness => void onSave({ reviewStrictness })}
                    />
                }
            />
        </SettingsGroup>
    );
}

/** The default strictness of an agent review of one repository. "Global" uses the global setting. */
export function RepoReviewStrictnessGroup({
    settings,
    current,
    onChange
}: {
    settings: AppSettings;
    current: ReviewStrictness | undefined;
    onChange(value: ReviewStrictness | undefined): void;
}) {
    return (
        <SettingsGroup
            title="Agent reviews"
            description="How many comments the agent writes when it reviews a pull request of this repository. ShipWarden finds the repository from the remote of its clone."
            card
        >
            <SettingsRow
                label="Default strictness"
                description={REVIEW_STRICTNESS_TEXT[current ?? settings.reviewStrictness].description}
                control={
                    <Select<ReviewStrictness | ''>
                        value={current ?? ''}
                        aria-label="Default strictness"
                        options={[{ value: '', label: `Global (${REVIEW_STRICTNESS_TEXT[settings.reviewStrictness].label})` }, ...LEVEL_OPTIONS]}
                        onChange={value => onChange(isReviewStrictness(value) ? value : undefined)}
                    />
                }
            />
        </SettingsGroup>
    );
}
