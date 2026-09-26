export interface RemoteConfig {
  bucket: string;
  prefix: string;
  endpoint?: string;
  region: string;
  /**
   * Absolute path to a local directory (or network mount) holding a
   * second, offline copy of the encrypted vault -- the same four key
   * classes the bucket holds, at byte-identical paths. Absent means no
   * mirror, which is the default and changes nothing.
   *
   * Set by hand; `init_remote`/`attach_remote` neither write nor ask for
   * it. Validated on use rather than on parse, by `resolveMirrorPath` in
   * mirror-paths.ts, which needs the vault root to check it.
   */
  mirror_path?: string;
}

export function serializeRemoteConfig(config: RemoteConfig): Buffer {
  return Buffer.from(JSON.stringify(config, null, 2), "utf8");
}

export function parseRemoteConfig(data: Buffer): RemoteConfig {
  return JSON.parse(data.toString("utf8")) as RemoteConfig;
}
