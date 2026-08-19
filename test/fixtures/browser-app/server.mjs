import { createServer } from "node:http";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html>
    <html><head><title>Arena fixture</title></head>
    <body><main><h1>browser-ready</h1><button>Continue</button></main>
    ${request.url === "/external" ? '<script>fetch("https://blocked.example/pixel")</script>' : ""}
    </body></html>`);
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
