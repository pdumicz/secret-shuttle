import { rm, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin as input, stderr as output } from "node:process";
import { Command } from "commander";
import { encryptEnvelope, readEnvelope, writeEnvelope } from "../../vault/envelope.js";
import { decryptVault, encryptVault } from "../../vault/crypto.js";
import { readLegacyKey } from "../../vault/keychain.js";
import { fileExists, getShuttlePaths, writeJsonFileAtomic } from "../../shared/config.js";
import { ShuttleError } from "../../shared/errors.js";
import { ok, outputJson } from "../../shared/result.js";
import type { EncryptedVaultFile } from "../../vault/types.js";

export function migrateCommand(): Command {
  const c = new Command("migrate").description("Run vault migrations.");
  c.command("secure-vault").action(async () => {
    const paths = getShuttlePaths();
    const existingEnvelope = await readEnvelope();
    if (existingEnvelope !== null) {
      throw new ShuttleError("already_migrated", "An envelope already exists. Migration not needed.");
    }
    const legacyKey = await readLegacyKey();
    if (legacyKey === null) {
      throw new ShuttleError("no_legacy_vault", "No legacy master-key.json was found.");
    }
    if (!(await fileExists(paths.vaultPath))) {
      throw new ShuttleError("no_legacy_vault", "No legacy vault.json.enc was found.");
    }

    const [pass, confirm] = await readTwoLines("New vault passphrase: ", "Confirm passphrase: ");
    if (pass !== confirm) {
      throw new ShuttleError("passphrase_mismatch", "Passphrases did not match.");
    }

    const envelope = await encryptEnvelope(legacyKey, pass);
    await writeEnvelope(envelope);

    // Round-trip the vault under the same master key to ensure it is readable.
    const raw = await readFile(paths.vaultPath, "utf8");
    const file = JSON.parse(raw) as EncryptedVaultFile;
    const plain = decryptVault(file, legacyKey);
    await writeJsonFileAtomic(paths.vaultPath, encryptVault(plain, legacyKey));

    await rm(paths.keyPath, { force: true });
    outputJson(ok({ migrated: true, envelope_path: paths.envelopePath }));
  });
  return c;
}

/** Read two lines from stdin, displaying prompts on stderr before each. */
async function readTwoLines(prompt1: string, prompt2: string): Promise<[string, string]> {
  const lines: string[] = [];
  const rl = createInterface({ input, terminal: false });
  output.write(prompt1);
  for await (const line of rl) {
    lines.push(line);
    if (lines.length === 1) output.write(prompt2);
    if (lines.length === 2) break;
  }
  rl.close();
  return [lines[0] ?? "", lines[1] ?? ""];
}
