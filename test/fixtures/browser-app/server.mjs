import { createServer } from "node:http";
import { createHash } from "node:crypto";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (
    url.pathname === "/dom-xss-vulnerable" ||
    url.pathname === "/dom-xss-safe"
  ) {
    const sink =
      url.pathname === "/dom-xss-vulnerable" ? "innerHTML" : "textContent";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <html><body><main>
        <label for="message">Message</label><input id="message">
        <button id="render">Render</button><div id="output"></div>
      </main><script>
        document.querySelector('#render').addEventListener('click', () => {
          document.querySelector('#output').${sink} = document.querySelector('#message').value;
        });
      </script></body></html>`);
    return;
  }
  const websocketPort = Number(url.searchParams.get("port"));
  const websocketScript =
    url.pathname === "/external-websocket" &&
    Number.isInteger(websocketPort) &&
    websocketPort > 0
      ? `<script>new WebSocket("ws://127.0.0.1:${String(websocketPort)}")</script>`
      : "";
  const sameOriginWebSocketScript =
    url.pathname === "/same-origin-websocket"
      ? `<script>
          const socket = new WebSocket("ws://" + location.host + "/socket");
          socket.addEventListener("open", () => {
            document.querySelector("h1").textContent = "socket-ready";
          });
        </script>`
      : "";
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html>
    <html><head><title>Arena fixture</title></head>
    <body><main>
      <h1>browser-ready</h1>
      <label>Wrapped label <input></label>
      <span id="labelled-name">Labelled name</span>
      <input aria-labelledby="labelled-name">
      <button><img alt="Continue"></button>
    </main>
    ${url.pathname === "/external" ? '<script>fetch("https://blocked.example/pixel")</script>' : ""}
    ${websocketScript}
    ${sameOriginWebSocketScript}
    </body></html>`);
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/socket") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
