# Browser Harness And Playwright Usage

In Secure Mode, the daemon owns the browser. The agent does not start Chrome directly.

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

1. Navigate normally.
2. Fill non-secret metadata fields.
3. Focus the secret value field.
4. Run `secret-shuttle inject --ref ... --domain ...`.
5. Approve in the daemon window.
6. Save using non-secret UI signals.

## Raw CDP URL

The daemon never returns the raw Chrome CDP URL. Tools that need to connect to Chrome must use the proxy URL.
