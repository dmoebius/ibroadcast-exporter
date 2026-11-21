/** Pure export planning: Library → where every Track and every Album's Cover Art goes. */
import type { Library, Track } from "./library.ts";

export const MAX_NAME_BYTES = 200;
/** Two uploads count as the same recording only if their durations differ by at most this. */
export const DUPLICATE_LENGTH_TOLERANCE_S = 2;
export const VARIOUS_ARTISTS = "Various Artists";
export const UNKNOWN_ARTIST = "Unknown Artist";
export const UNKNOWN_ALBUM = "Unknown Album";

const MIME_EXT: Record<string, string> = {
  "audio/mpeg3": "mp3",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/x-mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/x-ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/x-ms-wma": "wma",
};

export type PlannedTrack = {
  track: Track;
  /** Relative to the Export Directory, "/"-separated. */
  relPath: string;
  /** Album folder, relative to the Export Directory. */
  folder: string;
  ext: string;
  /** True if this Track got a ` [id]` suffix because another Track claimed the plain name. */
  collision: boolean;
  /** True if the MIME type was unknown and `.bin` is used. */
  unknownType: boolean;
};

export type PlannedCover = {
  folder: string;
  artworkId: string;
};

/** Two uploads of the same recording; only the better-quality (larger) one is exported. */
export type Duplicate = {
  kept: PlannedTrack;
  skipped: Track;
  /** Where the skipped Track would have been put as a collision; removed if found on disk. */
  staleRelPath: string;
  /** The kept Track's own collision name (used by earlier versions of this tool); moved to the plain path if complete. */
  keptStaleRelPath: string;
};

export type Plan = {
  /** Sorted by relPath. Skipped duplicates are not included. */
  tracks: PlannedTrack[];
  duplicates: Duplicate[];
  covers: PlannedCover[];
  /** Album folders where no Track has artwork. */
  foldersWithoutCover: string[];
};

// ---------------------------------------------------------------------------
// Names

/** Make one path component safe for ext4, NTFS and SMB. */
export function cleanName(raw: string): string {
  let s = raw
    .normalize("NFC")
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .trim();
  s = s.replace(/\.+$/, (dots) => "_".repeat(dots.length));
  return s === "" ? "_" : s;
}

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/** Cut to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/** A clean component of at most MAX_NAME_BYTES; `tail` (suffix + extension) is never cut. */
export function componentName(base: string, tail = ""): string {
  const budget = Math.max(1, MAX_NAME_BYTES - byteLength(tail));
  let head = truncateBytes(cleanName(base), budget);
  head = cleanName(head); // truncation may expose trailing whitespace/dots
  return head + tail;
}

export function extensionFor(mime: string): string | undefined {
  return MIME_EXT[mime.toLowerCase().split(";")[0]!.trim()];
}

const pathKey = (p: string) => p.normalize("NFC").toLowerCase();

const normTitle = (s: string) => s.trim().normalize("NFC").toLowerCase();

/** Same recording uploaded twice: all metadata equal, only size (bitrate, embedded tags) differs. */
export function sameRecording(a: Track, b: Track): boolean {
  return (
    a.artistId === b.artistId &&
    a.year === b.year &&
    a.trackNo === b.trackNo &&
    normTitle(a.title) === normTitle(b.title) &&
    Math.abs(a.length - b.length) <= DUPLICATE_LENGTH_TOLERANCE_S
  );
}

function mostCommon<T>(values: T[], tieBreak: (a: T, b: T) => number): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== undefined && tieBreak(v, best) < 0)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Planning

type AlbumGroup = {
  folder: string;
  /** disc number → tracks of that Disc */
  discs: Map<number, Track[]>;
};

