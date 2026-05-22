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

/** Like rawHttpGet but parses the JSON body too. Used when we need to assert the response shape. */
function rawHttpGetWithBody(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
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
      const status = match !== null ? parseInt(match[1] ?? "0", 10) : 0;
      const split = response.indexOf("\r\n\r\n");
      const bodyText = split >= 0 ? response.slice(split + 4) : "";
      let body: unknown = null;
      try { body = bodyText.length > 0 ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
      resolve({ status, body });
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

test("server refuses bodies over 1 MB", async () => {
  const server = new DaemonServer({ token: "t" });
  server.addRoute("POST", "/v1/big", () => ({}));
  const { port } = await server.listen();
  try {
    const huge = Buffer.alloc(2 * 1024 * 1024, "x");
    const res = await fetch(`http://127.0.0.1:${port}/v1/big`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.error.code, "request_too_large");
  } finally {
    await server.close();
  }
});

test("server reports invalid_json instead of 500 on malformed body", async () => {
  const server = new DaemonServer({ token: "t" });
  server.addRoute("POST", "/v1/echo", () => ({}));
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/echo`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.error.code, "invalid_json");
  } finally {
    await server.close();
  }
});

// ─── §5.6 structured-error contract on pre-handler short-circuits ────────────
// bad_host / unauthorized / not_found must emit the full nested + flat shape
// (legacy `error: {code, message}` + flat `error_code`, `message`, `hint`,
// `exit_code`) per spec §5.6. HTTP status codes 400 / 401 / 404 preserved.

test("bad host header → 400 with full §5.6 error contract", async () => {
  const server = new DaemonServer({ token: "tok" });
  server.addRoute("GET", "/v1/health", () => ({}));
  const { port } = await server.listen();
  try {
    // Node's fetch (undici) refuses to override Host; raw TCP socket required.
    const { status, body } = await rawHttpGetWithBody(port, "/v1/health", {
      Host: "evil.example.com",
      Authorization: "Bearer tok",
    });
    assert.equal(status, 400);
    const j = body as {
      ok: boolean;
      error: { code: string; message: string };
      error_code: string;
      message: string;
      hint: string | null;
      exit_code: number;
    };
    assert.equal(j.ok, false);
    assert.equal(j.error.code, "bad_host");
    assert.ok(typeof j.error.message === "string" && j.error.message.length > 0, "nested error.message should be non-empty");
    assert.equal(j.error_code, "bad_host");
    assert.ok(typeof j.message === "string" && j.message.length > 0, "flat message should be non-empty");
    assert.equal(j.exit_code, 4); // EXIT_CODE_PERMISSION
  } finally {
    await server.close();
  }
});

test("missing bearer token → 401 with full §5.6 error contract", async () => {
  const server = new DaemonServer({ token: "tok" });
  server.addRoute("GET", "/v1/health", () => ({}));
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(res.status, 401);
    const j = await res.json() as {
      ok: boolean;
      error: { code: string; message: string };
      error_code: string;
      message: string;
      hint: string | null;
      exit_code: number;
    };
    assert.equal(j.ok, false);
    assert.equal(j.error.code, "unauthorized");
    assert.ok(typeof j.error.message === "string" && j.error.message.length > 0, "nested error.message should be non-empty");
    assert.equal(j.error_code, "unauthorized");
    assert.ok(typeof j.message === "string" && j.message.length > 0, "flat message should be non-empty");
    assert.equal(j.exit_code, 4); // EXIT_CODE_PERMISSION
  } finally {
    await server.close();
  }
});

test("unknown route → 404 with full §5.6 error contract", async () => {
  const server = new DaemonServer({ token: "tok" });
  const { port } = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/nope`, {
      headers: { Authorization: "Bearer tok" },
    });
    assert.equal(res.status, 404);
    const j = await res.json() as {
      ok: boolean;
      error: { code: string; message: string };
      error_code: string;
      message: string;
      hint: string | null;
      exit_code: number;
    };
    assert.equal(j.ok, false);
    assert.equal(j.error.code, "not_found");
    assert.ok(typeof j.error.message === "string" && j.error.message.length > 0, "nested error.message should be non-empty");
    assert.equal(j.error_code, "not_found");
    assert.ok(typeof j.message === "string" && j.message.length > 0, "flat message should be non-empty");
    assert.equal(j.exit_code, 3); // EXIT_CODE_NOT_FOUND
  } finally {
    await server.close();
  }
});

