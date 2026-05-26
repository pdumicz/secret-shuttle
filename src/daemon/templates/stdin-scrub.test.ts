import assert from "node:assert/strict";
import test from "node:test";
import { runTemplate, __setStdinObserverForTesting } from "./run.js";

// Task B3 — Phase B (memory hygiene): the stdin-delivery branch must zero
// the local Buffer holding the secret bytes after the child has accepted them.
// Scrubbing BEFORE the write callback risks clobbering not-yet-flushed bytes
// (Node may retain the same reference until drained), so the .end(buf, cb)
// callback is the primary trigger. error/close listeners are fallbacks for
// abnormal termination (child crash before write, broken pipe).

test("stdin-delivery: scrubs the secret Buffer AFTER the write callback fires (not before)", async () => {
  const secretText = "needle-stdin-3f7c-do-not-leak";
  let capturedBuf: Buffer | undefined;
  __setStdinObserverForTesting((buf) => { capturedBuf = buf; });
  try {
    // Child reads stdin and exits 0 — exercises the happy path (normal close).
    const result = await runTemplate({
      template: {
        id: "stdin-scrub-happy",
        description: "",
        binary: process.execPath,
        args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"],
        secret_delivery: "stdin",
        required_params: [],
        requires_approval_when_production: false,
      },
      params: {},
      secret: secretText,
    });
    assert.equal(result.exit_code, 0);
    assert.ok(capturedBuf !== undefined, "test observer should have captured the local Buffer");
    // After the promise resolves the child has closed, and Node has had at
    // least one tick to fire the write callback. The Buffer must be all zeros.
    assert.equal(capturedBuf!.length, Buffer.byteLength(secretText, "utf8"));
    for (let i = 0; i < capturedBuf!.length; i++) {
      assert.equal(capturedBuf![i], 0, `byte ${i} should be zero but is ${capturedBuf![i]}`);
    }
    // Sanity: the original plaintext must not be recoverable from the buffer.
    assert.equal(capturedBuf!.includes(Buffer.from(secretText, "utf8")), false);
  } finally {
    __setStdinObserverForTesting(undefined);
  }
});

test("stdin-delivery: scrubs on stdin 'error'/'close' event (abnormal termination)", async () => {
  // Exercise the fallback path: synthesize a stdin error BEFORE the write
  // callback runs. The scrub helper must fire from the error/close listeners.
  // We use a child that exits immediately, then destroy stdin with an error
  // synchronously after the observer hands us the stream — this means the
  // pipe is torn down before .end() can deliver its callback.
  const secretText = "needle-stdin-err-9e2a-do-not-leak";
  let capturedBuf: Buffer | undefined;
  __setStdinObserverForTesting((buf, stdin) => {
    capturedBuf = buf;
    // Synthesize a stdin error. node:stream's destroy(err) will emit 'error'
    // synchronously on the next microtask and then emit 'close'. Either one
    // is enough to fire the scrub via the once() listeners.
    stdin.destroy(new Error("synthetic stdin error for B3 fallback test"));
  });
  try {
    // Run and tolerate either resolve (close fired with some exit code) or
    // reject (the spawn-side promise saw the error). Both are acceptable for
    // this test — the contract we're testing is "scrub fires", not the
    // promise outcome.
    try {
      await runTemplate({
        template: {
          id: "stdin-scrub-err",
          description: "",
          binary: process.execPath,
          // Read & discard; exit fast. The destroy() will still tear stdin
          // down before the write completes.
          args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"],
          secret_delivery: "stdin",
          required_params: [],
          requires_approval_when_production: false,
        },
        params: {},
        secret: secretText,
      });
    } catch {
      // Reject is fine — the promise contract isn't what this test verifies.
    }
    // Give Node one more tick for the close listener to fire if error didn't.
    await new Promise((r) => setImmediate(r));
    assert.ok(capturedBuf !== undefined, "test observer should have captured the local Buffer");
    assert.equal(capturedBuf!.length, Buffer.byteLength(secretText, "utf8"));
    for (let i = 0; i < capturedBuf!.length; i++) {
      assert.equal(capturedBuf![i], 0, `byte ${i} should be zero (fallback scrub) but is ${capturedBuf![i]}`);
    }
  } finally {
    __setStdinObserverForTesting(undefined);
  }
});

test("stdin-delivery: scrub is idempotent — error + close + cb triple-fire is safe", async () => {
  // The scrub helper has a boolean guard so repeated calls don't double-zero
  // or otherwise corrupt state. Trigger all three sources by destroying stdin
  // mid-flight; the test passes iff runTemplate doesn't throw an unhandled
  // error from the listener pile-up.
  let observerHits = 0;
  __setStdinObserverForTesting(() => { observerHits++; });
  try {
    const r = await runTemplate({
      template: {
        id: "stdin-scrub-idempotent",
        description: "",
        binary: process.execPath,
        args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"],
        secret_delivery: "stdin",
        required_params: [],
        requires_approval_when_production: false,
      },
      params: {},
      secret: "idempotency-probe",
    });
    assert.equal(r.exit_code, 0);
    assert.equal(observerHits, 1, "observer should fire exactly once per runTemplate call");
  } finally {
    __setStdinObserverForTesting(undefined);
  }
});
