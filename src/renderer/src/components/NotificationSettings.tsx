import { useState } from 'react';
import { Volume2 } from 'lucide-react';
import { NOTIFICATION_EVENTS, NOTIFICATION_SOUNDS, type NotificationEvent, type NotificationSettings as NotificationSettingsValue } from '@shared/notifications';
import type { AppSettings } from '@shared/settings';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

function Switch({ checked, title, disabled, onChange }: { checked: boolean; title: string; disabled?: boolean; onChange(value: boolean): void }) {
    return (
        <label className="switch" title={title}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
            <span />
        </label>
    );
}

/** The notification settings: on or off, while ShipWarden is active or not, and a switch and a sound for each event. */
export function NotificationSettings({ settings, onSave }: Props) {
    const value = settings.notifications;
    const [error, setError] = useState<string>();
    const [tested, setTested] = useState(false);

    const save = async (change: Partial<NotificationSettingsValue>) => {
        setError(undefined);
        try {
            await onSave({ notifications: { ...value, ...change } });
        } catch (err) {
            setError(errorText(err));
        }
    };
    const saveEvent = (event: NotificationEvent, change: Partial<NotificationSettingsValue['events'][NotificationEvent]>) =>
        save({ events: { ...value.events, [event]: { ...value.events[event], ...change } } });

    const test = () => {
        const sound = value.events.agentWaiting.sound;
        window.shipwarden.notifications.show({
            title: 'ShipWarden',
            body: sound ? `A test notification with the sound "${sound}".` : 'A test notification.',
            sound,
            target: { view: 'dashboard' }
        });
        setTested(true);
    };

    return (
        <>
            <SettingsGroup
                title="Notifications"
                description="macOS notifications for the events below. A click on a notification opens the agent, the worktree or the Dashboard."
                card
            >
                <SettingsRow
                    label="Notifications"
                    description="Turns all notifications of ShipWarden on or off."
                    control={<Switch checked={value.enabled} title={value.enabled ? 'On' : 'Off'} onChange={enabled => void save({ enabled })} />}
                />
                <SettingsRow
                    label="Also when ShipWarden is active"
                    description="Off: no notification while ShipWarden is the active app. An agent that you look at never sends one."
                    control={<Switch checked={value.whenFocused} disabled={!value.enabled} title={value.whenFocused ? 'On' : 'Off'} onChange={whenFocused => void save({ whenFocused })} />}
                />
                <SettingsRow
                    label="Test"
                    description="Sends a notification with the sound of “Agent needs input”. If nothing shows, allow notifications for ShipWarden in System Settings › Notifications."
                    control={<button className="button" disabled={!value.enabled} onClick={test}>{tested ? 'Send again' : 'Send a test'}</button>}
                />
            </SettingsGroup>

            <SettingsGroup title="Events and sounds" description="Each event has its own switch and sound. “No sound” shows the notification without a sound." card>
                {NOTIFICATION_EVENTS.map(event => {
                    const current = value.events[event.id];
                    return (
                        <SettingsRow
                            key={event.id}
                            label={event.label}
                            description={event.description}
                            control={(
                                <div className="notification-controls">
                                    <select
                                        className="tasks-select"
                                        value={current.sound ?? ''}
                                        disabled={!value.enabled || !current.enabled}
                                        title="Sound"
                                        onChange={change => {
                                            const sound = change.target.value || null;
                                            void saveEvent(event.id, { sound });
                                            if (sound) window.shipwarden.notifications.playSound(sound);
                                        }}
                                    >
                                        <option value="">No sound</option>
                                        {NOTIFICATION_SOUNDS.map(sound => <option key={sound} value={sound}>{sound}</option>)}
                                    </select>
                                    <button
                                        className="icon-button"
                                        title="Play the sound"
                                        disabled={!current.sound}
                                        onClick={() => current.sound && window.shipwarden.notifications.playSound(current.sound)}
                                    >
                                        <Volume2 size={15} strokeWidth={1.7} />
                                    </button>
                                    <Switch
                                        checked={current.enabled}
                                        disabled={!value.enabled}
                                        title={current.enabled ? 'On' : 'Off'}
                                        onChange={enabled => void saveEvent(event.id, { enabled })}
                                    />
                                </div>
                            )}
                        />
                    );
                })}
                {error && <div className="form-error">{error}</div>}
            </SettingsGroup>
        </>
    );
}
