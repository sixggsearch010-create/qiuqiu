import { defineConfig } from "vite";

export default defineConfig({
    build: {
        rollupOptions: {
            input: {
                main: "index.html",
                game: "小游戏.html"
            }
        }
    },
    server: {
        host: "0.0.0.0"
    },
    preview: {
        host: "0.0.0.0"
    }
});
