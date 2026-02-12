import { handler } from "./http";

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);

const server = Bun.serve({
  hostname: host,
  port,
  fetch: handler
});

console.log(
  `[api] listening on http://${server.hostname}:${server.port} (dashboard dist: ${
    process.env.DASHBOARD_DIST_DIR ?? "../dashboard/dist"
  })`
);
