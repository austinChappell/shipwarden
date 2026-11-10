import { useMemo, useState } from 'react';
import { Check, FileDiff, LoaderCircle } from 'lucide-react';
import { splitSuggestions } from '@shared/suggestion';
import { errorText } from '../util';
import { Markdown } from './Markdown';

interface Props {
    body: string;
    /** The old lines of the suggestion. Without them, a suggestion shows only the new lines. */
    original?: string[];
    /** True when the lines changed after the comment. */
    outdated?: boolean;
    /** Applies the new lines to the file. Returns a message for the user. Without it, the Apply button does not show. */
    onApply?(lines: string[]): Promise<string>;
}

/** Shows a review comment. Each suggestion block shows as a diff of the old and the new lines, as on GitHub. */
export function CommentBody({ body, original, outdated, onApply }: Props) {
    const parts = useMemo(() => splitSuggestions(body), [body]);
    if (!parts.some(part => part.kind === 'suggestion')) {
        return <Markdown className="comment-body" text={body} />;
    }
    return (
        <div className="comment-body">
            {parts.map((part, index) => part.kind === 'text'
                ? part.text.trim() && <Markdown key={index} text={part.text} />
                : <SuggestionDiff key={index} lines={part.lines} original={original} outdated={outdated} onApply={onApply} />)}
        </div>
    );
}

function SuggestionDiff({ lines, original, outdated, onApply }: { lines: string[]; original?: string[]; outdated?: boolean; onApply?(lines: string[]): Promise<string> }) {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string }>();
    const apply = async () => {
        if (!onApply) return;
        setBusy(true);
        setResult(undefined);
        try {
            setResult({ ok: true, text: await onApply(lines) });
        } catch (err) {
            setResult({ ok: false, text: errorText(err) });
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="suggestion">
            <div className="suggestion-header">
                <FileDiff size={12} strokeWidth={1.6} /> Suggested change
                {outdated && <span className="tag">outdated</span>}
                <span className="header-spacer" />
                {onApply && (
                    <button className="link-button" disabled={busy} title="Change the file in the worktree. You commit the change." onClick={apply}>
                        {busy ? <LoaderCircle size={12} className="spin" /> : <Check size={12} strokeWidth={2} />} Apply suggestion
                    </button>
                )}
            </div>
            <div className="suggestion-lines">
                {original?.map((line, index) => (
                    <div key={`o${index}`} className="suggestion-line removed"><span className="suggestion-sign" title="Old line">−</span>{line || ' '}</div>
                ))}
                {lines.map((line, index) => (
                    <div key={`n${index}`} className="suggestion-line added"><span className="suggestion-sign" title="New line">+</span>{line || ' '}</div>
                ))}
                {lines.length === 0 && <div className="suggestion-note">The suggestion removes the lines.</div>}
            </div>
            {result && <div className={result.ok ? 'suggestion-result' : 'form-error'}>{result.text}</div>}
        </div>
    );
}
