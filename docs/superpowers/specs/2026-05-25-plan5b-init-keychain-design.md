# Plan 5b + 5f-impl — Real `init` + Working OS Keychain Design

**Status:** Approved, ready for plan-writing.

**Goal:** `npx secret-shuttle init` becomes the canonical first-run command. After ~30 seconds and one passphrase entry (first time only) + one Touch ID enrollment, the dev never sees a passphrase prompt again under normal use. Subsequent unlocks: Touch ID on macOS, libsecret prompt on Linux, DPAPI/Windows Hello on Windows. Today the keychain module is structurally complete but all platform classes are stubs that throw `keychain_not_implemented`; the unlock flow runs entirely through the browser passphrase UI. This plan ships the real implementations + the integration layer.

---

## Architecture

**Two coupled sub-tasks** that ship together:

- **5f-impl** — replace stub `DarwinKeychain` / `LinuxKeychain` / `WindowsKeychain` with real implementations backed by `@napi-rs/keyring`. The stub `KeychainAdapter` interface already exists at `src/vault/keychain/types.ts` and is correctly factored — no API redesign needed.
- **5b** — wire the keychain into `POST /v1/unlock/start` (try-keychain-first → fall back to passphrase UI), give `secret-shuttle init` a real interactive first-run flow (daemon spawn + envelope create + keychain enrollment + agent runtime install), add `keychain enable` / `keychain disable` for explicit re-enrollment / opt-out.

**UX model: passphrase-canonical, keychain-as-cache.** The passphrase remains the recovery credential (matches 1Password / Bitwarden / etc.). Loss of device or keychain corruption → fall through to passphrase UI → re-enroll keychain after. The user can always recover by re-entering the passphrase.

**Vault identifier**: a UUID stored as a new field `id` on `EnvelopeFile`. Minted on first envelope write; persists forever. Used as the keychain account key `("secret-shuttle", <uuid>)`. Existing envelopes lacking `id` get one minted transparently on first `readEnvelope` after upgrade.

---

## Components

### 1. Native module choice — `@napi-rs/keyring`

Locked. The existing stub comments at `src/vault/keychain/darwin.ts:6-11` cite it explicitly and reject the alternatives. Properties that matter:

- Native bindings via `napi-rs` — no `.node` build step needed by consumers (prebuilds shipped per platform).
- Memory-only API (`getPassword(service, account)` / `setPassword` / `deletePassword`) — no argv leakage.
- Maintained, widely used (Next.js team uses it).
- Buffer-friendly: we store a 32-byte random master key, base64-encoded going over the keychain API.

Rejected:
- `keytar` — unmaintained, N-API V1.
- Building our own FFI — not worth it for three platforms.
- Shell-CLI wrappers (`security`, `secret-tool`, PowerShell credential cmdlets) — argv-recoverable via `ps`; deliberately rejected by the existing stub comments.

Bundle prebuilds for `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`. Unsupported platforms (`linux-ia32`, etc.) fall through to the existing `UnsupportedKeychain` (returns `isAvailable: false`; ops throw `keychain_not_implemented`).

### 2. Vault identifier in envelope

**File:** `src/vault/envelope.ts`

Today's `EnvelopeFile`:
```ts
{ version: 2, salt: string, iv: string, ciphertext: string }
```

Extended:
```ts
{ version: 2, id: string, salt: string, iv: string, ciphertext: string }
```

Generation logic:
- `writeEnvelope`: if `id` is missing on the input, mint a fresh UUIDv4 before write.
- `readEnvelope`: if the parsed envelope lacks `id`, mint one and write back transparently — preserves existing-vault compatibility without a separate migration command.

`getKeychainAccount(envelope: EnvelopeFile): string` returns `envelope.id`. The pair is always `("secret-shuttle", <uuid>)`.

### 3. Keychain adapter implementations

**Files:** `src/vault/keychain/darwin.ts`, `linux.ts`, `windows.ts`

Each class implements `KeychainAdapter`:
```ts
async isAvailable(): Promise<boolean>;
async set(service: string, account: string, value: Buffer): Promise<void>;
async get(service: string, account: string): Promise<Buffer | null>;
async delete(service: string, account: string): Promise<void>;
```

Per-platform body (identical shape; `@napi-rs/keyring` abstracts the OS API):

