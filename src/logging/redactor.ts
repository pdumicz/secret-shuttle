const SECRET_PATTERNS: RegExp[] = [
  /\bwhsec_[A-Za-z0-9_=-]{8,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9_=-]{8,}\b/g,
  /\brk_(?:live|test)_[A-Za-z0-9_=-]{8,}\b/g,
  /\bpk_(?:live|test)_[A-Za-z0-9_=-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redactKnownSecrets(value: string, knownSecrets: string[] = []): string {
  let redacted = value;
  for (const secret of knownSecrets) {
    if (secret !== "") {
      redacted = redacted.split(secret).join("[REDACTED_SECRET]");
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_SECRET_PATTERN]");
  }

  return redacted;
}
