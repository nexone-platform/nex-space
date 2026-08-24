import { defineConfig } from "vite";

import { resolve } from "path";

export default defineConfig({
  server: { port: 5173, host: true },
  build: {
    target: "es2020",
    rollupOptions: {
      // Two pages, not one app with a route. The editor needs none of the game:
      // no Phaser, no session, no media stack — so it should not download them.
      input: {
        main: resolve(__dirname, "index.html"),
        editor: resolve(__dirname, "editor.html"),
        admin: resolve(__dirname, "admin.html"),
      },
    },
  },
});
