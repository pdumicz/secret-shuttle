import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  /** Either a derived agent id (e.g. "claude-7f2a") or the literal "root" for daemon-control calls. */
  agent_id: string;
  isRoot: boolean;
}

export const authContext = new AsyncLocalStorage<AuthContext>();

/**
 * Wrap an async-or-sync callback so any descendant call can read
 * `getAuthContext()` / `getCurrentAgentId()`. Returns the callback's value.
 */
export async function withAuthContext<T>(
  ctx: AuthContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await authContext.run(ctx, async () => await fn());
}

/** Returns the current AuthContext, or undefined if no withAuthContext is active. */
export function getAuthContext(): AuthContext | undefined {
  return authContext.getStore();
}

/**
 * Returns the current agent_id, or the literal "daemon" if no withAuthContext
 * is active. Used by audit emissions that may fire outside a request context
 * (lifecycle hooks, background tasks) so records always carry an actor.
 */
export function getCurrentAgentId(): string {
  return authContext.getStore()?.agent_id ?? "daemon";
}
