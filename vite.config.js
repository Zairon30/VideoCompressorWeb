import { defineConfig } from 'vite'

export default defineConfig({
  // ffmpeg.wasm spawns its own worker; don't let Vite pre-bundle it.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
})
