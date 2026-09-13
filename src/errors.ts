/**
 * A data-integrity problem: the vault (or something claiming to be part of
 * it) doesn't make sense -- a stub with malformed or unverifiable content, a
 * decryption/authentication failure, a hash mismatch, an entry referencing
 * an object that doesn't exist. Distinguished from a generic operational
 * failure (network error, wrong password, missing local setup) so commands
 * can report it with a distinct exit code (see cli/output.ts).
 */
export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptionError";
  }
}

/**
 * Another sync1 process already holds the per-vault lock (`.sync1/lock`)
 * for this root -- see src/vault/lock.ts. Conceptually the same class of
 * thing as a CAS-detected remote divergence (another actor doing something
 * incompatible), not a generic operational failure or a corruption.
 */
export class VaultLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultLockedError";
  }
}
