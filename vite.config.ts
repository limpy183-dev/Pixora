import { defineConfig } from 'vite';

// No error overlay: many modules are edited in parallel and main.ts already isolates a failing module.
export default defineConfig({ server: { port: 5173, hmr: { overlay: false } } });
