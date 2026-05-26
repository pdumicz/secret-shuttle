import { ShuttleError } from "../shared/errors.js";

export interface ResolvedToken {
  /** The full string to set as `Authorization: Bearer <X>`. */
  bearer: string;
  scope: "agent" | "root";
  /** Present iff scope === "agent" AND the env token contains a dot (extracted prefix). */
  agentId?: string;
}

export interface ResolverOpts {
  port: number;
  /**
   * Override for tests + advanced callers: function that returns the socket file's
   * root token. In production, defaults to readSocketFile() and reads `.token`.
   */
  readSocketTokenFn?: () => Promise<string>;
}

/**
 * Resolve which bearer the client should send to the daemon.
 *
 * Priority:
 *   1. SECRET_SHUTTLE_AGENT_TOKEN env var → scope: "agent", agentId from last-dot split
 *   2. SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN === "1" AND no agent token → throw agent_token_required
 *   3. Otherwise → read the socket file's root token, scope: "root"
 *
 * The client never validates bearer shape; the daemon's parseBearer does that.
 */
export async function resolveDaemonToken(opts: ResolverOpts): Promise<ResolvedToken> {
  const agentTok = process.env.SECRET_SHUTTLE_AGENT_TOKEN;
  if (typeof agentTok === "string" && agentTok.length > 0) {
    const lastDot = agentTok.lastIndexOf(".");
    const out: ResolvedToken = { scope: "agent", bearer: agentTok };
    if (lastDot > 0) {
      out.agentId = agentTok.slice(0, lastDot);
    }
    return out;
  }
  if (process.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN === "1") {
    throw new ShuttleError(
      "agent_token_required",
      "SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1 is set but SECRET_SHUTTLE_AGENT_TOKEN is missing or empty. Run `secret-shuttle init` to (re-)install your agent token, or unset SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN.",
    );
  }
  const read = opts.readSocketTokenFn ?? defaultReadSocketTokenFn;
  const token = await read();
  return { scope: "root", bearer: token };
}

async function defaultReadSocketTokenFn(): Promise<string> {
  // Lazy-load to avoid a hard module dep when callers provide their own override.
  const { readSocketFile } = await import("../daemon/socket-file.js");
  const sock = await readSocketFile();
  if (sock === null) {
    throw new ShuttleError("daemon_not_running", "Socket file is absent.");
  }
  return sock.token;
}
