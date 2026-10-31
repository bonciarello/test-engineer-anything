import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort =
    typeof address === "object" && address !== null ? address.port : port;
  console.log(`TEA example listening on http://127.0.0.1:${listeningPort}`);
});