```ts
import { Entry } from "@napi-rs/keyring";

export class DarwinKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    // Try a no-op probe: does the OS support keyring at all?
    try {
      const e = new Entry("secret-shuttle-probe", "isAvailable");
      // Don't actually write — just confirm Entry constructs.
      void e;
      return true;
    } catch {
      return false;
    }
  }

  async set(service: string, account: string, value: Buffer): Promise<void> {
    try {
      const entry = new Entry(service, account);
      entry.setPassword(value.toString("base64"));
    } catch (e) {
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain set failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async get(service: string, account: string): Promise<Buffer | null> {
    try {
      const entry = new Entry(service, account);
      const v = entry.getPassword();
      if (v === null || v === undefined) return null;
      return Buffer.from(v, "base64");
    } catch (e) {
      // Touch ID cancelled, no entry, or other failure → null (not throw).
      // The caller (unlock flow) treats null as "fall through to passphrase UI".
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      const entry = new Entry(service, account);
      entry.deletePassword();
    } catch (e) {
      // Already deleted is OK.
      // Re-throw only for true errors (permissions, etc.).
      // @napi-rs/keyring throws a specific shape we check:
      if (e instanceof Error && /No matching entry/i.test(e.message)) return;
      throw new ShuttleError("keychain_unavailable", `Keychain delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
```

Each platform class has the same shape — the `@napi-rs/keyring` `Entry` API is uniform. The difference is just which OS API it calls underneath (Keychain Services on macOS → triggers Touch ID; libsecret on Linux → prompts via Secret Service; DPAPI on Windows → unlocks transparently when user is logged in).

The `isAvailable` probe is intentionally lightweight — just verify the native module loaded and `Entry` constructs without throwing. A REAL keychain interaction (set/get/delete) only happens during the real flows.

`get` swallows errors and returns null — this matters because Touch ID cancellation should fall through to passphrase UI silently, not surface as an exception to the user.

`delete` is idempotent — deleting a non-existent entry is not an error.

### 4. Unlock flow integration

**File:** `src/daemon/api/routes/unlock-session.ts`

Today's `POST /v1/unlock/start` reads the envelope, creates an unlock session, opens the passphrase UI. Modified flow:

```ts
server.addRoute("POST", "/v1/unlock/start", async () => {
  const envelope = await readEnvelope();
  if (envelope === null) {
    throw new ShuttleError(
      "envelope_missing",
      "No vault exists. Run `secret-shuttle init`.",
    );
  }

  // Try keychain first — fires Touch ID / libsecret prompt synchronously.
  const keychain = getKeychainAdapter();
  if (await keychain.isAvailable()) {
    const cached = await keychain.get("secret-shuttle", envelope.id);
    if (cached !== null) {
      try {
        // The cached value is the raw master key (32 bytes), not the passphrase.
        // We don't decrypt the envelope — we trust the keychain stored the right key.
        // Validate by attempting a known-key op (e.g., decrypt a test ciphertext
        // we stored alongside, OR re-decrypt envelope.ciphertext using the cached
        // key as if it were derived from passphrase). Cleanest: just unlock and let
        // vault operations surface a corruption error if the key was tampered.
        services.lock.unlock(cached);
        await services.vault.ensureInitialized();
        await writeDaemonAudit({ action: "unlock", ok: true, source: "keychain" });
        return { unlocked: true, source: "keychain" };
      } catch (e) {
        // Cached key didn't work — fall through to passphrase.
        await writeDaemonAudit({
          action: "unlock",
          ok: false,
          error_code: "keychain_key_invalid",
          source: "keychain",
        });
        // Continue to passphrase UI.
      }
    }
  }

  // Fall through to existing passphrase UI flow.
  const session = services.unlockSessions.create();
  // ... existing code to open browser UI ...
  return { session_id: session.id, /* etc */ };
});
```

**Post-passphrase keychain enrollment** (in the session-completion handler — `POST /ui/unlock/:id`):

After successful `decryptEnvelope(envelope, passphrase)` produces the master key:

```ts
services.lock.unlock(masterKey);

// Opportunistic keychain re-enroll. If keychain is available AND envelope.id
// is set, store the master key so the next unlock can skip the passphrase UI.
// Don't gate the unlock on this — if keychain enrollment fails, unlock still
// succeeded.
const keychain = getKeychainAdapter();
if (await keychain.isAvailable()) {
  try {
    await keychain.set("secret-shuttle", envelope.id, masterKey);
  } catch {
    // Swallow — unlock already succeeded; this is best-effort caching.
  }
}
```

The opportunistic re-enroll handles the case where the user re-installed the OS, migrated machines, or otherwise lost the keychain entry but kept the envelope — passphrase unlock works once, then keychain takes over for subsequent unlocks.

### 5. The `init` command

**File:** `src/cli/commands/init.ts`

Today: a thin daemon-status wrapper (3 lines of action body). Rewrite:

```ts
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { readSocketFile } from "../../daemon/socket-file.js";
import { detectAgentRuntimes, writeAgentSkill } from "../agent-writer.js";

