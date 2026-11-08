import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    main: {
        resolve: { alias: { '@shared': resolve('src/shared') } },
        build: {
            rollupOptions: {
                // The PTY host is a second program. The app starts it as a separate process.
                input: {
                    index: resolve('src/main/index.ts'),
                    'pty-host': resolve('src/main/pty-host/main.ts')
                }
            }
        }
    },
    preload: {
        resolve: { alias: { '@shared': resolve('src/shared') } }
    },
    renderer: {
        resolve: { alias: { '@shared': resolve('src/shared') } },
        plugins: [react()]
    }
});
