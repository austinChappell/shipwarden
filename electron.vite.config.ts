import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Monaco keeps its own copy of DOMPurify (vs/base/browser/dompurify/dompurify.js) and imports it with a relative path.
 * npm does not update that copy, and the copy in monaco-editor 0.57.0 (3.4.15) has known XSS issues.
 * This plugin replaces the copy with the dompurify package of the app. The "overrides" field in package.json keeps that
 * package at a fixed version for Monaco too.
 */
function monacoDomPurify(): Plugin {
    return {
        name: 'monaco-dompurify',
        enforce: 'pre',
        async resolveId(source, importer, options) {
            if (source !== './dompurify/dompurify.js' || !importer?.replace(/\\/g, '/').includes('/monaco-editor/esm/vs/base/browser/')) {
                return null;
            }
            const resolved = await this.resolve('dompurify', importer, { ...options, skipSelf: true });
            if (!resolved) {
                this.error('The dompurify package was not found. Monaco needs it instead of its own copy.');
            }
            return resolved;
        }
    };
}

export default defineConfig({
    main: {
        resolve: { alias: { '@shared': resolve('src/shared') } },
        build: {
            rollupOptions: {
                // The PTY host and the background helper are other programs. Each runs as a separate process.
                input: {
                    index: resolve('src/main/index.ts'),
                    'pty-host': resolve('src/main/pty-host/main.ts'),
                    helper: resolve('src/main/helper/main.ts')
                }
            }
        }
    },
    preload: {
        resolve: { alias: { '@shared': resolve('src/shared') } }
    },
    renderer: {
        resolve: { alias: { '@shared': resolve('src/shared') } },
        plugins: [react(), monacoDomPurify()]
    }
});
