// Burst 5 §2b Task 2b.5: GET /ui/approvals/:id must attach a
// `session_affordance` field for bootstrap-action grants whose batch resolves
// to ≥1 derived pattern OR ≥1 excluded destination, and OMIT it otherwise
// (non-bootstrap grants, missing/expired batches, both-empty results). The
// client-side renderer in ui.html hides the affordance when the field is
// absent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "../api/router.js";
import { RecipeRegistry } from "../recipes/registry.js";

// ── shared harness (mirrors approval-ui-creates-sessions.test.ts) ───────────
// A separate task chip already tracks extracting these helpers into a shared
// module; copying inline here keeps Task 2b.5's scope focused on the render
// path.

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-ui-session-affordance-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  const server = new DaemonServer({ token: "t" });
  // Inject an empty RecipeRegistry so vercel:* shorthands resolve to template
  // destinations, not browser_inject. Without this, inferSessionPatternFromPlan
  // skips browser_inject destinations and returns no patterns — breaking the
  // session_affordance tests that expect vercel-env-add patterns.
  const services = new DaemonServices({ recipes: new RecipeRegistry() });
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services, home });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(
  ctx: { port: number; token: string },
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function unlockVault(ctx: { port: number; token: string }): Promise<void> {
  const r = await call(ctx, "POST", "/v1/unlock", { passphrase: "testpass", set_passphrase: true });
  assert.equal(r.status, 200, `unlock failed: ${JSON.stringify(r.body)}`);
}

/**
 * Mint a bootstrap-action approval whose batch has at least 2 distinct
 * destinations (vercel:production + vercel:preview on the same secret). After
 * dedup-by-pattern in inferSessionPatternFromPlan, the resulting affordance
 * carries ≥2 patterns — both with template_id "vercel-env-add".
 */
async function mintBootstrapApproval(
  ctx: { port: number; token: string; services: DaemonServices },
): Promise<{ approvalId: string; uiToken: string }> {
  const yml = `
version: 1
secrets:
  API_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production", "vercel:preview"]
`;
  const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
  assert.equal(r.status, 400, `expected 400 approval_required, got ${r.status} body=${JSON.stringify(r.body)}`);
  const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
  const approvalId = details.approvals[0]!.approval_id;
  const grant = ctx.services.approvals.get(approvalId);
  assert.ok(grant !== undefined, "minted approval must exist in store");
  return { approvalId, uiToken: grant!.ui_token };
}

// ── tests ───────────────────────────────────────────────────────────────────

test("GET /ui/approvals/:id of a bootstrap-action grant returns session_affordance with derived patterns", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);
    const { approvalId, uiToken } = await mintBootstrapApproval(ctx);

    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/approvals/${approvalId}?token=${uiToken}`);
    assert.equal(res.status, 200, `GET failed: status=${res.status}`);
    const body = (await res.json()) as {
      session_affordance?: {
        patterns: Array<{ template_id: string | null; ref_glob: string; required_params: Record<string, string> }>;
        excluded: Array<{ secret: string; template_id: string }>;
      };
    };

    assert.ok(body.session_affordance !== undefined, "session_affordance must be present for bootstrap-action grants");
    const aff = body.session_affordance!;
    assert.ok(Array.isArray(aff.patterns), "patterns must be an array");
    assert.ok(aff.patterns.length >= 1, `expected ≥1 derived pattern, got ${aff.patterns.length}`);
    assert.ok(Array.isArray(aff.excluded), "excluded must be an array");

    // vercel-env-add is registered, so the patterns must surface its template_id.
    const templateIds = new Set(aff.patterns.map((p) => p.template_id));
    assert.ok(
      templateIds.has("vercel-env-add"),
      `expected vercel-env-add in pattern template_ids, got ${JSON.stringify([...templateIds])}`,
    );
    // The ref_glob field must be the exact ref (no glob collapsing — see infer-session-pattern.ts invariant).
    for (const p of aff.patterns) {
      assert.ok(typeof p.ref_glob === "string" && p.ref_glob.length > 0, `pattern.ref_glob must be non-empty: ${JSON.stringify(p)}`);
      assert.ok(typeof p.required_params === "object" && p.required_params !== null, "pattern.required_params must be an object");
    }
    // vercel-env-add declares sessionDefiningParams = ["name", "environment"]
    // (src/daemon/templates/builtin/vercel-env-add.ts). The derived
    // required_params for every vercel-env-add pattern MUST surface both
    // — guards against regressions in the param-extraction loop in
    // inferSessionPatternFromPlan.
    for (const p of aff.patterns) {
      if (p.template_id === "vercel-env-add") {
        assert.ok("name" in p.required_params, `vercel-env-add pattern must carry required_params.name; got ${JSON.stringify(p.required_params)}`);
        assert.ok("environment" in p.required_params, `vercel-env-add pattern must carry required_params.environment; got ${JSON.stringify(p.required_params)}`);
        assert.equal(p.required_params["name"], "API_KEY", "required_params.name must match the secret name from the plan");
      }
    }
  });
});

test("GET /ui/approvals/:id of a non-bootstrap grant omits session_affordance", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);
    // Mint a non-bootstrap grant directly via the in-process store. This
    // mirrors the pattern in src/daemon/api/routes.test.ts (blind_end /
    // template / inject minting). action !== "bootstrap" must skip the
    // batch-lookup path entirely.
    const grant = ctx.services.approvals.create({
      action: "blind_end",
      ref: null,
      environment: "blind",
      destination_domain: "example.com",
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
    });

    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/approvals/${grant.id}?token=${grant.ui_token}`);
    assert.equal(res.status, 200, `GET failed: status=${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(
      !("session_affordance" in body),
      `non-bootstrap grant must omit session_affordance; got body keys=${JSON.stringify(Object.keys(body))}`,
    );
  });
});
