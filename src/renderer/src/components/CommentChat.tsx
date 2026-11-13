import { Bot, LoaderCircle, MessagesSquare } from 'lucide-react';
import {
    cancelChatRun,
    chatKeyOf,
    clearChat,
    retryChat,
    sendChatMessage,
    setChatDraft,
    setChatOpen,
    useCommentChat,
    type CommentChatContext
} from '../github/comment-chat-store';
import { timeAgo } from '../util';
import { Markdown } from './Markdown';
import { Button, TextArea } from './ui';

/** The text of the "Chat" button. It shows the count of messages when the chat has messages. */
export function ChatToggle({ context }: { context: CommentChatContext }) {
    const key = chatKeyOf(context);
    const chat = useCommentChat(key);
    const count = chat.messages.length;
    return (
        <Button
            variant="link"
            icon={<MessagesSquare size={13} strokeWidth={1.6} />}
            aria-expanded={chat.open}
            title="Talk about this comment with the agent. The agent does not change files."
            onClick={() => setChatOpen(key, !chat.open)}
        >
            {chat.open ? 'Hide chat' : count ? `Chat (${count})` : 'Chat'}
        </Button>
    );
}

/**
 * A chat with the agent about a review comment, under the comment. The agent answers in print mode. It reads the
 * code but does not change files. Use "Send to agent" to give the agent work.
 * `onUse` puts the text of an answer into the comment, for example as a reply.
 */
export function CommentChat({ context, useLabel, onUse }: { context: CommentChatContext; useLabel?: string; onUse?(text: string): void }) {
    const key = chatKeyOf(context);
    const chat = useCommentChat(key);
    const text = chat.draft;
    if (!chat.open) return null;
    const send = () => {
        if (!text.trim() || chat.running) return;
        void sendChatMessage(context, text);
    };
    const last = chat.messages.at(-1);
    return (
        <div className="comment-chat">
            {chat.messages.map(message => (
                <div key={message.id} className={`comment-chat-message ${message.role}`}>
                    <div className="comment-author">
                        {message.role === 'agent' ? (
                            <>
                                <Bot size={12} strokeWidth={1.6} /> {message.agent ?? 'Agent'}
                            </>
                        ) : (
                            'You'
                        )}
                        <span className="agent-question-time">{timeAgo(new Date(message.at).toISOString())}</span>
                    </div>
                    {message.role === 'agent' ? (
                        <>
                            <Markdown className="comment-body" text={message.text} />
                            {onUse && useLabel && (
                                <div className="thread-actions">
                                    <Button variant="link" onClick={() => onUse(message.text)}>
                                        {useLabel}
                                    </Button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="comment-body comment-chat-text">{message.text}</div>
                    )}
                </div>
            ))}
            {chat.running && (
                <div className="agent-question-wait">
                    <LoaderCircle size={13} className="spin" /> The agent reads the code…
                </div>
            )}
            {chat.error && <div className="form-error">{chat.error}</div>}
            <TextArea
                className="comment-chat-box"
                value={text}
                rows={2}
                placeholder={chat.messages.length ? 'Reply to the agent' : 'Ask the agent about this comment'}
                aria-label="Message to the agent"
                onChange={event => setChatDraft(key, event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send();
                    if (event.key === 'Escape') setChatOpen(key, false);
                    // The diff must not handle keys that the user types in the chat box.
                    event.stopPropagation();
                }}
            />
            <div className="row-buttons">
                {chat.messages.length > 0 && !chat.running && (
                    <Button variant="link-danger" onClick={() => clearChat(key)}>
                        Clear
                    </Button>
                )}
                {chat.error && last?.role === 'user' && <Button onClick={() => retryChat(context)}>Try again</Button>}
                {chat.running ? (
                    <Button onClick={() => cancelChatRun(key)}>Stop</Button>
                ) : (
                    <Button variant="primary" disabled={!text.trim()} title="Send (⌘↩)" onClick={send}>
                        Send
                    </Button>
                )}
            </div>
        </div>
    );
}
