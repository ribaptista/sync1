import pino from "pino";

/**
 * All logging is diagnostic output on stderr only, so it never interferes
 * with --json result parsing on stdout. Default level is "warn"; --verbose
 * raises it to "debug". Call sites should pass structured context fields
 * (never string-interpolate), and derive child loggers bound with run-level
 * context (command name, version_stamp, etc.) via `logger.child({...})`.
 */
export function createLogger(verbose: boolean): pino.Logger {
  return pino(
    {
      level: verbose ? "debug" : "warn",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ fd: 2, sync: false }),
  );
}

export type Logger = pino.Logger;
