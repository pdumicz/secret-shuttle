import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { DaemonServer } from "./server.js";

/** Send a raw HTTP/1.1 request over a plain TCP socket and return the status code. */
function rawHttpGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    const request = `GET ${path} HTTP/1.1\r\n${headerLines}\r\nConnection: close\r\n\r\n`;
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(request);
    });
    let response = "";
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("end", () => {
      const statusLine = response.split("\r\n")[0] ?? "";
      const match = /HTTP\/1\.1 (\d+)/.exec(statusLine);
      resolve(match !== null ? parseInt(match[1] ?? "0", 10) : 0);
    });
    socket.on("error", reject);
  });
}

async function httpJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
}

test("server requires bearer token", async () => {
  const server = new DaemonServer({ token: "secret-token" });
  server.addRoute("GET", "/v1/status", () => ({ unlocked: false }));
  const { port } = await server.listen();
  try {
    const a = await httpJson(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(a.status, 401);

    const b = await httpJson(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(b.status, 200);
  } finally {
    await server.close();
  }
});

test("server rejects non-loopback Host header", async () => {
  const server = new DaemonServer({ token: "t" });
  server.addRoute("GET", "/v1/status", () => ({}));
  const { port } = await server.listen();
  try {
    // Node's fetch (undici) refuses to override Host; use a raw TCP socket instead.
    const status = await rawHttpGet(port, "/v1/status", {
      Host: "evil.example.com",
      Authorization: "Bearer t",
    });
    assert.equal(status, 400);
  } finally {
    await server.close();
  }
});

test("server returns 404 for unknown routes", async () => {
  const server = new DaemonServer({ token: "t" });
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { Authorization: "Bearer t" },
    });
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test("server parses POST JSON body and wraps response in ok envelope", async () => {
  const server = new DaemonServer({ token: "t" });
  server.addRoute("POST", "/v1/echo", (_req, body) => ({ echo: body }));
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/echo`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ hi: 1 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; echo: { hi: number } };
    assert.equal(body.ok, true);
    assert.deepEqual(body.echo, { hi: 1 });
  } finally {
    await server.close();
  }
});

test("server raw routes skip bearer auth and let handler write the response", async () => {
  const server = new DaemonServer({ token: "t" });
  server.addRouteRaw("GET", /^\/ui\/hello$/, (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end("hi");
  });
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ui/hello`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hi");
  } finally {
    await server.close();
  }
});

test("ShuttleError from a route handler becomes a 400 JSON error", async () => {
  const { ShuttleError } = await import("../shared/errors.js");
  const server = new DaemonServer({ token: "t" });
  server.addRoute("POST", "/v1/fail", () => { throw new ShuttleError("bad_thing", "no good"); });
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/fail`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "bad_thing");
  } finally {
    await server.close();
  }
});
