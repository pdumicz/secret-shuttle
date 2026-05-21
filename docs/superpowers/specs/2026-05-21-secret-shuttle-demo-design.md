# Secret Shuttle Demo — Design Spec

Date: 2026-05-21
Status: Approved for build
Topic: Single-HTML click-through that simulates how a developer adopts and uses Secret Shuttle, end-to-end.

## 1. Purpose

Two outcomes from one artifact:

1. **Demo.** A self-contained HTML file we can hand to anyone — a teammate, an investor, a
   prospective user — and they immediately see what Secret Shuttle looks like inside a real
   developer workflow. No install required.
2. **Gap-finding.** Building the demo forces us to walk the full developer journey scene by
   scene. Each scene carries a "Gap to spot" annotation that flags a UX question we can't
   answer from inside the codebase (because it's about what the dev *experiences*, not what
   the code does).

The narrative starts from "I vibecoded an app, I'm ready to ship to prod, how do I do this
quickly and safely?" — i.e. the moment of need — and ends with the Stripe webhook secret
landing in Vercel production env vars without the agent or the dev ever seeing the raw
value.

## 2. Format

- **Click-through prototype.** Next/Back buttons + arrow keys. One scene visible at a time.
- **Single HTML file** at `demo/index.html`. No build step. Self-contained (inline CSS + JS).
  Easy to share by emailing the file or hosting on any static surface.
- **macOS-chrome fidelity.** Terminal windows render with traffic lights, dark theme, monospace
  fonts. Browser windows render with traffic lights and address bar. Approval and unlock
  popups render with macOS window chrome on top of a dimmed background window.
- **Side panel per scene** with three blocks:
  - **Title** — what's happening this scene.
  - **Copy** — 1–3 sentence narrative for the audience.
  - **Gap to spot** (yellow box) — the UX gap to discuss with anyone we walk through it.
- **Progress indicator** — "Scene 3 of 9" + a thin bar across the top.
- **No external dependencies** — no React, no Tailwind, no fonts loaded from CDN. Plain HTML +
  CSS + a few hundred lines of vanilla JS.

## 3. Visual decisions

- **Wallpaper.** Subtle macOS-style desktop background behind the windows (a soft gradient,
  no logos). Sets the "this is a real OS" frame.
