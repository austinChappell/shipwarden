import { describe, expect, it } from 'vitest';
import { agentForRepo, agentTitle, commandProgram, DEFAULT_AGENTS, DEFAULT_SETTINGS, missingDefaultAgents, normalizeScripts, normalizeSettings, repoDisplayName } from './settings';

describe('normalizeSettings', () => {
    it('gives a new installation the default agents', () => {
        expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(DEFAULT_SETTINGS.agents.map(agent => agent.name)).toEqual(['Claude Code', 'Codex', 'Gemini CLI']);
    });

    it('turns the single agent command of older settings into the default agent', () => {
        expect(normalizeSettings({ agentCommand: 'codex' })).toMatchObject({ agents: DEFAULT_AGENTS, defaultAgentId: 'codex' });
        const custom = normalizeSettings({ agentCommand: '  claude --model opus ' });
        expect(custom.agents.at(-1)).toEqual({ id: 'custom', name: 'claude', command: 'claude --model opus' });
        expect(custom.defaultAgentId).toBe('custom');
        // A command with a new line is not a command that a person types.
        expect(normalizeSettings({ agentCommand: 'claude\nrm -rf ~' }).defaultAgentId).toBe('claude');
    });

    it('keeps a valid agent list and removes bad agents', () => {
        const settings = normalizeSettings({
            agents: [
                { id: 'a', name: ' Aider ', command: 'aider --yes' },
                { id: 'a', name: 'Duplicate', command: 'x' },
                { id: 'b', name: 'No command', command: '' },
                { id: 'c', command: '/opt/bin/goose run' }
            ],
            defaultAgentId: 'gone'
        });
        expect(settings.agents).toEqual([
            { id: 'a', name: 'Aider', command: 'aider --yes' },
            { id: 'c', name: 'goose', command: '/opt/bin/goose run' }
        ]);
        expect(settings.defaultAgentId).toBe('a');
    });

    it('keeps the valid settings of each repository', () => {
        const settings = normalizeSettings({
            agents: [{ id: 'claude', name: 'Claude Code', command: 'claude' }],
            repos: {
                '/r/api': { name: ' API service ', agentId: 'claude', color: 'teal' },
                '/r/web': { agentId: 'removed-agent', color: 'neon' },
                relative: { name: 'x' }
            }
        });
        expect(settings.repos).toEqual({ '/r/api': { name: 'API service', agentId: 'claude', color: 'teal' } });
    });
});

describe('review owners', () => {
    it('keeps "all", a list of owners, or no choice', () => {
        expect(normalizeSettings({ reviewOwners: 'all' }).reviewOwners).toBe('all');
        expect(normalizeSettings({ reviewOwners: ['acme', 'acme', 7, ''] }).reviewOwners).toEqual(['acme']);
        expect(normalizeSettings({ reviewOwners: 'some' }).reviewOwners).toBeUndefined();
        expect(normalizeSettings({}).reviewOwners).toBeUndefined();
    });
});

describe('dashboard hidden authors', () => {
    it('keeps a list of names without empty items and duplicates', () => {
        expect(normalizeSettings({ dashboardHiddenAuthors: [' bot ', 'bot', '', 3] }).dashboardHiddenAuthors).toEqual(['bot']);
        expect(normalizeSettings({}).dashboardHiddenAuthors).toBeUndefined();
    });
});

describe('dashboard hidden rules', () => {
    it('keeps valid rules and removes bad ones', () => {
        const settings = normalizeSettings({
            dashboardHiddenRules: [
                { id: 'a', author: ' bot ', match: 'startsWith', text: 'Linked to' },
                { id: 'a', match: 'contains', text: 'duplicate id' },
                { id: 'b', match: 'glob', text: 'x' },
                { id: 'c', match: 'contains', text: '  ' },
                { id: 'd', author: '', match: 'regex', text: '^Deploy' }
            ]
        });
        expect(settings.dashboardHiddenRules).toEqual([
            { id: 'a', author: 'bot', match: 'startsWith', text: 'Linked to' },
            { id: 'd', match: 'regex', text: '^Deploy' }
        ]);
    });
});

describe('network settings', () => {
    it('keeps a trimmed file path and the keychain choice', () => {
        expect(normalizeSettings({ network: { caCertsFile: ' /certs/ca.pem ', useSystemCertificates: true } }).network)
            .toEqual({ caCertsFile: '/certs/ca.pem', useSystemCertificates: true });
        expect(normalizeSettings({ network: { caCertsFile: '  ', useSystemCertificates: 'yes' } }).network).toEqual({ useSystemCertificates: false });
        expect(normalizeSettings({}).network).toEqual({ useSystemCertificates: false });
    });
});

describe('repository scripts', () => {
    it('keeps scripts with an ID, a name and a command, in their order', () => {
        expect(normalizeScripts([
            { id: 'a', name: ' Test ', command: 'npm test\n' },
            { id: 'a', name: 'Duplicate', command: 'x' },
            { id: 'b', name: '', command: 'x' },
            { id: 'c', name: 'Empty', command: '  ' },
            { id: 'd', name: 'Two lines', command: 'npm ci\nnpm run build' }
        ])).toEqual([
            { id: 'a', name: 'Test', command: 'npm test' },
            { id: 'd', name: 'Two lines', command: 'npm ci\nnpm run build' }
        ]);
        expect(normalizeSettings({ repos: { '/r/api': { scripts: [{ id: 'a', name: 'Lint', command: 'npm run lint' }] } } }).repos['/r/api'].scripts)
            .toEqual([{ id: 'a', name: 'Lint', command: 'npm run lint' }]);
    });
});

describe('repository helpers', () => {
    const settings = normalizeSettings({
        agents: [{ id: 'claude', name: 'Claude Code', command: 'claude' }, { id: 'codex', name: 'Codex', command: 'codex' }],
        defaultAgentId: 'claude',
        repos: { '/r/api': { name: 'API', agentId: 'codex' } }
    });

    it('selects the agent of a repository, else the default agent', () => {
        expect(agentForRepo(settings, '/r/api').id).toBe('codex');
        expect(agentForRepo(settings, '/r/web').id).toBe('claude');
        expect(agentForRepo(settings, undefined).id).toBe('claude');
    });

    it('uses the name from the settings, else the folder name', () => {
        expect(repoDisplayName(settings, '/r/api')).toBe('API');
        expect(repoDisplayName(settings, '/Users/me/dev/web/')).toBe('web');
    });
});

describe('agentTitle', () => {
    it('uses the program name without its folder', () => {
        expect(commandProgram('claude --model opus')).toBe('claude');
        expect(agentTitle('claude --model opus')).toBe('claude');
        expect(agentTitle('/opt/homebrew/bin/codex --full-auto')).toBe('codex');
        expect(agentTitle('  ')).toBe('agent');
    });
});

describe('missingDefaultAgents', () => {
    it('offers the default agents that the list does not have', () => {
        const agents = [{ id: 'claude', name: 'Claude Code', command: 'claude' }, { id: 'agent-x', name: 'Codex fast', command: '/opt/bin/codex --full-auto' }];
        expect(missingDefaultAgents(agents)).toEqual([{ id: 'gemini', name: 'Gemini CLI', command: 'gemini' }]);
        expect(missingDefaultAgents(DEFAULT_AGENTS)).toEqual([]);
        // An agent of the user with the same program counts as present.
        expect(missingDefaultAgents([...agents, { id: 'g', name: 'Gemini', command: 'gemini --yolo' }])).toEqual([]);
    });
});
