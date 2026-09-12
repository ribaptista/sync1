import { randomBytes } from "node:crypto";

/** A sibling path next to `basePath`, tagged for its purpose, with a random suffix to avoid collisions. */
export function tempSiblingPath(basePath: string, tag: string): string {
  return `${basePath}.${tag}-${randomBytes(4).toString("hex")}`;
}