export function planExport(lib: Library): Plan {
  const artistName = (id: string) => (id ? lib.artists.get(id)?.trim() ?? "" : "");

  // Tracks per iBroadcast album entry (= Disc); unknown/missing album ids go to a synthetic entry.
  const tracksByDisc = new Map<string, Track[]>();
  for (const t of lib.tracks.values()) {
    if (t.trashed) continue;
    const key = t.albumId && lib.discs.has(t.albumId) ? t.albumId : `orphan:${t.artistId}`;
    let list = tracksByDisc.get(key);
    if (!list) tracksByDisc.set(key, (list = []));
    list.push(t);
  }

  // Resolve each Disc's Album folder and merge Discs that land in the same folder into one Album.
  const groups = new Map<string, AlbumGroup>();
  const discKeys = [...tracksByDisc.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const discKey of discKeys) {
    const tracks = tracksByDisc.get(discKey)!;
    const entry = lib.discs.get(discKey);

    let artist = artistName(entry?.artistId ?? "");
    if (!artist) {
      const trackArtists = new Set(tracks.map((t) => artistName(t.artistId)).filter(Boolean));
      artist = trackArtists.size === 1 ? [...trackArtists][0]! : trackArtists.size > 1 ? VARIOUS_ARTISTS : UNKNOWN_ARTIST;
    }
    const year =
      entry?.year ||
      mostCommon(
        tracks.map((t) => t.year).filter((y) => y > 0),
        (a, b) => a - b,
      ) ||
      0;
    const name = entry?.name.trim() || UNKNOWN_ALBUM;
    const folder = `${componentName(artist)}/${componentName(year ? `${year} - ${name}` : name)}`;

    let group = groups.get(pathKey(folder));
    if (!group) groups.set(pathKey(folder), (group = { folder, discs: new Map() }));
    const discNo = entry?.disc || 1;
    group.discs.set(discNo, [...(group.discs.get(discNo) ?? []), ...tracks]);
  }

  // Name every Track. Tracks that land on the same path are either duplicates (same recording:
  // only the larger, i.e. better-quality, upload is kept) or real collisions (lowest Track id
  // keeps the plain name, the others get a ` [id]` suffix).
  type Draft = { track: Track; folder: string; base: string; ext: string; unknownType: boolean };
  const drafts: Draft[] = [];
  for (const group of groups.values()) {
    const multiDisc = group.discs.size > 1;
    for (const [discNo, tracks] of group.discs) {
      const width = Math.max(...tracks.map((t) => t.trackNo)) >= 100 ? 3 : 2;
      for (const t of tracks) {
        const title = t.title.trim() || `Track ${t.id}`;
        const prefix = t.trackNo > 0 ? `${multiDisc ? `${String(discNo).padStart(2, "0")}-` : ""}${String(t.trackNo).padStart(width, "0")} ` : "";
        const ext = extensionFor(t.mime);
        drafts.push({ track: t, folder: group.folder, base: prefix + title, ext: ext ?? "bin", unknownType: !ext });
      }
    }
  }
  const byId = (a: Draft, b: Draft) => Number(a.track.id) - Number(b.track.id) || a.track.id.localeCompare(b.track.id);
  const plainPath = (d: Draft) => `${d.folder}/${componentName(d.base, `.${d.ext}`)}`;
  const suffixedPath = (d: Draft) => `${d.folder}/${componentName(d.base, ` [${d.track.id}].${d.ext}`)}`;

  const byPath = new Map<string, Draft[]>();
  for (const d of drafts) {
    const key = pathKey(plainPath(d));
    byPath.set(key, [...(byPath.get(key) ?? []), d]);
  }

  const planned: PlannedTrack[] = [];
  const duplicates: Duplicate[] = [];
  for (const group of byPath.values()) {
    // Collapse same-recording uploads to the best one; better = larger, tie → lower Track id.
    const keepers: Array<{ best: Draft; skipped: Draft[] }> = [];
    for (const d of [...group].sort((a, b) => b.track.size - a.track.size || byId(a, b))) {
      const same = keepers.find((k) => sameRecording(k.best.track, d.track));
      if (same) same.skipped.push(d);
      else keepers.push({ best: d, skipped: [] });
    }
    keepers.sort((a, b) => byId(a.best, b.best));
    keepers.forEach(({ best: d, skipped }, i) => {
      const relPath = i === 0 ? plainPath(d) : suffixedPath(d);
      const kept: PlannedTrack = { track: d.track, relPath, folder: d.folder, ext: d.ext, collision: i > 0, unknownType: d.unknownType };
      planned.push(kept);
      for (const s of skipped) duplicates.push({ kept, skipped: s.track, staleRelPath: suffixedPath(s), keptStaleRelPath: suffixedPath(d) });
    });
  }
  planned.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  // Cover Art: the artwork used by most Tracks of the Album.
  const covers: PlannedCover[] = [];
  const foldersWithoutCover: string[] = [];
  for (const group of groups.values()) {
    const artworkIds = [...group.discs.values()].flat().flatMap((t) => (t.artworkId ? [t.artworkId] : []));
    const artworkId = mostCommon(artworkIds, (a, b) => Number(a) - Number(b));
    if (artworkId) covers.push({ folder: group.folder, artworkId });
    else foldersWithoutCover.push(group.folder);
  }
  covers.sort((a, b) => (a.folder < b.folder ? -1 : 1));
  foldersWithoutCover.sort();

  duplicates.sort((a, b) => (a.kept.relPath < b.kept.relPath ? -1 : 1));
  return { tracks: planned, duplicates, covers, foldersWithoutCover };
}
