/** Typed view on iBroadcast's compact library format: `{ map: {field: index}, <id>: [values] }`. */

export type Track = {
  id: string;
  title: string;
  trackNo: number;
  year: number;
  albumId: string;
  artistId: string;
  artworkId: string | null;
  size: number;
  /** Duration in seconds. */
  length: number;
  mime: string;
  trashed: boolean;
};

/** One iBroadcast "album" entry; in our vocabulary this is a Disc. */
export type DiscEntry = {
  id: string;
  name: string;
  artistId: string;
  disc: number;
  year: number;
  trackIds: string[];
  trashed: boolean;
};

export type Library = {
  tracks: Map<string, Track>;
  discs: Map<string, DiscEntry>;
  artists: Map<string, string>;
  artworkServer: string;
};

type Section = { map?: Record<string, unknown> } & Record<string, unknown>;

function rows(section: Section | undefined): Array<[string, (field: string) => unknown]> {
  if (!section?.map) return [];
  const map = section.map as Record<string, number>;
  const out: Array<[string, (field: string) => unknown]> = [];
  for (const [id, row] of Object.entries(section)) {
    if (id === "map" || !Array.isArray(row)) continue;
    out.push([id, (field) => (typeof map[field] === "number" ? row[map[field]] : undefined)]);
  }
  return out;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const id = (v: unknown): string => (v === null || v === undefined || v === 0 || v === "0" ? "" : String(v));

export function parseLibrary(response: any): Library {
  const lib = response?.library;
  if (!lib?.tracks) throw new Error("library response contains no tracks");

  const tracks = new Map<string, Track>();
  for (const [tid, f] of rows(lib.tracks)) {
    tracks.set(tid, {
      id: tid,
      title: str(f("title")),
      trackNo: num(f("track")),
      year: num(f("year")),
      albumId: id(f("album_id")),
      artistId: id(f("artist_id")),
      artworkId: id(f("artwork_id")) || null,
      size: num(f("size")),
      length: num(f("length")),
      mime: str(f("type")),
      trashed: f("trashed") === true,
    });
  }

  const discs = new Map<string, DiscEntry>();
  for (const [aid, f] of rows(lib.albums)) {
    const trackIds = f("tracks");
    discs.set(aid, {
      id: aid,
      name: str(f("name")),
      artistId: id(f("artist_id")),
      disc: num(f("disc")) || 1,
      year: num(f("year")),
      trackIds: Array.isArray(trackIds) ? trackIds.map(String) : [],
      trashed: f("trashed") === true,
    });
  }

  const artists = new Map<string, string>();
  for (const [rid, f] of rows(lib.artists)) artists.set(rid, str(f("name")));

  return {
    tracks,
    discs,
    artists,
    artworkServer: str(response?.settings?.artwork_server) || "https://artwork.ibroadcast.com",
  };
}
