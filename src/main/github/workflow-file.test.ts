import { describe, expect, it } from 'vitest';
import { dispatchInputs } from '@shared/pipelines';
import { parseWorkflowFile } from './workflow-file';

describe('parseWorkflowFile', () => {
    it('reads the inputs of a workflow_dispatch trigger', () => {
        const text = `
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: Where to deploy
        required: true
        type: choice
        options: [staging, production]
        default: staging
      dry_run:
        type: boolean
        default: true
      note:
        description: A note
jobs: {}
`;
        expect(parseWorkflowFile(text)).toEqual({
            dispatchable: true,
            inputs: [
                { name: 'environment', description: 'Where to deploy', required: true, type: 'choice', default: 'staging', options: ['staging', 'production'] },
                { name: 'dry_run', required: false, type: 'boolean', default: 'true' },
                { name: 'note', description: 'A note', required: false, type: 'string' }
            ]
        });
    });

    it('finds the trigger in the short forms, and no trigger in other files', () => {
        expect(parseWorkflowFile('on: workflow_dispatch')).toEqual({ dispatchable: true, inputs: [] });
        expect(parseWorkflowFile('on: [push, workflow_dispatch]')).toEqual({ dispatchable: true, inputs: [] });
        expect(parseWorkflowFile('on:\n  workflow_dispatch:\n')).toEqual({ dispatchable: true, inputs: [] });
        expect(parseWorkflowFile('on: [push]')).toEqual({ dispatchable: false, inputs: [] });
        expect(parseWorkflowFile('on: {{ bad')).toEqual({ dispatchable: false, inputs: [] });
    });
});

describe('dispatchInputs', () => {
    const inputs = [
        { name: 'environment', required: true, type: 'choice', default: 'staging', options: ['staging', 'production'] },
        { name: 'dry_run', required: false, type: 'boolean', default: 'true' },
        { name: 'note', required: false, type: 'string' },
        { name: 'ticket', required: true, type: 'string' }
    ];

    it('uses the form values, else the defaults', () => {
        expect(dispatchInputs(inputs, { ticket: 'ENG-1', dry_run: 'false' })).toEqual({ inputs: { environment: 'staging', dry_run: 'false', ticket: 'ENG-1' } });
    });

    it('refuses an empty required input', () => {
        expect(dispatchInputs(inputs, { ticket: '  ' })).toEqual({ error: 'The input "ticket" needs a value.' });
    });
});
