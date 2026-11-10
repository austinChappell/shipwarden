import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CircleCheck, Copy, Smartphone, TriangleAlert } from 'lucide-react';
import type { PairingOffer, RemoteStatus } from '@shared/remote';
import type { AppSettings } from '@shared/settings';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

const api = window.shipwarden.remote;

function since(time: number | undefined): string {
    if (!time) return 'never';
    const seconds = Math.round((Date.now() - time) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/** Shows the pairing QR code, and the time until the code stops. */
function PairingCode({ offer, onRenew, onClose }: { offer: PairingOffer; onRenew(): void; onClose(): void }) {
    const [svg, setSvg] = useState('');
    const [now, setNow] = useState(Date.now());
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        void QRCode.toString(offer.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg);
    }, [offer.link]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const left = Math.max(0, Math.round((offer.expiresAt - now) / 1000));
    const copy = async () => {
        await navigator.clipboard.writeText(offer.link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <div className="pairing">
            {/* A QR code needs dark modules on a light background in each theme, so the camera can read it. */}
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the qrcode library makes this SVG from the pairing link. */}
            <div className={`pairing-qr${left === 0 ? ' expired' : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="pairing-text">
                <ol>
                    <li>Open the ShipWarden app on your iPhone.</li>
                    <li>
                        Tap <strong>Pair with a Mac</strong> and scan this code. You can also scan it with the Camera app.
                    </li>
                    <li>The phone must be on the same network as this Mac, or on the same VPN, for example Tailscale.</li>
                </ol>
                {left > 0 ? (
                    <p className="panel-note">
                        The code works one time. It stops in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
                    </p>
                ) : (
                    <p className="panel-note">The code stopped. Make a new code.</p>
                )}
                <div className="pairing-actions">
                    <button className="button" onClick={() => void copy()}>
                        {copied ? <CircleCheck size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
                    </button>
                    <button className="button" onClick={onRenew}>
                        New code
                    </button>
                    <button className="button" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * The phone connection: a switch for the HTTPS server, the pairing QR code and the paired phones.
 * The phone app shows the agents, their screens and the pull requests, and sends replies to the agents.
 */
export function MobileSettings({ settings, onSave }: Props) {
    const remote = settings.remote;
    const [status, setStatus] = useState<RemoteStatus>();
    const [offer, setOffer] = useState<PairingOffer>();
    const [port, setPort] = useState(String(remote.port));
    const [error, setError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const [paired, setPaired] = useState<string>();
    const deviceCount = useRef<number | undefined>(undefined);

    const load = useCallback(() => {
        api.status().then(
            next => {
                // A new device while the QR code shows: the pairing worked.
                if (deviceCount.current !== undefined && next.devices.length > deviceCount.current) {
                    setOffer(undefined);
                    setPaired(next.devices[next.devices.length - 1]?.name);
                }
                deviceCount.current = next.devices.length;
                setStatus(next);
            },
            err => setError(errorText(err))
        );
    }, []);
    useEffect(() => {
        load();
        const stop = api.onChanged(load);
        // The "last seen" times change without an event.
        const timer = setInterval(load, 30_000);
        return () => {
            stop();
            clearInterval(timer);
        };
    }, [load]);
    useEffect(() => setPort(String(remote.port)), [remote.port]);
    // The pairing code stops when the page closes.
    useEffect(() => () => void api.cancelPairing(), []);

    const save = async (change: Partial<AppSettings['remote']>) => {
        setError(undefined);
        setSaving(true);
        try {
            await onSave({ remote: { ...remote, ...change } });
            if (change.enabled === false) setOffer(undefined);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
            load();
        }
    };
    const toggleKeepRunning = async (on: boolean) => {
        if (
            on &&
            !(await confirmDialog({
                title: 'Run a background helper?',
                message:
                    'ShipWarden adds a launch agent to ~/Library/LaunchAgents. The helper starts at login and runs the phone connection while ShipWarden is closed. Turn this setting off to remove it.',
                confirmLabel: 'Add helper'
            }))
        )
            return;
        await save({ keepRunning: on });
    };
    const commitPort = () => {
        const value = Number(port);
        if (!Number.isInteger(value) || value < 1024 || value > 65535) {
            setError('Type a port from 1024 to 65535.');
            setPort(String(remote.port));
            return;
        }
        if (value !== remote.port) void save({ port: value });
    };
    const pair = async () => {
        setError(undefined);
        setPaired(undefined);
        try {
            setOffer(await api.startPairing());
        } catch (err) {
            setError(errorText(err));
        }
    };
    const closePairing = () => {
        setOffer(undefined);
        void api.cancelPairing();
    };
    const remove = async (id: string, name: string) => {
        if (
            !(await confirmDialog({
                title: `Remove "${name}"?`,
                message: 'The phone loses its access at once. To use it again, pair it again.',
                confirmLabel: 'Remove',
                danger: true
            }))
        )
            return;
        try {
            await api.removeDevice(id);
            load();
        } catch (err) {
            setError(errorText(err));
        }
    };

    const connected = new Set(status?.connected ?? []);
    return (
        <>
            <SettingsGroup
                title="Phone connection"
                description={
                    <>
                        The ShipWarden iPhone app shows your agents, their terminal screens, and the pull requests of the worktrees. You can reply to an agent,
                        answer its questions and approve a pull request. The phone connects to this Mac over HTTPS on your network. ShipWarden must be open, but
                        the window can be closed. A background helper can keep the connection open while ShipWarden is closed.
                    </>
                }
                card
            >
                <SettingsRow
                    label="Allow phone connections"
                    description="Only paired phones can connect. Each phone has its own key, and you can remove it at any time."
                    control={
                        <label className="switch" title={remote.enabled ? 'On' : 'Off'}>
                            <input
                                type="checkbox"
                                checked={remote.enabled}
                                disabled={saving}
                                onChange={event => void save({ enabled: event.target.checked })}
                            />
                            <span />
                        </label>
                    }
                >
                    {remote.enabled &&
                        status &&
                        (status.running ? (
                            <div className="panel-note">
                                <CircleCheck size={12} strokeWidth={2} className="ok-icon" /> Listening on port {status.port} at {status.hosts.join(', ')}.
                            </div>
                        ) : (
                            status.error && (
                                <div className="form-error">
                                    <TriangleAlert size={12} /> {status.error}
                                </div>
                            )
                        ))}
                </SettingsRow>
                <SettingsRow
                    label="Keep agents and phone access running when ShipWarden is closed"
                    description="A background helper runs the phone connection. macOS starts it at login and lists it in System Settings › General › Login Items. The agents always continue to run when ShipWarden quits."
                    control={
                        <label className="switch" title={remote.keepRunning ? 'On' : 'Off'}>
                            <input
                                type="checkbox"
                                checked={remote.keepRunning}
                                disabled={saving}
                                onChange={event => void toggleKeepRunning(event.target.checked)}
                            />
                            <span />
                        </label>
                    }
                >
                    {remote.keepRunning &&
                        status &&
                        (status.owner === 'helper' ? (
                            <div className="panel-note">
                                <CircleCheck size={12} strokeWidth={2} className="ok-icon" /> The background helper runs the phone connection.
                            </div>
                        ) : (
                            status.helperError && (
                                <div className="form-error">
                                    <TriangleAlert size={12} /> {status.helperError}
                                </div>
                            )
                        ))}
                </SettingsRow>
                <SettingsRow
                    label="Port"
                    description="The TCP port of the server. A change disconnects the phones. They find the new port only after a new pairing."
                >
                    <input
                        className="settings-input mono port-input"
                        value={port}
                        inputMode="numeric"
                        onChange={event => setPort(event.target.value.replace(/\D/g, ''))}
                        onBlur={commitPort}
                        onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                    />
                </SettingsRow>
                {status?.fingerprint && (
                    <SettingsRow label="Certificate" description="The phone accepts only this certificate. The QR code contains its fingerprint.">
                        <code className="fingerprint">{status.fingerprint.match(/.{1,4}/g)?.join(' ')}</code>
                    </SettingsRow>
                )}
                {error && <div className="form-error">{error}</div>}
            </SettingsGroup>

            <SettingsGroup
                title="Paired phones"
                actions={
                    <button className="button primary" disabled={!status?.running} onClick={() => void pair()}>
                        <Smartphone size={13} /> Pair a phone
                    </button>
                }
                card
            >
                {offer && <PairingCode offer={offer} onRenew={() => void pair()} onClose={closePairing} />}
                {paired && (
                    <div className="panel-note pairing-done">
                        <CircleCheck size={12} strokeWidth={2} className="ok-icon" /> “{paired}” is paired.
                    </div>
                )}
                {status?.devices.length === 0 && !offer && (
                    <div className="settings-row-description device-empty">
                        {status.running ? 'No phones yet. Select “Pair a phone”.' : 'Turn on phone connections to pair a phone.'}
                    </div>
                )}
                {status?.devices.map(device => (
                    <div key={device.id} className="connection-row device-row">
                        <span
                            className={`device-dot${connected.has(device.id) ? ' online' : ''}`}
                            title={connected.has(device.id) ? 'Connected now' : 'Not connected'}
                        />
                        <span className="connection-name">{device.name}</span>
                        <span className="connection-meta">
                            {connected.has(device.id) ? 'Connected now' : `Last seen ${since(device.lastSeenAt)}`} · paired{' '}
                            {new Date(device.pairedAt).toLocaleDateString()}
                        </span>
                        <button className="button danger" onClick={() => void remove(device.id, device.name)}>
                            Remove
                        </button>
                    </div>
                ))}
            </SettingsGroup>
        </>
    );
}
