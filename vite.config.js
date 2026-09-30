import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three', 'three-mesh-bvh'] },
  build: { chunkSizeWarningLimit: 1200 },
});
