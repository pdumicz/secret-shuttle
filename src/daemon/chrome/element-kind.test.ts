import assert from "node:assert/strict";
import test from "node:test";
import { elementKind } from "./internal-ops.js";

test("text-entry inputs and editables are `field`", () => {
  for (const type of ["text", "password", "email", "url", "search", "tel", "number", ""]) {
    assert.equal(elementKind({ tag: "input", type, editable: true }), "field", `input[type=${type}]`);
  }
  assert.equal(elementKind({ tag: "textarea", editable: true }), "field");
  assert.equal(elementKind({ tag: "div", editable: true }), "field"); // contenteditable
});

test("non-text inputs are NOT field (spec §3.3 exclusions)", () => {
  for (const type of ["checkbox", "radio", "file", "range", "color", "date", "datetime-local", "month", "week", "time"]) {
    assert.equal(elementKind({ tag: "input", type, editable: false }), "other", `input[type=${type}]`);
  }
});

test("button-kind set", () => {
  assert.equal(elementKind({ tag: "button", editable: false }), "button");
  assert.equal(elementKind({ tag: "summary", editable: false }), "button");
  assert.equal(elementKind({ tag: "div", role: "button", editable: false }), "button");
  for (const type of ["submit", "button", "image", "reset"]) {
    assert.equal(elementKind({ tag: "input", type, editable: false }), "button", `input[type=${type}]`);
  }
});

test("link-kind set", () => {
  assert.equal(elementKind({ tag: "a", href: true, editable: false }), "link");
  assert.equal(elementKind({ tag: "a", href: false, editable: false }), "other"); // anchor without href
  assert.equal(elementKind({ tag: "span", role: "link", editable: false }), "link");
});

test("everything else is `other`", () => {
  assert.equal(elementKind({ tag: "span", editable: false }), "other");
  assert.equal(elementKind({ tag: "p", editable: false }), "other");
});
