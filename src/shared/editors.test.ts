import { describe, expect, it } from 'vitest';
import { editorCommand, editorsOf, selectedEditor, type ExternalEditor } from './editors';

const vscode: ExternalEditor = {
    appPath: '/Applications/Visual Studio Code.app',
    name: 'Visual Studio Code',
    kind: 'vscode',
    cli: 'Contents/Resources/app/bin/code'
};
const zed: ExternalEditor = { appPath: '/Applications/Zed.app', name: 'Zed', kind: 'zed', cli: 'Contents/MacOS/cli' };
const webstorm: ExternalEditor = { appPath: '/Users/me/Applications/WebStorm.app', name: 'WebStorm', kind: 'jetbrains' };

describe('editorsOf', () => {
    it('finds the editors in the order of the catalog and ignores other apps', () => {
        const editors = editorsOf([
            '/Applications/Safari.app',
            '/Users/me/Applications/WebStorm.app',
            '/Applications/Zed.app',
            '/Applications/Visual Studio Code.app',
            '/Applications/Cursor.app'
        ]);
        expect(editors.map(editor => editor.name)).toEqual(['Visual Studio Code', 'Cursor', 'Zed', 'WebStorm']);
        expect(editors[0]).toEqual(vscode);
        expect(editors[3]).toEqual(webstorm);
    });

    it('finds the editions of the JetBrains IDEs', () => {
        const names = editorsOf([
            '/Applications/IntelliJ IDEA CE.app',
            '/Applications/PyCharm Professional Edition.app',
            '/Applications/Android Studio.app'
        ]).map(editor => editor.name);
        expect(names).toEqual(['IntelliJ IDEA CE', 'PyCharm Professional Edition', 'Android Studio']);
    });

    it('keeps the first app when two folders have the same app', () => {
        expect(editorsOf(['/Applications/Zed.app', '/Users/me/Applications/Zed.app']).map(editor => editor.appPath)).toEqual(['/Applications/Zed.app']);
    });

    it('does not match a longer name of a VS Code app', () => {
        expect(editorsOf(['/Applications/Visual Studio Code Helper.app', '/Applications/Cursor Agent.app'])).toEqual([]);
    });
});

describe('selectedEditor', () => {
    it('returns the editor of the settings, else the first editor', () => {
        expect(selectedEditor([vscode, zed], zed.appPath)).toBe(zed);
        expect(selectedEditor([vscode, zed], '/Applications/Removed.app')).toBe(vscode);
        expect(selectedEditor([vscode, zed], undefined)).toBe(vscode);
        expect(selectedEditor([], undefined)).toBeUndefined();
    });
});

describe('editorCommand', () => {
    const folder = '/w';
    const file = '/w/src/a.ts';

    it('opens the folder, and the file at a line with --goto, in VS Code', () => {
        const cli = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
        expect(editorCommand(vscode, { folder }, true)).toEqual({ command: cli, args: ['/w'] });
        expect(editorCommand(vscode, { folder, file, line: 12 }, true)).toEqual({ command: cli, args: ['/w', '--goto', '/w/src/a.ts:12'] });
        expect(editorCommand(vscode, { folder, file }, true)).toEqual({ command: cli, args: ['/w', '--goto', '/w/src/a.ts'] });
    });

    it('gives Zed the folder and the file with its line', () => {
        expect(editorCommand(zed, { folder, file, line: 3 }, true)).toEqual({
            command: '/Applications/Zed.app/Contents/MacOS/cli',
            args: ['/w', '/w/src/a.ts:3']
        });
    });

    it('uses open -na with --line for a JetBrains IDE', () => {
        expect(editorCommand(webstorm, { folder }, false)).toEqual({ command: 'open', args: ['-na', webstorm.appPath, '--args', '/w'] });
        expect(editorCommand(webstorm, { folder, file, line: 7 }, false)).toEqual({
            command: 'open',
            args: ['-na', webstorm.appPath, '--args', '/w', '--line', '7', '/w/src/a.ts']
        });
    });

    it('uses open -a without the line when the CLI is missing', () => {
        expect(editorCommand(vscode, { folder, file, line: 12 }, false)).toEqual({ command: 'open', args: ['-a', vscode.appPath, '/w/src/a.ts'] });
        expect(editorCommand(zed, { folder }, false)).toEqual({ command: 'open', args: ['-a', zed.appPath, '/w'] });
    });

    it('ignores a line that is not a positive number', () => {
        expect(editorCommand(zed, { folder, file, line: 0 }, true).args).toEqual(['/w', '/w/src/a.ts']);
    });
});
