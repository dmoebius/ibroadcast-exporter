/**
 * Streaming extraction of the single-entry ZIPs returned by iBroadcast's download endpoint:
 * one stored (uncompressed) entry, usually followed by a data descriptor carrying CRC and size.
 */
import { crc32 } from "node:zlib";

const LOCAL_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;

export class ZipError extends Error {}

/** Reads exact byte counts from an async stream of chunks. */
class ByteReader {
  #it: AsyncIterator<Uint8Array>;
  #buf: Buffer = Buffer.alloc(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#it = source[Symbol.asyncIterator]();
  }

  async #pull(): Promise<void> {
    const r = await this.#it.next();
    if (r.done) throw new ZipError("stream ended prematurely (truncated download)");
    const chunk = Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
  }

  async read(n: number): Promise<Buffer> {
    while (this.#buf.length < n) await this.#pull();
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }

  async *chunks(n: number): AsyncGenerator<Buffer> {
    let remaining = n;
    while (remaining > 0) {
      if (this.#buf.length === 0) await this.#pull();
      const take = Math.min(remaining, this.#buf.length);
      yield this.#buf.subarray(0, take);
      this.#buf = this.#buf.subarray(take);
      remaining -= take;
    }
  }

  /** Release the underlying stream (e.g. close the HTTP connection). */
  async close(): Promise<void> {
    await this.#it.return?.();
  }
}

export type ExtractedEntry = { name: string; crc: number };

/**
 * Stream the ZIP's only entry into `sink`, which must accept exactly `expectedSize` bytes.
 * Throws ZipError if the archive is malformed, truncated, has another size, or fails the CRC check.
 */
export async function extractSingleEntry(
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
  sink: (chunk: Buffer) => Promise<void> | void,
): Promise<ExtractedEntry> {
  const reader = new ByteReader(source);
  try {
    const header = await reader.read(30);
    if (header.readUInt32LE(0) !== LOCAL_HEADER_SIG) throw new ZipError("response is not a ZIP archive");
    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    if (method !== METHOD_STORED) throw new ZipError(`unsupported ZIP compression method ${method}`);
    const headerCrc = header.readUInt32LE(14);
    const headerSize = header.readUInt32LE(18);
    const name = (await reader.read(header.readUInt16LE(26))).toString(flags & FLAG_UTF8 ? "utf8" : "latin1");
    await reader.read(header.readUInt16LE(28)); // extra field

    const hasDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
    if (!hasDescriptor && headerSize !== expectedSize) {
      throw new ZipError(`size mismatch: archive says ${headerSize}, library says ${expectedSize}`);
    }

    let crc = 0;
    for await (const chunk of reader.chunks(expectedSize)) {
      crc = crc32(chunk, crc);
      await sink(chunk);
    }

    let expectedCrc = headerCrc;
    if (hasDescriptor) {
      let desc = await reader.read(4);
      if (desc.readUInt32LE(0) === DATA_DESCRIPTOR_SIG) desc = await reader.read(4);
      expectedCrc = desc.readUInt32LE(0);
      const sizes = await reader.read(8);
      const size = sizes.readUInt32LE(4);
      if (size !== expectedSize % 2 ** 32) {
        throw new ZipError(`size mismatch: archive says ${size}, library says ${expectedSize}`);
      }
    }
    // If the library size was too small, we are now in the middle of the data, not at the next record.
    const next = (await reader.read(4)).readUInt32LE(0);
    if (next === LOCAL_HEADER_SIG) throw new ZipError("archive contains more than one entry");
    if (next !== 0x02014b50) throw new ZipError("size mismatch: unexpected data after entry");

    if (crc !== expectedCrc) {
      throw new ZipError(`CRC mismatch: computed ${crc.toString(16)}, archive says ${expectedCrc.toString(16)}`);
    }
    return { name, crc };
  } finally {
    await reader.close().catch(() => undefined);
  }
}
