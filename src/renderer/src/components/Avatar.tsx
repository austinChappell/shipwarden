import { useState } from 'react';
import { initials } from './pr-description';

interface Props {
    login: string;
    url?: string;
    /** The width and the height in CSS pixels. */
    size: number;
    className?: string;
}

/** Adds the size to a GitHub avatar URL, so that GitHub sends a small image. The image has two times the size, for Retina screens. */
function sizedUrl(url: string, size: number): string {
    try {
        const parsed = new URL(url);
        parsed.searchParams.set('s', String(size * 2));
        return parsed.toString();
    } catch {
        return url;
    }
}

/** The GitHub avatar of a user. When there is no URL or the image does not load, it shows the initials of the login. */
export function Avatar({ login, url, size, className }: Props) {
    const [failed, setFailed] = useState(false);
    const classes = `avatar${className ? ` ${className}` : ''}`;
    if (!url || failed) {
        return (
            <span className={`${classes} avatar-initials`} style={{ width: size, height: size }} aria-hidden="true">
                {initials(login)}
            </span>
        );
    }
    return (
        <img
            className={classes}
            src={sizedUrl(url, size)}
            width={size}
            height={size}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
        />
    );
}
