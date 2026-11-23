import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentTokens } from '@shared/agent-tokens';
import { startOfDay } from '@shared/automations';
import type { TerminalSession } from '@shared/terminal';
import { keyRoots, queryClient } from '../query-client';

/**
 * The time between two reads when no agent state changes. A read is local. It reads only the new end of each
 * transcript file.
 */
const READ_MS = 15_000;

type TokensByTranscript = Record<string, AgentTokens>;

const EMPTY: TokensByTranscript = {};

/**
 * The tokens of each agent session, by transcript path. Only Claude Code and Codex write a transcript with token data.
 * A change of an agent state reads the transcripts again, because the agent wrote a new response.
 */
export function useAgentTokens(sessions: readonly TerminalSession[]): TokensByTranscript {
    const transcripts = [...new Set(sessions.map(session => session.agentTranscript).filter((file): file is string => !!file))].sort();
    const stamp = Math.max(0, ...sessions.map(session => session.agentStateAt ?? 0));
    const query = useQuery({
        queryKey: [...keyRoots.agentTokens, transcripts],
        queryFn: async () => {
            const today = startOfDay(Date.now());
            const result: TokensByTranscript = {};
            await Promise.all(
                transcripts.map(async file => {
                    try {
                        const [total, fromToday] = await Promise.all([
                            window.shipwarden.automations.countTokens(file, 0),
                            window.shipwarden.automations.countTokens(file, today)
                        ]);
                        result[file] = { total, today: fromToday };
                    } catch {
                        // A transcript that the counter cannot read gives no tokens. The row then shows no count.
                    }
                })
            );
            return result;
        },
        enabled: transcripts.length > 0,
        staleTime: READ_MS,
        refetchInterval: READ_MS,
        placeholderData: previous => previous
    });

    // A new agent state means a new response in the transcript. Read the transcripts again.
    useEffect(() => {
        if (stamp > 0) void queryClient.invalidateQueries({ queryKey: keyRoots.agentTokens });
    }, [stamp]);

    return query.data ?? EMPTY;
}
