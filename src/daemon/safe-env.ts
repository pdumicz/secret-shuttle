// src/daemon/safe-env.ts
/**
 * Build a minimal env for the daemon child. We do NOT inherit the parent env —
 * an attacker who can set NODE_OPTIONS / LD_PRELOAD / DYLD_INSERT_LIBRARIES /
 * DYLD_LIBRARY_PATH in the parent process would otherwise inject code into the
 * daemon before any sanitization in main() runs.
 *
 * Only the explicit allowlist below is forwarded. The PATH is replaced with a
 * fixed system-dir set so resolveBinary stays safe even if a child process
 * (e.g. a template) accidentally reads PATH.
 */
export function buildDaemonEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SECRET_SHUTTLE_HOME",
    "SECRET_SHUTTLE_NO_OPEN_URL",
    // Windows-only basics:
    "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "ComSpec",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = safeDaemonPath();
  return env;
}

/**
 * Env for daemon-spawned children (templates, Chrome). Minimal allowlist, hardened
 * PATH, and a hard guarantee that NO SECRET_SHUTTLE_* (esp. the bearer token /
 * master key) is ever forwarded — a child must never be able to call the daemon API.
 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "ComSpec",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (key.startsWith("SECRET_SHUTTLE_")) continue;
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = safeDaemonPath();
  return env;
}

/** Remove daemon-only secrets from process.env so children cannot inherit them. */
export function scrubDaemonSecretsFromEnv(): void {
  delete process.env.SECRET_SHUTTLE_DAEMON_TOKEN;
  delete process.env.SECRET_SHUTTLE_MASTER_KEY;
}

export function safeDaemonPath(): string {
  if (process.platform === "darwin") {
    return ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  }
  if (process.platform === "win32") {
    return [
      "C:\\Windows\\System32",
      "C:\\Windows",
      "C:\\Windows\\System32\\Wbem",
      "C:\\Program Files\\Vercel CLI",
    ].join(";");
  }
  // Linux + everything else
  return ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":");
}