export function initCommand(): Command {
  return new Command("init")
    .description(
      "First-run setup: starts daemon, creates vault, enrolls keychain (Touch ID), installs agent skills.",
    )
    .option("--no-keychain", "Skip keychain enrollment.")
    .option("--no-agent-install", "Skip agent runtime detection + skill install.")
    .option("--passphrase-from-stdin", "Read passphrase from stdin instead of opening the browser UI.")
    .action(async (options: Record<string, unknown>) => {
      // 1. Daemon: ensure running.
      let daemonInfo = await readSocketFile();
      if (daemonInfo === null) {
        // Spawn daemon. Match the lifecycle.ts logic.
        // ... spawn `secret-shuttle daemon start --background` (existing command) ...
        // Poll until socket file appears, with a 5s timeout.
      }

      // 2. Envelope: check, create if absent.
      const status = await daemonRequest<{ unlocked: boolean; vault_exists: boolean }>("GET", "/v1/status");
      let vaultJustCreated = false;
      if (!status.vault_exists) {
        // Open passphrase UI via /v1/unlock/start (same flow as `unlock`).
        // The passphrase UI on first-time creates the envelope.
        // ... existing flow ...
        vaultJustCreated = true;
      }

      // 3. Keychain enrollment (only if vault just created OR explicit --reenroll-keychain).
      let keychainEnrolled = false;
      if (options.keychain !== false && vaultJustCreated) {
        // Prompt: "Enable Touch ID unlock for next time? (Y/n)"
        // On yes: call POST /v1/keychain/enable.
        // The daemon reads the unlocked master key from services.lock and writes
        // to the keychain. ONE Touch ID prompt.
        // On failure or "no": continue.
        // ... implementation ...
        keychainEnrolled = true;
      }

      // 4. Agent runtime detection.
      let agentRuntimes: string[] = [];
      if (options.agentInstall !== false) {
        agentRuntimes = detectAgentRuntimes(process.cwd());
        for (const runtime of agentRuntimes) {
          await writeAgentSkill(runtime); // existing function
        }
      }

      // 5. Print summary.
      outputJson(ok({
        ok: true,
        daemon_running: true,
        daemon_port: daemonInfo?.port,
        vault_initialized: true,
        vault_just_created: vaultJustCreated,
        keychain_enrolled: keychainEnrolled,
        agent_runtimes_detected: agentRuntimes,
        next_action: vaultJustCreated
          ? "secret-shuttle import --env-file .env  # optional: migrate existing secrets"
          : null,
      }));
    });
}
```

The actual implementation needs to read the existing patterns from `lifecycle.ts` (daemon spawn), `unlock-session.ts` (browser UI flow), and `agent-writer.ts` (runtime detection). The skeleton above is a structural sketch.

**Idempotency:** Running `init` on a fully-initialized setup is a fast no-op:
- Daemon running → reuse.
- Envelope exists → skip creation, don't re-open passphrase UI.
- Keychain already enrolled (verify via `keychain.get(vaultId) !== null`) → skip re-enrollment.
- Agent skills already installed (check file existence + hash) → skip writes.

### 6. New routes

**`POST /v1/keychain/enable`** — request body: empty. Reads `services.lock.requireKey()` to get the unlocked master key, calls `getKeychainAdapter().set("secret-shuttle", envelope.id, masterKey)`. Returns `{ ok: true, enrolled: true }`. Throws `vault_locked` if daemon isn't unlocked.

**`POST /v1/keychain/disable`** — request body: empty. Calls `getKeychainAdapter().delete("secret-shuttle", envelope.id)`. Returns `{ ok: true, removed: true }`. Idempotent (deleting a non-existent entry is fine).

**`GET /v1/keychain/status`** — returns `{ available: boolean, enrolled: boolean, vault_id: string }`. `available` = `keychain.isAvailable()`. `enrolled` = `keychain.get(...) !== null`. Useful for `init` idempotency check.

### 7. New CLI commands

**`secret-shuttle keychain enable`** — POSTs `/v1/keychain/enable`. Surfaces success/failure.

**`secret-shuttle keychain disable`** — POSTs `/v1/keychain/disable`.

**`secret-shuttle keychain status`** — GETs `/v1/keychain/status`. Prints enum.

These three command files live at `src/cli/commands/keychain/{enable,disable,status}.ts` with an index that registers them.

---

## Error registry deltas

Add new error codes if not already present:

- `keychain_unavailable` — keychain operation failed (other than "no entry"). Used by `set` / `delete` exceptions.
- `keychain_key_invalid` — cached key didn't unlock the vault. Used by the unlock fall-through path.
- `daemon_start_timeout` — daemon spawn timed out during `init`. (Note: the original plan named this `daemon_start_failed`; implementation uses `daemon_start_timeout` from `lifecycle.ts` instead, which is already in the error registry.)

`keychain_not_implemented` already exists (stub throws). Keep it for the `UnsupportedKeychain` platforms.

Add `nextAction` to keychain codes per Plan 5d's pattern:
- `keychain_unavailable` → `nextAction: () => "secret-shuttle unlock"` (fall back to passphrase).
- `keychain_key_invalid` → `nextAction: () => "secret-shuttle unlock"`.
- `daemon_start_timeout` → `nextAction: () => "secret-shuttle daemon status"`.

---

## Test plan

### Unit tests (keychain adapters)

`src/vault/keychain/darwin.test.ts`, `linux.test.ts`, `windows.test.ts`:
- `isAvailable` returns true when `@napi-rs/keyring` constructs successfully.
- `set` + `get` round-trips a Buffer.
- `get` returns null when no entry exists.
- `get` returns null when the native call throws (Touch ID cancelled, etc.).
- `delete` is idempotent.

These tests use a real `Entry` from `@napi-rs/keyring` but with a test-only service name to avoid polluting the user's real keychain. Each test cleans up its own entries in `afterEach`. Tests are SKIPPED in CI environments where the keychain isn't available (gated on `CI_ALLOW_KEYCHAIN` env var or similar).

### Integration tests (unlock flow)

`src/daemon/api/routes/unlock-session.test.ts` extensions:
- Cold unlock (no keychain entry): falls through to passphrase UI as today.
- Warm unlock (keychain entry exists, returns valid master key): vault unlocks; no UI opened.
- Warm unlock with invalid keychain entry: fall through to passphrase UI; `keychain_key_invalid` audit entry.
- Post-passphrase enrollment: after successful passphrase unlock, keychain entry exists.

These tests use a `MockKeychain` injected via `getKeychainAdapter`'s `platformOverride` (existing pattern from stubs).

### `init` E2E test

`src/cli/commands/init.test.ts`:
- Cold init: no daemon, no envelope → daemon spawned, envelope created, agent runtimes installed.
- Re-init: everything exists → no-op summary.
- `--no-keychain`: keychain enrollment skipped.
- `--no-agent-install`: agent files not written.

---

## Documentation

- `SKILL.md` (repo root): mention `init` as the first-run command. Already done in Plan 5c.
- `README.md`: 30-second install section already leads with `init`. Verify the description matches what we ship.
- `docs/cli-reference.md`: add `init`, `keychain enable/disable/status`.
- `CHANGELOG.md`: Plan 5b + 5f-impl entry under Added.

---

## Implementation order

1. **5f-impl Task A**: keychain adapters. Add `@napi-rs/keyring` dependency. Replace darwin/linux/windows stubs with real implementations + tests. Existing stub-based tests need updates.
2. **5b Task B1**: extend `EnvelopeFile.id` field + migration in `readEnvelope`.
3. **5b Task B2**: modify `POST /v1/unlock/start` to try keychain first.
4. **5b Task B3**: opportunistic keychain enrollment after passphrase unlock.
5. **5b Task B4**: add `POST /v1/keychain/{enable,disable,status}` routes.
6. **5b Task B5**: rewrite `init` command + add `keychain` CLI command group.
7. **5b Task B6**: error registry additions + nextAction wiring.
8. **5b Task B7**: documentation + verification.

Each step has its own commit. Subagent-driven-development per task.

---

## Out of scope

- Hardware-backed keys beyond Touch ID (YubiKey, WebAuthn) — future plan.
- Per-project vaults — defer; one global vault is enough.
- Re-encrypting envelope on passphrase rotation — works via existing `unlock --set-passphrase` flow; no change needed.
- Migrating cached keys across vault UUID rotation — out of scope; rotation is intentional vault reset.
- macOS Secure Enclave direct binding — `@napi-rs/keyring` uses Keychain Services, which uses Secure Enclave for Touch ID under the hood; no extra work.
- Cleanup of orphaned keychain entries (when a vault is deleted but the keychain entry persists) — entries are harmless (no envelope to match), defer cleanup until `@napi-rs/keyring` exposes a list API.

---

**End of design.**
