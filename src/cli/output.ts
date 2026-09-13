import { CorruptionError, VaultLockedError } from "../errors.js";

/** All --json output goes to stdout as a single line; logs stay on stderr (see src/logger.ts). */
export function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

export const EXIT_GENERIC_ERROR = 1;
export const EXIT_CONFLICT = 2;
export const EXIT_CORRUPTION = 3;

/**
 * The exit code every command's catch block should use for a given error,
 * beyond the generic default -- CorruptionError (and its subclasses, e.g.
 * a malformed/unverifiable stub) always maps to EXIT_CORRUPTION. A command
 * with its own additional error categories (e.g. sync's RemoteDivergedError
 * -> EXIT_CONFLICT) should check those first and fall back to this.
 */
export function exitCodeForError(err: unknown): number | undefined {
  if (err instanceof CorruptionError) return EXIT_CORRUPTION;
  if (err instanceof VaultLockedError) return EXIT_CONFLICT;
  return undefined;
}

export function emitError(
  json: boolean,
  message: string,
  exitCode: number = EXIT_GENERIC_ERROR,
): void {
  if (json) {
    emitJson({ ok: false, error: message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = exitCode;
}
