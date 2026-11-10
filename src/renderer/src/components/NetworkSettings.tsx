import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import type { AppSettings } from '@shared/settings';
import { keyRoots } from '../query-client';
import { optionalErrorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

/** The query key of the certificate state. */
const statusKey = [...keyRoots.network, 'status'];

/**
 * The network settings: extra CA certificates for a network that inspects TLS traffic, for example a company VPN.
 * Chromium (the views) uses the macOS keychain. These settings are for the Node parts: GitHub, the task plugins
 * and the usage bar.
 */
export function NetworkSettings({ settings, onSave }: Props) {
    const network = settings.network;
    const queryClient = useQueryClient();
    const [file, setFile] = useState(network.caCertsFile ?? '');
    useEffect(() => setFile(network.caCertsFile ?? ''), [network.caCertsFile]);

    // The settings page shows the current state. The cached state shows first, and a new state loads each time that the page opens.
    const statusQuery = useQuery({ queryKey: statusKey, queryFn: () => window.shipwarden.network.status(), staleTime: 0 });
    const status = statusQuery.data;

    /** The connection test. Its result shows until the next save. */
    const testMutation = useMutation({ mutationFn: () => window.shipwarden.network.test() });
    const results = testMutation.data;
    const testing = testMutation.isPending;

    // A save changes the trusted certificates, so the state loads again.
    const saveMutation = useMutation({
        mutationFn: (change: Partial<AppSettings['network']>) => onSave({ network: { ...network, ...change } }),
        onMutate: () => testMutation.reset(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: statusKey })
    });
    const error = optionalErrorText(saveMutation.error ?? testMutation.error ?? statusQuery.error);
    const save = (change: Partial<AppSettings['network']>) => saveMutation.mutate(change);
    const commitFile = () => {
        if (file.trim() !== (network.caCertsFile ?? '')) {
            save({ caCertsFile: file.trim() || undefined });
        }
    };
    const choose = async () => {
        const chosen = await window.shipwarden.network.chooseCaFile();
        if (chosen) {
            setFile(chosen);
            save({ caCertsFile: chosen });
        }
    };
    const test = () => testMutation.mutate();

    const fileStatus = status?.file;
    return (
        <>
            <SettingsGroup
                title="Trusted certificates"
                description={
                    <>
                        Use these settings on a network that inspects TLS traffic, for example a company VPN. ShipWarden trusts these certificates in addition
                        to the default ones for GitHub, the task managers and the usage bar. A change restarts the task managers.
                    </>
                }
                card
            >
                <SettingsRow
                    label="CA certificates file"
                    description={
                        <>
                            A PEM file with the CA certificates of your network.
                            {!network.caCertsFile && status?.shellFile && (
                                <>
                                    {' '}
                                    Empty: ShipWarden uses NODE_EXTRA_CA_CERTS from your shell, <code>{status.shellFile}</code>.
                                </>
                            )}
                            {!network.caCertsFile && !status?.shellFile && <> Empty: only the default certificates.</>}
                        </>
                    }
                >
                    <div className="ca-file-row">
                        <input
                            className="settings-input mono"
                            value={file}
                            placeholder={status?.shellFile ?? '/Users/you/.certs/company-ca.pem'}
                            spellCheck={false}
                            onChange={event => setFile(event.target.value)}
                            onBlur={commitFile}
                            onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                        />
                        <button className="button" onClick={() => void choose()}>
                            Choose…
                        </button>
                    </div>
                    {fileStatus?.error && <div className="form-error">{fileStatus.error}</div>}
                    {fileStatus?.count !== undefined && (
                        <div className="panel-note">
                            <CircleCheck size={12} strokeWidth={2} className="ok-icon" /> {fileStatus.count} certificate{fileStatus.count === 1 ? '' : 's'} from{' '}
                            {fileStatus.source === 'shell' ? 'NODE_EXTRA_CA_CERTS' : 'the file'}.
                        </div>
                    )}
                </SettingsRow>
                <SettingsRow
                    label="Trust the macOS keychain"
                    description="Adds the certificates of the system keychain. IT departments often install the company CA there."
                    control={
                        <label className="switch" title={network.useSystemCertificates ? 'On' : 'Off'}>
                            <input
                                type="checkbox"
                                checked={network.useSystemCertificates}
                                onChange={event => save({ useSystemCertificates: event.target.checked })}
                            />
                            <span />
                        </label>
                    }
                >
                    {status?.system?.error && <div className="form-error">ShipWarden cannot read the keychain: {status.system.error}</div>}
                    {status?.system?.count !== undefined && (
                        <div className="panel-note">
                            <CircleCheck size={12} strokeWidth={2} className="ok-icon" /> {status.system.count} certificates from the keychain.
                        </div>
                    )}
                </SettingsRow>
                <SettingsRow
                    label="Test the connection"
                    description="Connects to GitHub and ClickUp with these certificates."
                    control={
                        <button className="button" disabled={testing} onClick={test}>
                            {testing && <LoaderCircle size={13} className="spin" />} Test
                        </button>
                    }
                >
                    {results?.map(result => (
                        <div key={result.name} className={`network-test ${result.ok ? 'ok' : 'failed'}`}>
                            {result.ok ? <CircleCheck size={13} strokeWidth={2} /> : <CircleX size={13} strokeWidth={2} />}
                            <strong>{result.name}</strong>
                            <span>{result.ok ? 'Connected.' : result.error}</span>
                        </div>
                    ))}
                </SettingsRow>
                {error && <div className="form-error">{error}</div>}
            </SettingsGroup>
        </>
    );
}
