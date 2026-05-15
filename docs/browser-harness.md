# Browser Harness And Playwright Usage

Secret Shuttle V0 expects a Chrome instance reachable over the Chrome DevTools Protocol.

## Start Chrome With Secret Shuttle

```bash
secret-shuttle browser start --profile prod-config --port 9222
```

Use the returned CDP URL in browser tooling:

```text
http://127.0.0.1:9222
```

## Start Chrome Manually

macOS:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.secret-shuttle/browser-profiles/prod-config"
```

Linux:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.secret-shuttle/browser-profiles/prod-config"
```

## Agent Workflow

Use Browser Harness, Playwright, browser-use, Codex browser, or another browser tool for ordinary navigation.

When a secret becomes visible:

1. Stop browser observation.
2. Do not call screenshot, DOM, accessibility, console, network-body, or clipboard tools.
3. Run `secret-shuttle blind start`.
4. Focus the exact field or select the exact secret text.
5. Run `secret-shuttle capture`.
6. End blind mode once the secret is no longer visible.

When a secret must be entered:

1. Navigate normally.
2. Fill non-secret metadata fields.
3. Focus the secret value field.
4. Stop browser observation.
5. Run `secret-shuttle inject`.
6. Save using non-secret UI signals.

## CDP URL

Commands accept:

```bash
--cdp-url http://127.0.0.1:9222
```

You can also set:

```bash
export SECRET_SHUTTLE_CDP_URL=http://127.0.0.1:9222
```

## V0 Limitation

Secret Shuttle does not yet own or proxy the browser session. A cooperating agent must avoid unsafe observation while blind mode is active.
