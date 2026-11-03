#!/usr/bin/env node
// Test helper: a minimal reverse proxy that serves T3 under a path prefix, like nginx would:
//   location /chat/ { proxy_pass http://127.0.0.1:3774/; proxy_http_version 1.1; Upgrade headers }
// Usage: node prefix-proxy.mjs [--prefix /chat] [--listen 3775] [--target 3774]
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const prefix = `/${arg("prefix", "/chat").replace(/^\/+|\/+$/g, "")}`;
const listen = Number(arg("listen", "3775"));
const target = Number(arg("target", "3774"));
const strip = (url) =>
  url === prefix
    ? "/"
    : url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)
      ? url.slice(prefix.length) || "/"
      : null;

const server = NodeHttp.createServer((req, res) => {
  const path = strip(req.url);
  if (path === null) return void res.writeHead(404).end("outside prefix");
  const up = NodeHttp.request(
    { host: "127.0.0.1", port: target, path, method: req.method, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => res.writeHead(502).end());
  req.pipe(up);
});
server.on("upgrade", (req, socket, head) => {
  const path = strip(req.url);
  if (path === null) return void socket.destroy();
  const up = NodeNet.connect(target, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    up.write(`${req.method} ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(listen, "127.0.0.1", () =>
  console.log(`prefix proxy ${prefix} on 127.0.0.1:${listen} -> ${target}`),
);
