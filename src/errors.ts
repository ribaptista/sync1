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
