import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { GitHubOwner } from '@shared/github';
import type { AppSettings } from '@shared/settings';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

/** The code review settings: the provider and the GitHub organizations whose pull requests the Review view shows. */
export function CodeReviewSettings({ settings, onSave }: Props) {
    const [owners, setOwners] = useState<GitHubOwner[]>();
    const [error, setError] = useState<string>();
    const selected = settings.reviewOwners;

    useEffect(() => {
        window.shipwarden.github.owners().then(setOwners, err => setError(errorText(err)));
    }, []);

    const save = (reviewOwners: string[] | 'all') => onSave({ reviewOwners }).catch(err => setError(errorText(err)));
    const mode = selected === 'all' ? 'all' : selected ? 'some' : undefined;

    return (
        <>
            <SettingsGroup title="Provider" card>
                <SettingsRow
                    label="Pull requests"
                    description="ShipWarden uses the GitHub CLI login (gh auth login) or GITHUB_TOKEN. Azure DevOps and GitLab come later."
                    control={(
                        <div className="segmented compact">
                            <button className="selected">GitHub</button>
                        </div>
                    )}
                />
            </SettingsGroup>

            <SettingsGroup
                title="Organizations"
                description="The Review view lists the repositories of these organizations. You select one repository at a time there."
                card
            >
                <SettingsRow
                    label={(
                        <label className="scope-option">
                            <input type="radio" checked={mode === 'all'} onChange={() => save('all')} />
                            All organizations, also new ones
                        </label>
                    )}
                />
                <SettingsRow
                    label={(
                        <label className="scope-option">
                            <input type="radio" checked={mode === 'some'} onChange={() => save(owners ? owners.map(owner => owner.login) : [])} />
                            Only these:
                        </label>
                    )}
                >
                    {error && <div className="form-error">{error}</div>}
                    {!owners && !error && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading your organizations…</div>}
                    {owners && (
                        <div className={`scope-list${mode === 'some' ? '' : ' disabled'}`}>
                            {owners.map(owner => {
                                const list = Array.isArray(selected) ? selected : [];
                                return (
                                    <label key={owner.login} className="scope-item">
                                        <input
                                            type="checkbox"
                                            disabled={mode !== 'some'}
                                            checked={mode === 'some' && list.includes(owner.login)}
                                            onChange={event => save(event.target.checked ? [...list, owner.login] : list.filter(item => item !== owner.login))}
                                        />
                                        <span>{owner.login}</span>
                                        {owner.kind === 'user' && <span className="scope-detail">your account</span>}
                                    </label>
                                );
                            })}
                        </div>
                    )}
                </SettingsRow>
            </SettingsGroup>
        </>
    );
}
