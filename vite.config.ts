import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // React and the data layer change far less often than the dashboard's own code. In files of their own they
        // stay in the browser cache across deploys instead of being downloaded again with every change.
        manualChunks(id) {
          if (/node_modules[\\/](?:react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/node_modules[\\/](?:@tanstack|@trpc|superjson)[\\/]/.test(id)) return "data";
        },
      },
    },
  },
  server: {
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
