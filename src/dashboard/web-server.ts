import { createReadStream, existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArenaBattleControl } from "../observability/control.js";
import type { ArenaObserver } from "../observability/events.js";
import { DashboardObserver } from "./state.js";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function webRoot(): string {
  const workspaceBuild = path.resolve(process.cwd(), "dist/web");
  if (existsSync(path.join(workspaceBuild, "index.html")))
    return workspaceBuild;
  return fileURLToPath(new URL("../web", import.meta.url));
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export interface WebDashboard {
  readonly url: string;
  readonly observer: ArenaObserver;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

export async function startWebDashboard(
  control: ArenaBattleControl,
): Promise<WebDashboard> {
  const state = new DashboardObserver();
  const clients = new Set<ServerResponse>();
  const root = webRoot();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing = false;
  let allowedOrigin = "";
  let closeDashboard: () => Promise<void> = async () => {};
  const emitSnapshot = () => {
    const message = `data: ${JSON.stringify(state.snapshot())}\n\n`;
    for (const client of clients) client.write(message);
  };
  state.subscribe(emitSnapshot);

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    try {
      if (request.headers.origin && request.headers.origin !== allowedOrigin) {
        sendJson(response, 403, { error: "Cross-origin request denied" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, state.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        clients.add(response);
        response.write(`data: ${JSON.stringify(state.snapshot())}\n\n`);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cancel") {
        control.cancel(new Error("Cancelled from desktop observatory"));
        sendJson(response, 202, { status: "cancelling" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/close") {
        sendJson(response, 202, { status: "closing" });
        setImmediate(() => void closeDashboard());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/steer") {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 415, { error: "Expected application/json" });
          return;
        }
        let body: unknown;
        try {
          body = await requestBody(request);
        } catch {
          sendJson(response, 400, { error: "Invalid JSON request body" });
          return;
        }
        if (
          !body ||
          typeof body !== "object" ||
          !("contestantId" in body) ||
          !("note" in body) ||
          (body.contestantId !== "a" && body.contestantId !== "b") ||
          typeof body.note !== "string" ||
          !body.note.trim()
        ) {
          sendJson(response, 400, { error: "Invalid steering request" });
          return;
        }
        const intervention = control.queueSteering(
          body.contestantId,
          body.note,
        );
        sendJson(response, 202, intervention);
        return;
      }
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      const relative =
        url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      let decoded: string;
      try {
        decoded = decodeURIComponent(relative);
      } catch {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const file = path.resolve(root, decoded);
      if (!file.startsWith(`${root}${path.sep}`) || !existsSync(file)) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const extension = path.extname(file);
      response.writeHead(200, {
        "Content-Type": contentTypes[extension] ?? "application/octet-stream",
        "Cache-Control":
          extension === ".html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
      createReadStream(file).pipe(response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Dashboard error",
      });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine dashboard address");
  }
  const url = `http://127.0.0.1:${String(address.port)}`;
  allowedOrigin = url;
  closeDashboard = async () => {
    if (closing) {
      await closed;
      return;
    }
    closing = true;
    for (const client of clients) client.end();
    clients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    resolveClosed();
  };

  return {
    url,
    observer: state,
    close: closeDashboard,
    waitUntilClosed: () => closed,
  };
}
