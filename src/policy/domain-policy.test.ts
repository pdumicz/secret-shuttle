import assert from "node:assert/strict";
import test from "node:test";
import { domainMatches, normalizeDomain } from "./domain-policy.js";

test("normalizeDomain accepts URLs and domains", () => {
  assert.equal(normalizeDomain("https://vercel.com/acme/project"), "vercel.com");
  assert.equal(normalizeDomain("dashboard.stripe.com"), "dashboard.stripe.com");
});

test("domainMatches allows exact and subdomains", () => {
  assert.equal(domainMatches("dashboard.stripe.com", "stripe.com"), true);
  assert.equal(domainMatches("vercel.com", "vercel.com"), true);
  assert.equal(domainMatches("evil-vercel.com", "vercel.com"), false);
  assert.equal(domainMatches("app.example.com", "*.example.com"), true);
  assert.equal(domainMatches("example.com", "*.example.com"), false);
});