// ─── addRouteStreaming ────────────────────────────────────────────────────────

async function setUpServer(): Promise<{ server: DaemonServer; url: string; token: string; stop: () => Promise<void> }> {
  const token = "test-token-1234";
  const server = new DaemonServer({ token });
  const { port } = await server.listen(0);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    token,
    stop: () => server.close(),
  };
}

test("addRouteStreaming: 200 with chunked body when auth + Host valid", async () => {
  const { server, url, token, stop } = await setUpServer();
  server.addRouteStreaming("POST", "/v1/test", async (_req, body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-ndjson");
    res.flushHeaders();
    res.write(JSON.stringify({ chunk: 1, echo: body }) + "\n");
    res.write(JSON.stringify({ chunk: 2 }) + "\n");
    res.end();
  });
  try {
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), { chunk: 1, echo: { hello: "world" } });
    assert.deepEqual(JSON.parse(lines[1]!), { chunk: 2 });
  } finally {
    await stop();
  }
});

test("addRouteStreaming: missing bearer token → 401 with structured error (handler NOT invoked)", async () => {
  const { server, url, stop } = await setUpServer();
  let handlerCalls = 0;
  server.addRouteStreaming("POST", "/v1/test", async (_req, _body, res) => {
    handlerCalls += 1;
    res.statusCode = 200;
    res.end();
  });
  try {
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 401);
    const json = await r.json() as Record<string, unknown>;
    assert.equal((json.error as { code: string }).code, "unauthorized");
    assert.equal(json.error_code, "unauthorized");
    assert.equal(handlerCalls, 0, "handler MUST NOT be invoked when bearer missing");
  } finally {
    await stop();
  }
});

test("addRouteStreaming: bad Host header → 400 with structured error", async () => {
  const { server, url, token, stop } = await setUpServer();
  let handlerCalls = 0;
  server.addRouteStreaming("POST", "/v1/test", async (_req, _body, res) => {
    handlerCalls += 1;
    res.statusCode = 200;
    res.end();
  });
  try {
    // The fetch API doesn't easily let us spoof Host, so test by hand-crafting a
    // request via net.connect — or use a node:http client and override headers.
    const { request } = await import("node:http");
    const port = Number(new URL(url).port);
    const responseBody: string = await new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/test",
        headers: {
          Authorization: `Bearer ${token}`,
          Host: "evil.example.com:1234",
          "content-type": "application/json",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.write(JSON.stringify({}));
      req.end();
    });
    const json = JSON.parse(responseBody) as Record<string, unknown>;
    assert.equal((json.error as { code: string }).code, "bad_host");
    assert.equal(json.error_code, "bad_host");
    assert.equal(handlerCalls, 0, "handler MUST NOT be invoked when Host bad");
  } finally {
    await stop();
  }
});

test("addRouteStreaming: oversize body → request_too_large (handler NOT invoked)", async () => {
  const { server, url, token, stop } = await setUpServer();
  let handlerCalls = 0;
  server.addRouteStreaming("POST", "/v1/test", async (_req, _body, res) => {
    handlerCalls += 1;
    res.statusCode = 200;
    res.end();
  });
  try {
    const huge = "x".repeat(2 * 1024 * 1024); // 2 MB > 1 MB cap
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ blob: huge }),
    });
    const json = await r.json() as Record<string, unknown>;
    assert.equal((json.error as { code: string }).code, "request_too_large");
    assert.equal(handlerCalls, 0, "handler MUST NOT be invoked when body oversize");
  } finally {
    await stop();
  }
});
