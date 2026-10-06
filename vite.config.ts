import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { defineConfig, type Plugin } from "vite";

// Local development: serve /api/v1 from the same router the Netlify Function
// uses, backed by an embedded Postgres in ./.local-db and development sign-in.
function localApi(): Plugin {
  let deps: Promise<{ handle: typeof import("./src/server/api").handle; db: import("./src/server/db").Db; auth: import("./src/server/auth").Authenticator }> | null = null;
  return {
    name: "workbench-local-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/v1")) return next();
        deps ??= (async () => {
          const { openLocalDb } = await server.ssrLoadModule("/src/server/local-db.ts");
          const { handle } = await server.ssrLoadModule("/src/server/api.ts");
          const { devAuthenticator } = await server.ssrLoadModule("/src/server/auth.ts");
          const { db } = await openLocalDb(process.env.WORKBENCH_DB_DIR ?? "./.local-db");
          return { handle, db, auth: devAuthenticator() };
        })();
        const { handle, db, auth } = await deps;
        const body = await readBody(req);
        const request = new Request(`http://localhost${req.url}`, {
          method: req.method, headers: req.headers as Record<string, string>, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body,
        });
        const response = await handle(request, { db, authenticate: auth });
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default defineConfig({
  plugins: [react(), localApi()],
  build: { outDir: "dist", sourcemap: false },
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
});
