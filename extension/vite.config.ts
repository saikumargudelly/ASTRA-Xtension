import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx, ManifestV3Export } from '@crxjs/vite-plugin';
import manifest from './public/manifest.json';

export default defineConfig({
    plugins: [
        react(),
        crx({ manifest: manifest as ManifestV3Export }),
    ],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        strictPort: true,
        hmr: {
            port: 5173,
        },
    },
});
