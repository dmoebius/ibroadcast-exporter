import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";

export const CLIENT_NAME = "ibroadcast-exporter";
export const CLIENT_VERSION = "0.1.0";

/** An error caused by usage or configuration; printed without stack trace. */
export class UserError extends Error {}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, CLIENT_NAME);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Write via temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

export async function getClientId(): Promise<string> {
  const fromEnv = process.env.IBROADCAST_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  const file = join(configDir(), "config.json");
  const cfg = await readJson<{ clientId?: string }>(file);
  if (cfg?.clientId) return cfg.clientId;
  throw new UserError(
    `No iBroadcast client id. Set IBROADCAST_CLIENT_ID or create ${file} with {"clientId": "..."}.`,
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
