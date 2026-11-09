import { useEffect, useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';

interface Props {
    /** The text to copy. */
    text: string;
    /** The tooltip, for example "Copy the path". */
    title: string;
    size?: number;
    className?: string;
}

/** An icon button that copies a text to the clipboard. The icon shows a check mark for a short time after the copy. */
export function CopyButton({ text, title, size = 14, className = 'icon-button' }: Props) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = (event: MouseEvent) => {
        // The button can be in a header that opens or closes on a click.
        event.stopPropagation();
        navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined);
    };

    return (
        <button className={`${className}${copied ? ' copied' : ''}`} title={copied ? 'Copied' : title} aria-label={title} onClick={copy}>
            {copied ? <Check size={size} strokeWidth={1.8} /> : <Copy size={size} strokeWidth={1.6} />}
        </button>
    );
}
