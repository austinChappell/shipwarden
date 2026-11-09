import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { AskAgentRunner } from './ask-agent';

const base = { cwd: tmpdir(), env: {}, shell: '/bin/sh' };

describe('AskAgentRunner', () => {
    it('sends the prompt on stdin and returns the output', async () => {
        const runner = new AskAgentRunner();
        await expect(runner.run('a', { ...base, command: 'cat', prompt: 'hello\nworld' })).resolves.toBe('hello\nworld');
    });

    it('rejects with the errors when the command fails', async () => {
        const runner = new AskAgentRunner();
        await expect(runner.run('b', { ...base, command: "sh -c 'echo broken >&2; exit 3'", prompt: '' })).rejects.toThrow(/exit code 3\.[\s\S]*broken/);
    });

    it('rejects when the command gives no output', async () => {
        const runner = new AskAgentRunner();
        await expect(runner.run('c', { ...base, command: 'true', prompt: 'x' })).rejects.toThrow('The agent gave no answer.');
    });

    it('stops a run on cancel', async () => {
        const runner = new AskAgentRunner();
        const run = runner.run('d', { ...base, command: 'sleep 30', prompt: '' });
        setTimeout(() => runner.cancel('d'), 100);
        await expect(run).rejects.toThrow('The question was cancelled.');
    });

    it('stops a run after the time limit', async () => {
        const runner = new AskAgentRunner();
        await expect(runner.run('e', { ...base, command: 'sleep 30', prompt: '', timeoutMs: 100 })).rejects.toThrow('did not answer');
    });
});
