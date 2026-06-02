# Browser Harness And Playwright Usage

The daemon owns the browser. The agent does not start Chrome directly.

## Start Chrome Through The Daemon

```bash
secret-shuttle daemon start
secret-shuttle unlock
secret-shuttle browser start --profile prod-config
```

Output:

```json
{ "started": true, "proxy_url": "ws://127.0.0.1:.../cdp/...", "raw_cdp_url": null }
```

Use the `proxy_url` in your browser automation tool (Playwright, Browser Harness, browser-use). Connect over WebSocket CDP. The proxy filters observation methods during blind mode.

## Agent Workflow

When a secret becomes visible:

1. Stop browser observation.
2. Run `secret-shuttle blind start --domain <host> --reason <why>`.
3. Focus the exact field or select the exact secret text.
4. Run `secret-shuttle capture` and approve in the daemon window.
5. End blind mode once the secret is no longer visible.

When a secret must be entered:

1. Navigate normally and fill non-secret metadata fields.
2. Focus the secret value field.
3. Run `secret-shuttle inject --ref ... --domain ...` and approve in the daemon
   window. The daemon enters blind mode itself, severs your CDP connection, and
   writes the value while you are blacked out — you never run `blind start` for
   inject. (If a blind window is already active, inject refuses with
   `blind_mode_already_active`; run `secret-shuttle blind end` first.)
4. Your CDP proxy connection is now closed and blind mode is ACTIVE. Complete any
   non-observational follow-up.
5. Run `secret-shuttle blind end` and approve once the secret is saved/submitted
   and no longer visible. This blanks open pages and resumes observation.

## Raw CDP URL

The daemon never returns the raw Chrome CDP URL. Tools that need to connect to Chrome must use the proxy URL.
