# Burst 6 Dogfood Friction Log

**Date filled:** YYYY-MM-DD
**Filled by:** Patryk
**Test project:** [fresh Next.js + Stripe + Supabase, e.g., `/tmp/ss-dogfood-burst6/`]
**Agent runtime:** [Claude Code / Cursor / Codex / etc.]
**secret-shuttle version under test:** 0.3.1
**Reference spec:** [docs/superpowers/specs/2026-05-29-burst6-vision-polish-design.md §5](../superpowers/specs/2026-05-29-burst6-vision-polish-design.md)

---

## Quick-reference card

**Setup recipe (one-time):**
```bash
mkdir /tmp/ss-dogfood-burst6 && cd /tmp/ss-dogfood-burst6
npx create-next-app@latest . --yes
npm install stripe @supabase/supabase-js
npx supabase init
npx supabase link --project-ref <a real Supabase test project ref>
cat > .env.example <<EOF
STRIPE_WEBHOOK_SECRET=
SUPABASE_SERVICE_ROLE_KEY=
INTERNAL_CRON_SECRET=
EOF
```

**Agent prompt (paste into a fresh Claude/Cursor session):**

> Set up secret-shuttle in this project. I need a Stripe webhook secret pushed to Vercel production, a Supabase service-role key pushed to Supabase production, and an internal cron secret generated and pushed to Vercel production. The Stripe one I need to capture from the Stripe dashboard.

**What to time:**
- "First agent message" timestamp
- "audit --since 5m" success timestamp
- Difference = wall-clock for the publish gate

---

## Release-blocker gate

(Per spec §5: ALL must hold for `npm publish 0.3.1` to be unblocked.)

- [ ] Agent reached `secret-shuttle audit --since 5m` showing both Stripe + Supabase secrets pushed end-to-end
- [ ] Exactly one human approval click happened (one hub card, one click — not multiple)
- [ ] No secret value (raw bytes) appeared in any log, audit row, or agent-visible surface
- [ ] Audit log shows correct `agent_id`, `batch_id`, all required fields populated
- [ ] Agent did not need to read source code, internal docs, or contact a human spelunker to recover from a failure

**Verdict:** ☐ Pass / ☐ Block (if any unchecked, publish is blocked until fixed and re-run.)

---

## UX target metrics (informational, not release-blocking)

(Per spec §5: misses are logged to v0.3.2 backlog but don't block publish.)

- [ ] Zero clarifying questions from the agent beyond the initial prompt
- [ ] Total wall-clock under 5 minutes (excluding human approval-click decision time)
- [ ] No polish gaps surfaced in wording / demo / README phrasing

**Wall-clock measured:** __ min __ sec

---

## Section 1 — Worked well (magic moments)

[Notes on what flew. Be specific — name verbs, prompts, scene URLs, error codes.]

- 
- 

---

## Section 2 — Friction (where the agent paused, asked, or recovered)

[Notes. Each entry should name the verb/step, what blocked, and how recovery happened (or didn't).]

- 
- 

---

## Section 3 — Bugs (anything that errored or behaved unexpectedly)

[Concrete reproducible-or-not-reproducible bugs. If reproducible, paste the agent's transcript + the daemon's audit/error response.]

- 
- 

---

## Section 4 — Polish backlog (v0.3.2 / v0.4.0 candidates)

[UX target misses that don't block publish. File as ranked items.]

- 
- 

---

## Verdict + next steps

**Publish 0.3.1?** ☐ Yes / ☐ No (if no, list the blocker tasks needed before re-run)

**v0.3.2 backlog seeded?** ☐ Yes / ☐ No