- **Terminal.** Dark window (#1d1d1f / #2c2c2e header). SF Mono / ui-monospace. Claude Code
  prompt style: `>` for the user's prompt, indented italic for tool calls, regular for
  output. Green `$` prompt for raw shell.
- **Browser.** Light header (#f0f0f0), traffic lights, address bar with realistic URL
  (`localhost:7421` for the approval window; `dashboard.stripe.com`, `vercel.com/.../settings/environment-variables` for target sites).
- **Approval card.** Faithful to `src/daemon/approvals/ui.html`: the same fields (action,
  environment, page, URL host, injectable into, action scope, success marker, technical
  details collapsible), the same green Approve / red Deny buttons. We polish typography and
  spacing — the structure and content are exactly what the daemon serves today.
- **Blind mode.** When blind mode is active, the daemon-owned Chrome window is rendered with
  a translucent overlay and a "🔒 BLIND — agent observation suspended" badge. This is a
  *demo affordance*, not necessarily what the real product shows (see Scene 7 gap).

## 4. Storyboard (9 scenes)

Each scene below lists: (a) what the dev is doing / saying, (b) what windows are on screen,
(c) the gap to surface.

### Scene 1 — The pain

- **Doing.** Dev is in Claude Code asking "deploy this to prod — you'll need to set the Stripe webhook signing secret and a couple of Vercel env vars". Claude responds that it would need the dev to paste the secret, or that the dev should handle it manually.
- **On screen.** Claude Code terminal session only.
- **Gap.** Does the dev know *why* pasting is bad? Do we need a one-line "why this matters"?

### Scene 2 — Discovery

- **Doing.** Dev: "I heard about secret-shuttle, can you set it up?" Claude fetches the raw skill URL, reads it, summarizes the model in two sentences.
- **On screen.** Same terminal, Claude's reply.
- **Gap.** Is the discovery path realistic? How does the dev *actually* learn about Secret Shuttle? Skill registry? README links from other tools?

### Scene 3 — Install + unlock

- **Doing.** Claude runs `npm install -g secret-shuttle`, `secret-shuttle daemon start`, `secret-shuttle unlock`. The unlock CLI opens a local web window. Dev types passphrase.
- **On screen.** Terminal (left), unlock window (right, foreground; from `unlock-ui.html`).
- **Gap.** First-time unlock = "create passphrase" mode. Is the distinction visible enough in the UI? Could the dev confuse "create" with "enter"?

### Scene 4 — Agent skill install

- **Doing.** Claude runs `secret-shuttle agent install claude` → writes `.claude/skills/secret-shuttle/SKILL.md`. Claude acknowledges and references the protocol going forward.
- **On screen.** Terminal showing the file write + Claude's "skill loaded" reply.
- **Gap.** Does Claude actually re-read its skills mid-session, or does it need a new session to pick up the file? The demo should be honest about this.

### Scene 5 — First quick win (generate + Vercel template)

- **Doing.** Dev: "generate an INTERNAL_CRON_SECRET for prod and add it to Vercel". Claude runs `doctor`, then `generate --kind random_32_bytes --allow-domain vercel.com`, then `template run vercel-env-add`. Two approval pop-ups in sequence.
- **On screen.** Terminal + approval card (stacked: the second approval slightly offset so both are visible at once — communicates the "two approvals per intent" friction).
- **Gap.** Two approval clicks for one user intent — is this friction? Should there be a single-grant "this whole intent" approval?

### Scene 6 — Browser start + mark

- **Doing.** Dev: "now the Stripe webhook → Vercel". Claude runs `browser start`. Daemon-owned Chrome opens. Claude navigates to Stripe webhook settings and marks the reveal button and secret field via `browser mark`.
- **On screen.** Terminal (left) + Stripe dashboard in daemon's Chrome (right). The two marks visually highlighted with labels (`reveal-btn`, `webhook-secret-field`).
- **Gap.** The `mark pick` choreography (background command + click target) is delicate. Easy for an agent to miss. Worth annotating with a "how the agent drives this" callout.

### Scene 7 — Reveal-capture from Stripe (blind mode)

- **Doing.** Claude runs `reveal-capture`. Approval card pops up with reveal handle label, capture mode, field/container label, hide handle, and the explicit auto-resume disclosure (red text per ui.html). Dev approves. Output: enum-only — `captured: true`, `value_visible_to_agent: false`.
- **On screen.** Daemon Chrome on Stripe (with 🔒 BLIND overlay) behind the approval card.
- **Gap.** How does the dev know blind mode is on? Is there a real visual indicator in the product today, or is it CLI-only?

### Scene 8 — Inject-submit into Vercel (blind mode)

- **Doing.** Claude navigates daemon Chrome to Vercel env-var page, marks the value field + Save button, runs `inject-submit --success-text "Environment Variable Added"`. Approval card with field/submit labels + success marker + auto-resume disclosure. Dev approves. Output: success, blind ended.
- **On screen.** Daemon Chrome on Vercel (with 🔒 BLIND overlay) + approval card (foreground) + terminal showing the enum-only response.
- **Gap.** "Marked field + marked submit + success text" is a lot of ceremony. Should `template run` be the obvious default for cloud providers, with `inject-submit` reserved for non-templated destinations?

### Scene 9 — Doctor + summary

- **Doing.** Claude runs `secret-shuttle doctor` → all green. Final assistant message: "Stripe webhook secret is in Vercel production env. You never saw it. The agent never saw it. The CLI argv and env never carried it." Done.
- **On screen.** Terminal with `doctor` output + closing assistant message.
- **Gap.** Where does the dev go next? Rotation? Other providers? A "what now" CTA is missing in the real product too.

## 5. Components (reusable inside the HTML)

- `.terminal-window` — header w/ traffic lights + title, dark body, monospace lines. Variants
  for `prompt-line`, `user-line` (Claude Code `>`), `tool-line` (italic), `output-line`,
  `command-line` (green `$`).
- `.browser-window` — header w/ traffic lights + address bar, body area for iframe-style
  content (we mock the target site visually, no real fetch).
- `.approval-card` — close adaptation of `src/daemon/approvals/ui.html` markup. Same fields,
  Approve/Deny buttons, technical-details `<details>` block, red auto-resume disclosure where
  applicable.
- `.unlock-card` — adaptation of `src/daemon/approvals/unlock-ui.html`.
- `.stage` — positions windows inside the right pane (background window + foreground popup).
- `.blind-overlay` — translucent overlay with 🔒 BLIND badge that sits over a browser-window
  when the scene is in blind mode.
- `.side-panel` — left pane: title, copy, gap callout.

## 6. Content fidelity rules

- **Commands** must match the real CLI exactly — flags, env names, refs. No invented options.
- **Approval-card content** must match what the daemon actually emits for each action (per
  `ui.html`'s `human` map: `inject`, `capture`, `generate`, `compare`, `template`,
  `inject_submit`, `reveal_capture`, `blind_end`).
- **Refs** use the canonical shape `ss://source/env/NAME`.
- **JSON responses** match the shapes in the README and walkthrough (`captured`,
  `secret_ref`, `fingerprint`, `value_visible_to_agent`, `injected`, etc.).
- **Skill quotes** in Scenes 2 and 4 should excerpt the actual `skills/secret-shuttle/SKILL.md`,
  not paraphrase.

## 7. Out of scope

- Real interactivity with the daemon. Nothing in the demo talks to anything.
- Real terminal emulation. We render static styled HTML; we do not run a PTY.
- Mobile / responsive layouts. The demo is designed for a laptop screen (≥1280px wide).
- Light/dark theming. macOS-light only.
- Recording / video export. Future enhancement if needed.

## 8. Acceptance criteria

- File exists at `demo/index.html`, opens cleanly in Chrome and Safari, no JS errors.
- All 9 scenes navigable via Next/Back buttons and arrow keys.
- Every scene renders the windows it advertises in §4.
- Every scene's side panel shows title, copy, and gap callout.
- macOS chrome (traffic lights, address bar, window shadows) renders on every window.
- Approval-card content is faithful to `ui.html` (same fields, same buttons, same disclosure).
- Smoke test: walk all 9 scenes; nothing is empty, nothing is broken.
