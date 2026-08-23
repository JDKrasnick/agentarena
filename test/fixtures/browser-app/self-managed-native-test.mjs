import { createServer } from "node:http";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

try {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) throw new Error("BASE_URL was not supplied");
  if (new URL(baseUrl).port !== String(port))
    throw new Error("BASE_URL and PORT do not identify the same runtime");
  const response = await fetch(baseUrl);
  if (!response.ok)
    throw new Error(`Self-managed native suite failed: ${response.status}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
