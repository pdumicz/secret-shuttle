import { Command } from "commander";
import { getDaemonStatus, startDaemon, stopDaemon } from "../../daemon/lifecycle.js";
import { daemonRequest } from "../../client/daemon-client.js";
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
  c.command("rotate")
    .description(
      "Rotate the daemon's root token. Invalidates ALL derived agent tokens immediately. Re-run `secret-shuttle init` afterwards to re-issue per-agent tokens.",
    )
    .action(async () => {
      const r = await daemonRequest("POST", "/v1/daemon/rotate");
      outputJson(ok(r as Record<string, unknown>));
    });
  c.command("reset-machine-id")
    .description(
      "Reset <SHUTTLE_HOME>/machine-id. Future `init` runs will derive different per-runtime agent_ids. Does NOT revoke existing tokens; use `daemon rotate` for revocation.",
    )
    .action(async () => {
      const r = await daemonRequest("POST", "/v1/daemon/reset-machine-id");
      outputJson(ok(r as Record<string, unknown>));
    });

  c.addHelpText("after", `
Examples:
  # Start the daemon (spawns the local Unix-socket service):
  secret-shuttle daemon start

  # Check daemon health (port, pid, lifecycle state):
  secret-shuttle daemon status

  # Stop the daemon:
  secret-shuttle daemon stop

  # Rotate the root token (invalidates ALL agent tokens; re-run \`init\`):
  secret-shuttle daemon rotate

  # Reset the machine-id file (does NOT revoke tokens; changes future agent_ids):
  secret-shuttle daemon reset-machine-id
`);

  return c;
}
