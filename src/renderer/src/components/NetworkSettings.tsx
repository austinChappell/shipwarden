import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import type { NetworkStatus } from '@shared/api';
import type { AppSettings } from '@shared/settings';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

type TestResult = { name: string; ok: boolean; error?: string };

/**
 * The network settings: extra CA certificates for a network that inspects TLS traffic, for example a company VPN.
 * Chromium (the views) uses the macOS keychain. These settings are for the Node parts: GitHub, the task plugins
 * and the usage bar.
 */
export function NetworkSettings({ settings, onSave }: Props) {
    const network = settings.network;
    const [file, setFile] = useState(network.caCertsFile ?? '');
    const [status, setStatus] = useState<NetworkStatus>();
    const [error, setError] = useState<string>();
    const [testing, setTesting] = useState(false);
    const [results, setResults] = useState<TestResult[]>();

    const loadStatus = useCallback(() => {
        window.shipwarden.network.status().then(setStatus, err => setError(errorText(err)));
    }, []);
    useEffect(loadStatus, [loadStatus]);
    useEffect(() => setFile(network.caCertsFile ?? ''), [network.caCertsFile]);

    const save = async (change: Partial<AppSettings['network']>) => {
        setError(undefined);
        setResults(undefined);
        try {
            await onSave({ network: { ...network, ...change } });
            loadStatus();
        } catch (err) {
            setError(errorText(err));
        }
    };
    const commitFile = () => {
        if (file.trim() !== (network.caCertsFile ?? '')) {
            void save({ caCertsFile: file.trim() || undefined });
        }
    };
    const choose = async () => {
        const chosen = await window.shipwarden.network.chooseCaFile();
        if (chosen) {
            setFile(chosen);
            void save({ caCertsFile: chosen });
        }
    };
    const test = async () => {
        setTesting(true);
        setResults(undefined);
        try {
            setResults(await window.shipwarden.network.test());
        } catch (err) {
            setError(errorText(err));
        } finally {
            setTesting(false);
        }
    };

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
                                onChange={event => void save({ useSystemCertificates: event.target.checked })}
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
                        <button className="button" disabled={testing} onClick={() => void test()}>
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
