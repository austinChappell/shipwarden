import { useEffect, useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton, cx } from './ui';

interface Props {
    /** The text to copy. */
    text: string;
    /** The tooltip, for example "Copy the path". */
    title: string;
    size?: number;
    /** Extra classes. The "icon-button" class is not necessary. `IconButton` adds it. */
    className?: string;
}

/** An icon button that copies a text to the clipboard. The icon shows a check mark for a short time after the copy. */
export function CopyButton({ text, title, size = 14, className }: Props) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = (event: MouseEvent) => {
        // The button can be in a header that opens or closes on a click.
        event.stopPropagation();
        navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => undefined
        );
    };

    return (
        <IconButton
            icon={copied ? <Check size={size} strokeWidth={1.8} /> : <Copy size={size} strokeWidth={1.6} />}
            label={title}
            title={copied ? 'Copied' : title}
            size="sm"
            className={cx(
                className
                    ?.split(' ')
                    .filter(name => name !== 'icon-button')
                    .join(' '),
                copied && 'copied'
            )}
            onClick={copy}
        />
    );
}
