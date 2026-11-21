import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { extractSingleEntry } from "../src/zip.ts";

/** Build a ZIP like iBroadcast's: stored entry, data descriptor, central directory. */
function makeZip(data: Buffer, name = "a/b.mp3", crc = crc32(data)): Buffer {
  const n = Buffer.from(name);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6);
  h.writeUInt16LE(n.length, 26);
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(data.length, 12);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([h, n, data, d, cd]);
}
async function* chunked(buf: Buffer, size = 7) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
async function extract(zip: Buffer, size: number) {
  const out: Buffer[] = [];
  const entry = await extractSingleEntry(chunked(zip), size, (c) => void out.push(Buffer.from(c)));
  return { entry, data: Buffer.concat(out) };
}

const payload = Buffer.from("hello original audio bytes ".repeat(50));

test("extracts the entry and verifies CRC", async () => {
  const { entry, data } = await extract(makeZip(payload), payload.length);
  assert.deepEqual(data, payload);
  assert.equal(entry.name, "a/b.mp3");
  assert.equal(entry.crc, crc32(payload));
});

test("rejects CRC mismatch", async () => {
  await assert.rejects(extract(makeZip(payload, "x", 1234), payload.length), /CRC mismatch/);
});

test("rejects size mismatch in both directions", async () => {
  await assert.rejects(extract(makeZip(payload), payload.length - 5), /size mismatch/);
  await assert.rejects(extract(makeZip(payload), payload.length + 5), /size mismatch|truncated/);
});

test("rejects truncated stream", async () => {
  const zip = makeZip(payload);
  await assert.rejects(extract(zip.subarray(0, 200), payload.length), /truncated/);
});

test("rejects non-zip responses", async () => {
  await assert.rejects(extract(Buffer.from('{"result":false,"message":"nope", "padding": "..........."}'), 10), /not a ZIP/);
});
