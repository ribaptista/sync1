/**
 * Resolves the vault password: `SYNC1_PASSWORD` env var when set (used by
 * automation and e2e tests, so a real interactive TTY is never required),
 * otherwise an interactive masked prompt. The password is deliberately never
 * accepted as a plain CLI argument/flag — that would leak it into shell
 * history and the process list (visible via `ps`).
 */
export async function getPassword(promptText = "Vault password: "): Promise<string> {
  const fromEnv = process.env.SYNC1_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return promptMasked(promptText);
}

function promptMasked(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");

    let input = "";
    const onData = (char: string): void => {
      const code = char.charCodeAt(0);
      if (char === "\n" || char === "\r" || code === 4) {
        cleanup();
        process.stdout.write("\n");
        resolve(input);
        return;
      }
      if (code === 3) {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (code === 127 || code === 8) {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    const cleanup = (): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    stdin.on("data", onData);
  });
}
