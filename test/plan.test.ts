import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiscEntry, Library, Track } from "../src/library.ts";
import { cleanName, componentName, planExport } from "../src/plan.ts";

let nextId = 1000;
function track(p: Partial<Track> & { albumId: string }): Track {
  return { id: String(nextId++), title: "Song", trackNo: 1, year: 0, artistId: "1", artworkId: "500", size: 10, length: 200, mime: "audio/mpeg3", trashed: false, ...p };
}
function lib(discs: Array<Partial<DiscEntry> & { id: string }>, tracks: Track[]): Library {
  return {
    tracks: new Map(tracks.map((t) => [t.id, t])),
    discs: new Map(discs.map((d) => [d.id, { name: "Album", artistId: "1", disc: 1, year: 2000, trackIds: [], trashed: false, ...d }])),
    artists: new Map([["1", "Artist"], ["2", "Other"]]),
    artworkServer: "x",
  };
}
const paths = (l: Library) => planExport(l).tracks.map((t) => t.relPath);

test("basic layout with year and two-digit numbers", () => {
  assert.deepEqual(paths(lib([{ id: "a" }], [track({ albumId: "a", trackNo: 3, title: "Hello" })])), ["Artist/2000 - Album/03 Hello.mp3"]);
});

test("no year: folder is just the album name; year falls back to most common track year", () => {
  assert.deepEqual(paths(lib([{ id: "a", year: 0 }], [track({ albumId: "a" })])), ["Artist/Album/01 Song.mp3"]);
  const l = lib([{ id: "a", year: 0 }], [track({ albumId: "a", year: 1999 }), track({ albumId: "a", year: 1999, trackNo: 2 }), track({ albumId: "a", year: 2001, trackNo: 3 })]);
  assert.ok(paths(l).every((p) => p.startsWith("Artist/1999 - Album/")));
});

test("multi-disc albums share one folder with disc prefix; width per disc", () => {
  const l = lib(
    [{ id: "a", disc: 1 }, { id: "b", disc: 2 }],
    [track({ albumId: "a", trackNo: 1 }), track({ albumId: "b", trackNo: 120, title: "Long" })],
  );
  assert.deepEqual(paths(l), ["Artist/2000 - Album/01-01 Song.mp3", "Artist/2000 - Album/02-120 Long.mp3"]);
  const l2 = lib([{ id: "a" }], [track({ albumId: "a", trackNo: 5 }), track({ albumId: "a", trackNo: 100, title: "X" })]);
  assert.deepEqual(paths(l2), ["Artist/2000 - Album/005 Song.mp3", "Artist/2000 - Album/100 X.mp3"]);
});

test("missing album artist: single track artist, else Various Artists", () => {
  assert.ok(paths(lib([{ id: "a", artistId: "" }], [track({ albumId: "a", artistId: "2" })]))[0]!.startsWith("Other/"));
  const l = lib([{ id: "a", artistId: "" }], [track({ albumId: "a", artistId: "1" }), track({ albumId: "a", artistId: "2", trackNo: 2 })]);
  assert.ok(paths(l).every((p) => p.startsWith("Various Artists/2000 - Album/")));
});

test("placeholders for missing number, title, album", () => {
  const l = lib([{ id: "a", name: " " }], [track({ albumId: "a", trackNo: 0, title: "", id: "77" })]);
  assert.deepEqual(paths(l), ["Artist/2000 - Unknown Album/Track 77.mp3"]);
});

test("collisions: lowest track id keeps the plain name, case-insensitive", () => {
  const l = lib([{ id: "a" }], [track({ albumId: "a", id: "9", title: "song", length: 300 }), track({ albumId: "a", id: "5", title: "Song" })]);
  const plan = planExport(l);
  assert.deepEqual(plan.tracks.map((t) => [t.track.id, t.relPath, t.collision]), [
    ["5", "Artist/2000 - Album/01 Song.mp3", false],
    ["9", "Artist/2000 - Album/01 song [9].mp3", true],
  ]);
});

test("extensions from MIME type, unknown → bin", () => {
  const l = lib([{ id: "a" }], [track({ albumId: "a", mime: "audio/mp4" }), track({ albumId: "a", trackNo: 2, mime: "audio/ogg" }), track({ albumId: "a", trackNo: 3, mime: "x/y" })]);
  const plan = planExport(l);
  assert.deepEqual(plan.tracks.map((t) => t.ext), ["m4a", "ogg", "bin"]);
  assert.equal(plan.tracks.filter((t) => t.unknownType).length, 1);
});

test("sanitizing and byte limit", () => {
  assert.equal(cleanName(' AC/DC: "Live"? '), 'AC_DC_ _Live__');
  assert.equal(cleanName("Vol."), "Vol_");
  assert.equal(cleanName(""), "_");
  const long = componentName("ä".repeat(300), " [123].mp3");
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith(" [123].mp3"));
});

test("cover art: most common artwork across all discs", () => {
  const l = lib(
    [{ id: "a", disc: 1 }, { id: "b", disc: 2 }],
    [track({ albumId: "a", artworkId: "7" }), track({ albumId: "b", artworkId: "8" }), track({ albumId: "b", trackNo: 2, artworkId: "8" })],
  );
  assert.deepEqual(planExport(l).covers, [{ folder: "Artist/2000 - Album", artworkId: "8" }]);
});

test("duplicates: same recording uploaded twice → only the larger (better) upload, under the plain name", () => {
  const l = lib(
    [{ id: "a" }, { id: "b" }],
    [track({ albumId: "a", id: "5", size: 6_000_000 }), track({ albumId: "b", id: "9", size: 15_000_000, length: 201 })],
  );
  const plan = planExport(l);
  assert.deepEqual(plan.tracks.map((t) => [t.track.id, t.relPath, t.collision]), [["9", "Artist/2000 - Album/01 Song.mp3", false]]);
  assert.deepEqual(plan.duplicates.map((d) => [d.kept.track.id, d.skipped.id, d.staleRelPath]), [["9", "5", "Artist/2000 - Album/01 Song [5].mp3"]]);
});

test("duplicates: differing year, artist or duration means a real collision", () => {
  for (const diff of [{ year: 1999 }, { artistId: "2" }, { length: 260 }]) {
    const l = lib([{ id: "a" }], [track({ albumId: "a", id: "5" }), track({ albumId: "a", id: "9", size: 99, ...diff })]);
    const plan = planExport(l);
    assert.equal(plan.duplicates.length, 0);
    assert.deepEqual(plan.tracks.map((t) => [t.track.id, t.collision]).sort(), [["5", false], ["9", true]]);
  }
});

test("incomplete albums are normal: gaps in track numbers and missing discs", () => {
  const gaps = lib([{ id: "a" }], [track({ albumId: "a", trackNo: 2 }), track({ albumId: "a", trackNo: 7, title: "B" })]);
  assert.deepEqual(paths(gaps), ["Artist/2000 - Album/02 Song.mp3", "Artist/2000 - Album/07 B.mp3"]);
  const missingDisc = lib([{ id: "a", disc: 1 }, { id: "c", disc: 3 }], [track({ albumId: "a" }), track({ albumId: "c", title: "C" })]);
  assert.deepEqual(paths(missingDisc), ["Artist/2000 - Album/01-01 Song.mp3", "Artist/2000 - Album/03-01 C.mp3"]);
  const onlyDisc2 = lib([{ id: "b", disc: 2 }], [track({ albumId: "b" })]);
  assert.deepEqual(paths(onlyDisc2), ["Artist/2000 - Album/01 Song.mp3"]);
});
