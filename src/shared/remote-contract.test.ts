import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { AgentState } from './agents';
import {
    REMOTE_KEYS,
    REMOTE_PROTOCOL,
    type RemoteErrorBody,
    type RemoteInput,
    type RemotePairResponse,
    type RemoteSnapshot,
    type ScreenSnapshot
} from './remote';

/**
 * The contract between the desktop app and the iPhone app.
 *
 * This test writes sample API data to `ios/ContractFixtures`. The types of `remote.ts` check each sample.
 * `scripts/check-ios-contract.sh` decodes the same files with `ios/ShipWarden/Models.swift`.
 * When you change `remote.ts`, run `UPDATE_CONTRACT_FIXTURES=1 npm test`, then run the Swift check.
 */

/** Makes each optional field required, at all levels. A full sample must then contain every field. */
type DeepRequired<T> = T extends (infer U)[] ? DeepRequired<U>[] : T extends object ? { [K in keyof T]-?: DeepRequired<Exclude<T[K], undefined>> } : T;

/** Each agent state. The record type makes the compiler find a missing state. */
const AGENT_STATES: Record<AgentState, true> = { starting: true, idle: true, working: true, waiting: true, done: true, exited: true };

const fullSnapshot: DeepRequired<RemoteSnapshot> = {
    protocol: REMOTE_PROTOCOL,
    mac: { name: 'Studio', version: '0.1.5' },
    projects: [
        {
            id: 'project-1',
            name: 'Work',
            repos: [
                {
                    path: '/Users/ana/api',
                    name: 'api',
                    color: '#4a8fe7',
                    worktrees: [
                        {
                            path: '/Users/ana/.shipwarden/worktrees/api/fix-login',
                            branch: 'eng-12-fix-login',
                            name: 'Fix login',
                            isMain: false,
                            task: { title: 'Fix the login page', key: 'ENG-12', url: 'https://example.com/t/12' },
                            pullRequest: {
                                number: 7,
                                title: 'Fix the login page',
                                url: 'https://github.com/acme/api/pull/7',
                                isDraft: false,
                                reviewDecision: 'APPROVED',
                                checks: 'SUCCESS',
                                headSha: '0123456789abcdef0123456789abcdef01234567'
                            }
                        }
                    ]
                }
            ]
        }
    ],
    agents: [
        {
            id: 'session-1',
            title: 'Claude Code',
            worktreePath: '/Users/ana/.shipwarden/worktrees/api/fix-login',
            cwd: '/Users/ana/.shipwarden/worktrees/api/fix-login',
            state: 'waiting',
            message: 'Claude needs your permission to use Bash',
            prompt: 'Fix the login page',
            stateAt: 1767225600000,
            exited: false
        }
    ]
};

const minimalSnapshot: RemoteSnapshot = {
    protocol: REMOTE_PROTOCOL,
    mac: { name: 'Studio', version: '0.1.5' },
    projects: [
        {
            id: 'project-1',
            name: 'Work',
            repos: [
                {
                    path: '/Users/ana/api',
                    name: 'api',
                    worktrees: [
                        { path: '/Users/ana/api', name: 'api', isMain: true },
                        {
                            path: '/Users/ana/.shipwarden/worktrees/api/draft',
                            name: 'draft',
                            isMain: false,
                            pullRequest: { number: 8, url: 'https://github.com/acme/api/pull/8', isDraft: true, reviewDecision: null, checks: null }
                        }
                    ]
                }
            ]
        }
    ],
    agents: [{ id: 'session-2', title: 'Shell', cwd: '/Users/ana/api', exited: true }]
};

const screen: ScreenSnapshot = {
    cols: 80,
    rows: 2,
    lines: [
        [{ t: 'plain ' }, { t: 'palette', fg: 2, bg: 236 }, { t: ' rgb', fg: '#ff8800', bg: '#000000' }],
        [
            { t: 'bold', b: 1 },
            { t: 'dim', d: 1 },
            { t: 'italic', i: 1 },
            { t: 'under', u: 1 },
            { t: 'inverse', v: 1 }
        ],
        []
    ],
    cursor: { x: 4, y: 1, visible: true }
};

const pair: RemotePairResponse = {
    protocol: REMOTE_PROTOCOL,
    token: 'token-123',
    deviceId: 'device-1',
    mac: { name: 'Studio', version: '0.1.5' }
};

const error: RemoteErrorBody = { error: 'This address does not exist.' };

/** The phone encodes this input. The Swift check compares its own encoding with this file. */
const input: Required<RemoteInput> = { text: 'yes', key: 'enter', submit: true };

const fixtures: Record<string, unknown> = {
    'snapshot-full.json': fullSnapshot,
    'snapshot-minimal.json': minimalSnapshot,
    'screen.json': screen,
    'pair-response.json': pair,
    'error.json': error,
    'input.json': input,
    'agent-states.json': Object.keys(AGENT_STATES),
    'remote-keys.json': REMOTE_KEYS
};

const folder = resolve(__dirname, '../../ios/ContractFixtures');

describe('the iPhone API contract fixtures', () => {
    if (process.env.UPDATE_CONTRACT_FIXTURES) {
        mkdirSync(folder, { recursive: true });
        for (const [name, value] of Object.entries(fixtures)) writeFileSync(join(folder, name), `${JSON.stringify(value, null, 2)}\n`);
    }

    it.each(Object.keys(fixtures))('%s agrees with remote.ts', name => {
        const path = join(folder, name);
        const expected = `${JSON.stringify(fixtures[name], null, 2)}\n`;
        expect(existsSync(path), `${path} is missing. Run UPDATE_CONTRACT_FIXTURES=1 npm test.`).toBe(true);
        expect(readFileSync(path, 'utf8'), 'The fixture is old. Run UPDATE_CONTRACT_FIXTURES=1 npm test, then scripts/check-ios-contract.sh.').toBe(expected);
    });
});
