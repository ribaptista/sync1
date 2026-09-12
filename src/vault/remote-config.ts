export interface RemoteConfig {
  bucket: string;
  prefix: string;
  endpoint?: string;
  region: string;
}

export function serializeRemoteConfig(config: RemoteConfig): Buffer {
  return Buffer.from(JSON.stringify(config, null, 2), "utf8");
}

export function parseRemoteConfig(data: Buffer): RemoteConfig {
  return JSON.parse(data.toString("utf8")) as RemoteConfig;
}
