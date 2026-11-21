/** `checksums.sfv`: one line `<relative path> <CRC32 hex>` per verified Track. */
import { appendFile, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";
import { writeFileAtomic } from "./config.ts";

const HEADER = "; CRC-32 checksums of exported Originals (ibroadcast-exporter)\n";

export const SFV_FILE = "checksums.sfv";

export const crcHex = (crc: number) => crc.toString(16).toUpperCase().padStart(8, "0");

/** relPath → CRC; later lines win (a re-downloaded file appends a new line). */
export async function loadSfv(path: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(";")) continue;
    const m = /^(.*) ([0-9A-Fa-f]{8})$/.exec(line);
    if (m) out.set(m[1]!, parseInt(m[2]!, 16));
  }
  return out;
}

/** Serializes appends from concurrent workers. */
export class SfvWriter {
  #path: string;
  #chain: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(path: string) {
    this.#path = path;
  }

  append(relPath: string, crc: number): Promise<void> {
    this.#chain = this.#chain.then(async () => {
      if (!this.#initialized) {
        this.#initialized = true;
        const existing = await readFile(this.#path, "utf8").catch(() => "");
        if (!existing) await appendFile(this.#path, HEADER);
      }
      await appendFile(this.#path, `${relPath} ${crcHex(crc)}\n`);
    });
    return this.#chain;
  }
}

/** Rewrite the whole file (used when entries are removed). */
export async function writeSfv(path: string, entries: Map<string, number>): Promise<void> {
  const lines = [...entries].map(([relPath, crc]) => `${relPath} ${crcHex(crc)}\n`);
  await writeFileAtomic(path, HEADER + lines.join(""));
}

export async function crcOfFile(path: string, onBytes?: (n: number) => void): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    crc = crc32(chunk as Buffer, crc);
    onBytes?.((chunk as Buffer).length);
  }
  return crc;
}
