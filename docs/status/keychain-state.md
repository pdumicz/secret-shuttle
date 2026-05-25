# Keychain integration status — Plan 5f

_Investigation date: 2026-05-25_

## What's there

### Public API (`src/vault/keychain/`)

| Symbol | Location | Purpose |
|---|---|---|
| `KeychainAdapter` interface | `types.ts` | `isAvailable()`, `set(svc,acct,secret)`, `get(svc,acct)`, `delete(svc,acct)` |
| `getKeychainAdapter(opts?)` | `index.ts` | Factory — returns platform-matched class |
| `DarwinKeychain` | `darwin.ts` | macOS stub |
| `LinuxKeychain` | `linux.ts` | Linux stub |
| `WindowsKeychain` | `windows.ts` | Windows stub |
| `UnsupportedKeychain` (private) | `index.ts` | All other platforms |

All platform adapters are **Plan 1 stubs**: `isAvailable()` returns `false`; every operation throws `keychain_not_implemented`. No native module is wired in yet.

There is also a second module — `src/vault/keychain.ts` — which is **not** the `KeychainAdapter` system. It handles a now-legacy local-file key storage format (`master-key.json` / `MasterKeyFile`). It exports:
- `loadOrCreateMasterKey()` — reads `SECRET_SHUTTLE_MASTER_KEY` env var, or falls back to `~/.secret-shuttle/master-key.json`.
- `hasLegacyKeyFile()` — used as a startup guard.
- `readLegacyKey()` — used by `secret-shuttle migrate`.

### Platform status

| Platform | `isAvailable()` | `set/get/delete` | Native module |
|---|---|---|---|
| darwin (macOS) | `false` | throws `keychain_not_implemented` | not installed |
| linux | `false` | throws `keychain_not_implemented` | not installed |
| win32 | `false` | throws `keychain_not_implemented` | not installed |

## What's wired

The `getKeychainAdapter` factory is **never called** from production code. Here is the full caller table:

| Caller | What it imports from keychain | Purpose |
|---|---|---|
| `src/daemon/lifecycle.ts` | `hasLegacyKeyFile` from `../vault/keychain.js` | Startup guard — refuses to start if legacy key exists |
| `src/daemon/main.ts` | `hasLegacyKeyFile` from `../vault/keychain.js` | Same guard in the daemon main entry |
| `src/cli/commands/migrate.ts` | `readLegacyKey` from `../../vault/keychain.js` | Reads the old key during migration |
| `src/vault/keychain/index.test.ts` | `getKeychainAdapter` | Tests only — stub-behavior assertions |

`getKeychainAdapter` appears in **tests only**. No unlock route, no init path, no daemon service calls it.

## What's NOT wired

1. **`getKeychainAdapter` is never called from production code.** The `KeychainAdapter` interface, all three platform adapters, and the `UnsupportedKeychain` fallback exist entirely for the architecture that Plan 5a was meant to build.

2. **The unlock flow is passphrase-only.** The current path:
   - `secret-shuttle unlock` → POST `/v1/unlock/start` (creates an unlock session) → opens the hub browser UI at `/ui/unlock`.
   - User types passphrase in the browser UI → POST `/ui/unlock/{id}?token=…` → `decryptEnvelope(existing, passphrase)` → `services.lock.unlock(masterKey)`.
   - There is no pre-unlock keychain read and no post-unlock keychain write at any point in this path.

3. **Touch ID never triggers.** Because `DarwinKeychain.isAvailable()` returns `false` and `get()` throws before reaching the OS, Touch ID cannot be presented even in principle.

4. **No opt-in surface exists.** There is no CLI flag, config key, or user-facing hint suggesting keychain / Touch ID is available.

## How the unlock flow WOULD slot in once Plan 5a is complete

The intended design (per comments in the code) is:
1. On **first unlock**: after `decryptEnvelope` succeeds and `services.lock.unlock(masterKey)` is called, call `adapter.set("secret-shuttle", vaultId, masterKey)` to cache the master key in the OS keychain.
2. On **subsequent unlocks**: before showing the passphrase UI, call `adapter.get("secret-shuttle", vaultId)`. If it returns a Buffer, call `services.lock.unlock(that)` and skip the passphrase entirely. On macOS this read triggers a Touch ID / password prompt from the OS — no user-facing passphrase field needed.
3. Fallback: if `isAvailable()` is `false` or `get()` returns `null`, fall through to the existing passphrase UI.

The `service`/`account` namespacing is documented in `types.ts`: service = `"secret-shuttle"`, account = the vault's unique ID (so multiple vaults on one machine don't collide).

No vault ID is currently threaded through the unlock route (`unlock-session.ts`), so that needs to be added as part of Plan 5a wiring.

## To launch with Touch ID on macOS, we need (concrete next steps)

1. **Plan 5a (blocker): implement `DarwinKeychain`** using a native module (e.g. `@napi-rs/keyring`) that calls Keychain Services via memory APIs — not the `security` CLI, which leaks the password into `ps`.

2. **Wire the post-unlock store:** in `POST /ui/unlock/{id}` (and the dev-mode `POST /v1/unlock`), after a successful `decryptEnvelope`, call `adapter.set("secret-shuttle", vaultId, masterKey)` when `adapter.isAvailable()`.

3. **Wire the pre-unlock read:** in `POST /v1/unlock/start`, before creating the browser session, call `adapter.get("secret-shuttle", vaultId)`. If it returns a key, unlock immediately and return `status: "unlocked"` without opening the UI.

4. **Thread a vault ID:** currently there's no stable vault identifier. A UUID written to `~/.secret-shuttle/vault-id` (next to `envelope.json`) would serve as the keychain account key and prevent multi-vault collisions.

5. **`secret-shuttle init` opt-in:** after successful first-run unlock, prompt (or auto-enable) keychain storage. There is no interactive init today — `init` just checks daemon status.

No small fix can close this gap. The gap is large: it requires a native module, a new vault-ID concept, and wiring into two routes. This is the full scope of Plan 5a.
