import { describe, expect, it } from 'vitest';
import {
    groupProcesses,
    parseCwds,
    parseListeningPorts,
    parsePortName,
    parsePs,
    programName,
    worktreeOf,
    worktreePids,
    worktreeSummary,
    type ScanInput
} from './processes';

const PS = [
    '    1     0   0.0  1000 10-01:00:00 /sbin/launchd',
    '  100     1   0.5 20000    01:00:00 /Applications/ShipWarden.app/Contents/MacOS/ShipWarden',
    '  101   100   0.0  5000    01:00:00 node typescript-language-server --stdio',
    '  200     1   0.1  9000    02:00:00 /usr/local/bin/node pty-host.js',
    '  300   200   0.0  3000       10:00 -zsh',
    '  301   300   1.5 80000       09:00 npm run dev',
    '  302   301   0,7 90000       08:59 node /wt/a/node_modules/.bin/vite',
    '  303   302   0.0  4000       08:58 /wt/a/node_modules/esbuild --service',
    '  400   200   0.0  3000       05:00 /bin/zsh -l',
    '  500     1   0.0  7000       04:00 python3 -m http.server 8000',
    '  501   500   0.0  1000       04:00 python3 worker.py',
    '  600     1   0.0  2000       03:00 -zsh',
    '  700     1   0.0  2000       02:00 node /other/server.js'
].join('\n');

const LISTEN = ['p302', 'f22', 'n*:5173', 'f23', 'n[::1]:5173', 'p500', 'f3', 'n*:8000', 'p101', 'n127.0.0.1:9229'].join('\n');
const CWD = ['p300', 'fcwd', 'n/wt/a', 'p301', 'fcwd', 'n/wt/a', 'p400', 'fcwd', 'n/wt/b/src', 'p500', 'fcwd', 'n/wt/b',
    'p501', 'fcwd', 'n/wt/b', 'p600', 'fcwd', 'n/wt/b', 'p700', 'fcwd', 'n/other', 'p101', 'fcwd', 'n/wt/a'].join('\n');

function input(change: Partial<ScanInput> = {}): ScanInput {
    return {
        rows: parsePs(PS),
        ports: parseListeningPorts(LISTEN),
        cwds: parseCwds(CWD),
        sessions: [{ id: 's1', title: 'Shell', isAgent: false, worktreePath: '/wt/a', pid: 300, exited: false }],
        hostPid: 200,
        excludedPids: [100],
        worktreePaths: ['/wt/a', '/wt/b'],
        ...change
    };
}

describe('process parsing', () => {
    it('parses ps rows, also with a comma as the decimal mark', () => {
        const rows = parsePs(PS);
        expect(rows).toHaveLength(13);
        expect(rows[5]).toEqual({ pid: 301, ppid: 300, cpu: 1.5, rssKb: 80000, elapsed: '09:00', command: 'npm run dev' });
        expect(rows[6].cpu).toBe(0.7);
    });

    it('parses ports and keeps one entry for IPv4 and IPv6', () => {
        expect(parsePortName('[::1]:8080')).toEqual({ address: '::1', port: 8080 });
        expect(parsePortName('nothing')).toBeUndefined();
        expect(parseListeningPorts(LISTEN).get(302)).toEqual([{ address: '*', port: 5173 }]);
    });

    it('finds the program name', () => {
        expect(programName('-zsh')).toBe('zsh');
        expect(programName('/usr/local/bin/node server.js')).toBe('node');
    });

    it('finds the deepest worktree of a path', () => {
        expect(worktreeOf('/repo/.worktrees/x/src', ['/repo', '/repo/.worktrees/x'])).toBe('/repo/.worktrees/x');
        expect(worktreeOf('/repository', ['/repo'])).toBeUndefined();
    });
});

describe('groupProcesses', () => {
    it('puts the jobs of a terminal under its worktree, with the ports of the whole tree', () => {
        const [a] = groupProcesses(input());
        expect(a.terminals).toHaveLength(1);
        const [job] = a.terminals[0].jobs;
        expect(job.root.pid).toBe(301);
        expect(job.descendants.map(item => item.pid)).toEqual([302, 303]);
        expect(job.ports.map(port => port.port)).toEqual([5173]);
        expect(a.terminals[0].title).toBe('Shell');
    });

    it('uses the working folder for a shell without a known session', () => {
        const [, b] = groupProcesses(input());
        expect(b.terminals.map(item => item.shellPid)).toEqual([400]);
        expect(b.terminals[0].jobs).toEqual([]);
    });

    it('shows other processes of the folder, but not shells, nested processes or ShipWarden', () => {
        const [a, b] = groupProcesses(input());
        expect(a.others).toEqual([]);
        expect(b.others.map(item => item.root.pid)).toEqual([500]);
        expect(b.others[0].descendants.map(item => item.pid)).toEqual([501]);
    });

    it('lists all PIDs to stop and a summary', () => {
        const [, b] = groupProcesses(input());
        expect(worktreePids(b, { includeOthers: true })).toEqual([500, 501]);
        expect(worktreePids(b, { includeOthers: false })).toEqual([]);
        expect(worktreeSummary(b)).toEqual({ processes: 1, ports: [8000] });
    });
});
