# Burst 7 §2 (5q) — `.value` site map

Definitive categorization driving the SecretValue migration. Verified against
`main` at v0.3.1. Categories: (a) stored-string/vault-internal — stays string;
(b) resolved-consumer → `.bytes()` + dispose, each sub-tagged **Buffer-native**
or **accepted-string-boundary**; (c) metadata/existence-only → no-value
`Vault.inspect`→`AgentSecretMetadata`; (d) inbound-producer → early-wrap into a
`SecretValue`; (e) genuinely unrelated `.value` — untouched.

## (a) Vault-internal / on-disk stored-string — STAYS `string`
| Site | Note |
|---|---|
| `vault.ts:92` `value: input.value` | stored `SecretRecord.value`; after write-path becomes `input.value.bytes().toString("utf8")` |
| `vault.ts:83` `fingerprintSecret(input.value, ...)` | becomes `fingerprintSecret(input.value.bytes(), ...)` (write path) |
| `vault.ts:249` `fingerprintSecret(s.value, fpKey)` | legacy-fingerprint migration; becomes `fingerprintSecret(Buffer.from(s.value, "utf8"), fpKey)` |
| `crypto.ts` `JSON.stringify`/`toString("utf8")` | Tier B — UNCHANGED |

## (b) Resolved-consumer → `.value.bytes()` + dispose
| Site | Sink class | Migration |
|---|---|---|
| `inject-submit.ts:171` `injectIntoBackendNode(..., secret.value)` | accepted browser/CDP | late `resolveSecret` after approval; `.bytes().toString("utf8")` at sink; single SecretValue across both sinks |
| `inject-submit.ts:222` `proveAbsence(secret.value)` | accepted browser/CDP | same SecretValue as :171; dispose once in outer `finally` |
| `secrets.ts:445` `injectFocused(secret.value)` (/v1/secrets/inject) | accepted browser/CDP | late `resolveSecret` after approval; dispose in `finally` |
| `templates.ts:219` `runTemplate({ secret: secret.value })` | Buffer-native (stdin/env-file) | late `resolveSecret` after approval; pass `SecretValue`/`Buffer`; dispose in `finally` |
| `run-resolve.ts:337` `env[entry.key] = record.value` | accepted child env (string-only platform API) | late resolve; assign string only at `env[...]=`; drop-reference + dispose after spawn |
| `run-resolve.ts:348` `secretValues = ...map(r => r.value)` | Buffer-native (masker) | `.map(r => r.value.bytes())` → `createMasker(Buffer[])` |
| `run-resolve.ts:443` `Buffer.from(resolved.get(stdin_ref).value, "utf8")` | Buffer-native (child stdin) | `resolved.get(stdin_ref).value.bytes()` |
| `inject-render.ts:95` `valuesMap.set(ref, record.value)` | accepted template render (+ stdout-out) | late resolve after conditional gate; `.bytes().toString("utf8")` at `valuesMap.set`; file-mode reorder; dispose in `finally` |

## (c) Metadata/existence-only → no-value `Vault.inspect`→`AgentSecretMetadata`
| Site | Reads | Migration |
|---|---|---|
| `secrets.ts:154` `getSecret(plannedRef)` (generate overwrite-scope) | `allowed_actions` | `inspect`; catch `secret_not_found` → `existingActions = undefined` |
| `secrets.ts:484` `getSecret(b.ref)` (compare) | `ref`/`environment`/`allowed_domains`/`fingerprint` | `inspect`; compare HMACs the captured candidate, NOT a stored value |
| `secrets-import.ts:103` `getSecret(candidateRef)` (existence) | existence + `.ref` | `inspect` |
| `secrets-delete.ts:50` `getSecret(b.ref)` | `environment`/`allowed_domains` | `inspect` |
| `secrets-rotate.ts:50` `getSecret(b.ref)` | `environment`/`name`/`source`/`allowed_domains`/`allowed_actions` | `inspect` |
| `inject-submit.ts:53` `getSecret(ref)` (preflight) | `ref`/`allowed_actions`/`environment`/`allowed_domains` | `inspect` for the pre-approval preflight; `resolveSecret` after approval |
| `secrets.ts:394` `getSecret(b.ref)` (/v1/secrets/inject preflight) | `ref`/`allowed_actions`/`environment`/`allowed_domains` | `inspect` preflight; `resolveSecret` after approval |
| `templates.ts:130` `getSecret(ref)` (preflight) | `ref`/`allowed_actions`/`environment` | `inspect` preflight; `resolveSecret` after approval |
| `inject-render.ts:54` `resolveRefs(parsed.refs)` (preflight) | `allowed_actions`/`environment` per ref | metadata map for preflight; `SecretValue`-`resolveRefs` after gate |
| `run-resolve.ts:220` `resolveRefs(allRefs)` (preflight) | `allowed_actions`/`environment` per ref | metadata map for preflight; `SecretValue`-`resolveRefs` after gate |

## (d) Inbound-producer `.value` → early-wrap into `SecretValue`
| Site | Producer shape |
|---|---|
| `secrets.ts:205` `upsertSecret({ value })` (generate route, `generateSecretValue` `:204`) | `SecretValue.fromUtf8(generateSecretValue(kind))` — ENCODED string |
| `vault.ts:191-192` `Vault.generate` → `upsertSecret({ value })` (`generateSecretValue` `:191`) | `SecretValue.fromUtf8(generateSecretValue(input.kind))` — ENCODED string; return `AgentSecretMetadata` |
| `secrets.ts:360` `upsertSecret({ value: capture.value })` (capture route) | `SecretValue.fromUtf8(capture.value)` — accepted capture string boundary |
| `secrets-import.ts:135` `upsertSecret({ value: entry.value })` (import) | `SecretValue.fromUtf8(value)` AT THE PARSE LOOP `:41-48`; `ImportEntry.value: SecretValue` |
| `reveal-capture.ts:424` `upsertSecret({ value: capturedValue })` | `SecretValue.fromUtf8(capturedValue)`; proof-before-upsert reorder (single owned SecretValue) |
| `executor.ts:703` `upsertSecret({ value: captured.value })` (bootstrap capture) | `SecretValue.fromUtf8(captured.value)` |

## (e) Genuinely unrelated `.value` — UNTOUCHED
| Site | Why |
|---|---|
| `run-resolve.ts:330,334` `resolved.get(entry.value)` / `Ref ${entry.value}` | `entry.value` is the **ref string** (an env entry's ref), not a secret value |
| `secrets.ts:515` `secret.fingerprint` read | metadata field, not `.value` |
| HTTP body params, `template_params`, `value_visible_to_agent` flags | non-secret `.value`/`value*` reads |

## Two-phase late-resolve discipline (applies to every (b) consumer)
Before `requireApprovals`: metadata-only preflight (`inspect`/metadata `resolveRefs`) — no `SecretValue`, no plaintext string. After approval (or after the conditional gate block for `run-resolve`/`inject-render`), immediately before the sink: `resolveSecret`/`SecretValue`-`resolveRefs`, convert `.bytes()`→string only at the sink, dispose each `SecretValue` in a `finally`.
