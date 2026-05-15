import { Command } from "commander";
import { getDaemonStatus, startDaemon, stopDaemon } from "../../daemon/lifecycle.js";
import { ok, outputJson } from "../../shared/result.js";

export function daemonCommand(): Command {
  const c = new Command("daemon").description("Manage the local Secret Shuttle daemon.");
  c.command("start").action(async () => {
    const sf = await startDaemon();
    outputJson(ok({ started: true, port: sf.port, pid: sf.pid }));
  });
  c.command("status").action(async () => {
    outputJson(ok(await getDaemonStatus() as Record<string, unknown>));
  });
  c.command("stop").action(async () => {
    await stopDaemon();
    outputJson(ok({ stopped: true }));
  });
  return c;
}
