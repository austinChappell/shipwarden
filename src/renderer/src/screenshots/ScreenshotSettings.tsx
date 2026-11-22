import { useEffect, useState } from 'react';
import {
    DEFAULT_VIEWPORT_WIDTH,
    screenshotSettingsInput,
    validateScreenshotSettings,
    type ScreenshotSettings,
    type ScreenshotSettingsInput
} from '@shared/screenshots';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { Button, Input, TextArea } from '../components/ui';

interface Props {
    current: ScreenshotSettings | undefined;
    onChange(value: ScreenshotSettings | undefined): Promise<void> | void;
}

/** The screenshot settings of one repository: the preview URL, the pages, the wait, and the width. */
export function RepoScreenshotGroup({ current, onChange }: Props) {
    const [form, setForm] = useState<ScreenshotSettingsInput>(() => screenshotSettingsInput(current));
    const [errors, setErrors] = useState<string[]>([]);
    useEffect(() => {
        setForm(screenshotSettingsInput(current));
        setErrors([]);
    }, [current]);

    const saved = screenshotSettingsInput(current);
    const changed = (Object.keys(form) as (keyof ScreenshotSettingsInput)[]).some(key => form[key] !== saved[key]);
    const set = (key: keyof ScreenshotSettingsInput) => (event: { target: { value: string } }) => setForm(value => ({ ...value, [key]: event.target.value }));

    const save = () => {
        const result = validateScreenshotSettings(form);
        setErrors(result.errors);
        if (result.errors.length === 0) void onChange(result.settings);
    };

    return (
        <SettingsGroup
            title="Screenshots"
            description="The pages that the Screenshots tab captures for the branch and for the base. You run the dev server. ShipWarden never starts or stops it."
            card
        >
            <SettingsRow label="Preview URL" description="The address of the dev server.">
                <Input
                    className="settings-text-field"
                    aria-label="Preview URL"
                    value={form.previewUrl}
                    placeholder="http://localhost:3000"
                    onChange={set('previewUrl')}
                />
            </SettingsRow>
            <SettingsRow label="Pages" description="One path on each line, for example / or /settings.">
                <TextArea
                    className="script-field"
                    mono
                    aria-label="Pages"
                    value={form.pages}
                    placeholder={'/\n/settings'}
                    spellCheck={false}
                    onChange={set('pages')}
                />
            </SettingsRow>
            <SettingsRow
                label="Wait"
                description="Before each capture: a number of milliseconds, or a CSS selector that must show (at most 15 seconds). Empty means no wait."
            >
                <Input className="settings-text-field" mono aria-label="Wait" value={form.wait} placeholder="500 or #app" onChange={set('wait')} />
            </SettingsRow>
            <SettingsRow
                label="Width"
                description="The page width in CSS pixels."
                control={
                    <Input
                        className="screenshot-short-field"
                        aria-label="Width"
                        inputMode="numeric"
                        value={form.viewportWidth}
                        placeholder={String(DEFAULT_VIEWPORT_WIDTH)}
                        onChange={set('viewportWidth')}
                    />
                }
            />
            {errors.length > 0 && (
                <SettingsRow
                    label={
                        <span className="form-error">
                            {errors.map(error => (
                                <span key={error} className="screenshot-error">
                                    {error}
                                </span>
                            ))}
                        </span>
                    }
                />
            )}
            <div className="settings-row screenshot-settings-actions">
                <Button disabled={!changed} onClick={() => setForm(saved)}>
                    Cancel
                </Button>
                <Button variant="primary" disabled={!changed} onClick={save}>
                    Save
                </Button>
            </div>
        </SettingsGroup>
    );
}
