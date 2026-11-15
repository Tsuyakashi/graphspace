import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке интерфейс идёт через Vite, а /api и /craft проксируются на сервер: origin остаётся один,
// как того требует мост Craft.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  server: { port: 4681, proxy: { '/api': 'http://127.0.0.1:4680', '/craft': 'http://127.0.0.1:4680' } },
  build: { chunkSizeWarningLimit: 4000 },
});
