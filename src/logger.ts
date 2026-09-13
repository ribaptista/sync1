import pino from "pino";

/**
 * All logging is diagnostic output -- on stderr by default, so it never
 * interferes with --json result parsing on stdout -- or, while progress bars
 * own stderr, on an explicit `destination` (see src/cli/progress.ts, which
 * diverts to fd 3). Default level is "warn"; --verbose raises it to "debug".
 * Call sites should pass structured context fields (never string-interpolate),
 * and derive child loggers bound with run-level context (command name,
 * version_stamp, etc.) via `logger.child({...})`.
 */
export function createLogger(verbose: boolean, destination?: pino.DestinationStream): pino.Logger {
  return pino(
    {
      level: verbose ? "debug" : "warn",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination ?? pino.destination({ fd: 2, sync: false }),
  );
}

export type Logger = pino.Logger;
