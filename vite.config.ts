import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 3000
  }
})
