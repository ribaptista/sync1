/** All --json output goes to stdout as a single line; logs stay on stderr (see src/logger.ts). */
export function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

export const EXIT_GENERIC_ERROR = 1;
export const EXIT_CONFLICT = 2;
export const EXIT_CORRUPTION = 3;

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
