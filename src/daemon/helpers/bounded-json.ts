import { ShuttleError } from "../../shared/errors.js";

export interface BoundedJsonOptions {
  allowEmpty?: boolean;
}

/**
 * Read an HTTP request body bounded by `maxBytes`, parse as JSON, and return it.
 *
 * - Throws `request_too_large` if the streamed length exceeds `maxBytes`.
 * - Throws `bad_request` ("Empty body.") if the body is empty AND `opts.allowEmpty`
 *   is not set; with `allowEmpty: true`, returns `{}` for empty bodies (used by
 *   the §2b approval-UI route which accepts a 0-byte POST as "use defaults").
 * - Throws `bad_request` ("Malformed JSON body.") on parse failure.
 */
export async function readBoundedJson(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
  opts: BoundedJsonOptions = {},
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new ShuttleError("request_too_large", `Body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  if (total === 0) {
    if (opts.allowEmpty === true) return {};
    throw new ShuttleError("bad_request", "Empty body.");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ShuttleError("bad_request", "Malformed JSON body.");
  }
}
