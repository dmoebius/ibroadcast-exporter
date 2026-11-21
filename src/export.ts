/** One Export: load the Library, plan, download what is missing, write the Export Report. */
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { ApiError, type IBroadcastApi } from "./api.ts";
import { sleep, writeFileAtomic } from "./config.ts";
import { parseLibrary } from "./library.ts";
import { planExport, type Duplicate, type PlannedCover, type PlannedTrack } from "./plan.ts";
import { Progress, formatBytes } from "./progress.ts";
import { renderReport, reportFileName, type ExportResult } from "./report.ts";
import { crcOfFile, loadSfv, SFV_FILE, SfvWriter, writeSfv } from "./sfv.ts";
import { extractSingleEntry } from "./zip.ts";
import { logError, logFilePath, logLine } from "./log.ts";

export type ExportOptions = {
  dir: string;
  concurrency: number;
  dryRun: boolean;
  verify: boolean;
  limit: number | undefined;
  signal: AbortSignal;
};

const MAX_TRACK_ATTEMPTS = 5;
const MAX_COVER_ATTEMPTS = 3;
const COVER_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];
const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

const log = (msg: string) => {
  logLine(msg);
  process.stderr.write(msg + "\n");
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shared pause for all workers when the server throttles us. */
class ThrottleGate {
  until = 0;
  pauseFor(ms: number) {
    this.until = Math.max(this.until, Date.now() + ms);
  }
  async wait(signal: AbortSignal) {
    while (Date.now() < this.until) await sleep(this.until - Date.now(), signal);
  }
}

async function pool<T>(items: T[], concurrency: number, signal: AbortSignal, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function runExport(api: IBroadcastApi, opts: ExportOptions): Promise<ExportResult> {
  const { dir, signal } = opts;
  const startedAt = new Date();

  log("Loading library…");
  const { raw, data } = await api.fetchLibrary();
  const lib = parseLibrary(data);
  const plan = planExport(lib);
  const tracks = opts.limit !== undefined ? plan.tracks.slice(0, opts.limit) : plan.tracks;
  const exportedIds = new Set(tracks.map((t) => t.track.id));
  const duplicates = plan.duplicates.filter((d) => exportedIds.has(d.kept.track.id));
  const folders = new Set(tracks.map((t) => t.folder));
  const covers = plan.covers.filter((c) => folders.has(c.folder));
  log(
    `Library: ${lib.tracks.size} Tracks, ${plan.covers.length + plan.foldersWithoutCover.length} Albums. ` +
      `This run: ${tracks.length} Tracks (${formatBytes(tracks.reduce((s, t) => s + t.track.size, 0))}), ${covers.length} Cover Art.`,
  );

  const result: ExportResult = {
    startedAt,
    finishedAt: startedAt,
    dir,
    dryRun: opts.dryRun,
    verify: opts.verify,
    limit: opts.limit,
    aborted: false,
    planned: tracks.length,
    plannedBytes: tracks.reduce((s, t) => s + t.track.size, 0),
    alreadyComplete: 0,
    downloaded: 0,
    downloadedBytes: 0,
    failed: [],
    collisions: tracks.filter((t) => t.collision),
    duplicates,
    removedStaleDuplicates: [],
    movedDuplicates: [],
    unknownTypes: tracks.filter((t) => t.unknownType),
    extensionMismatches: [],
    wrongSize: [],
    missingChecksum: [],
    verifyMismatches: [],
    verified: 0,
    coversPlanned: covers.length,
    coversAlreadyPresent: 0,
    coversDownloaded: 0,
    coverFailures: [],
    foldersWithoutCover: plan.foldersWithoutCover.filter((f) => folders.has(f)),
    logFile: logFilePath(),
  };

  if (opts.dryRun) {
    result.finishedAt = new Date();
    return result;
  }

  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, "library.json"), raw);

  try {
    const todo = await scan(tracks, duplicates, opts, result);
    if (!signal.aborted) await downloadTracks(api, todo, opts, result);
    if (!signal.aborted) await downloadCovers(api, lib.artworkServer, covers, opts, result);
  } catch (e) {
    if (!signal.aborted) throw e;
  } finally {
    // Re-downloads append a second line for the same file; keep only the latest so SFV tools agree.
    const sfvPath = join(dir, SFV_FILE);
    const text = await readFile(sfvPath, "utf8").catch(() => "");
    const entries = await loadSfv(sfvPath);
    if (text.split("\n").filter((l) => l && !l.startsWith(";")).length > entries.size) await writeSfv(sfvPath, entries);
  }
  result.aborted = signal.aborted;
  result.finishedAt = new Date();
  logLine(
    `Export finished: aborted=${result.aborted} downloaded=${result.downloaded} alreadyComplete=${result.alreadyComplete} ` +
      `failed=${result.failed.length} coverFailures=${result.coverFailures.length}`,
  );
  return result;
}

export async function writeReport(result: ExportResult): Promise<string> {
  const path = join(result.dir, reportFileName(result.startedAt));
  await writeFileAtomic(path, renderReport(result));
  return path;
}

/** Decide which Tracks still need downloading; with --verify also check CRCs of complete files. */
async function scan(
  tracks: PlannedTrack[],
  duplicates: Duplicate[],
  opts: ExportOptions,
  result: ExportResult,
): Promise<PlannedTrack[]> {
  const sfvPath = join(opts.dir, SFV_FILE);
  const sfv = await loadSfv(sfvPath);

  // Earlier Exports may have stored duplicates under collision names ("… [id].ext"). The kept
  // upload's file is moved to the plain path if complete; everything else is removed.
  // (A worse upload sitting at the plain path is handled below: wrong size → re-download.)
  let sfvChanged = false;
  const seenKept = new Set<string>();
  for (const d of duplicates) {
    const keptSize = d.kept.track.size;
    if (!seenKept.has(d.keptStaleRelPath) && d.keptStaleRelPath !== d.kept.relPath) {
      seenKept.add(d.keptStaleRelPath);
      const staleSize = await fileSize(join(opts.dir, d.keptStaleRelPath));
      if (staleSize !== undefined) {
        const plainSize = await fileSize(join(opts.dir, d.kept.relPath));
        if (staleSize === keptSize && plainSize !== keptSize) {
          await rename(join(opts.dir, d.keptStaleRelPath), join(opts.dir, d.kept.relPath));
          const crc = sfv.get(d.keptStaleRelPath);
          if (crc !== undefined) sfv.set(d.kept.relPath, crc);
          else sfv.delete(d.kept.relPath);
          result.movedDuplicates.push(d.kept.relPath);
          log(`Moved better-quality upload to its plain name: ${d.kept.relPath}`);
        } else {
          await rm(join(opts.dir, d.keptStaleRelPath), { force: true });
          result.removedStaleDuplicates.push(d.keptStaleRelPath);
        }
        sfv.delete(d.keptStaleRelPath);
        sfvChanged = true;
      }
    }
    if ((await fileSize(join(opts.dir, d.staleRelPath))) !== undefined) {
      await rm(join(opts.dir, d.staleRelPath), { force: true });
      sfv.delete(d.staleRelPath);
      sfvChanged = true;
      result.removedStaleDuplicates.push(d.staleRelPath);
      log(`Removed stale duplicate (better quality is kept): ${d.staleRelPath}`);
    }
  }
  if (sfvChanged) await writeSfv(sfvPath, sfv);
  const todo: PlannedTrack[] = [];
  const complete: PlannedTrack[] = [];
  for (const t of tracks) {
    const size = await fileSize(join(opts.dir, t.relPath));
    if (size === t.track.size) complete.push(t);
    else {
      if (size !== undefined) result.wrongSize.push(t.relPath);
      todo.push(t);
    }
  }

  if (opts.verify) {
    const toVerify = complete.filter((t) => sfv.has(t.relPath));
    const progress = new Progress("Verify", toVerify.length, toVerify.reduce((s, t) => s + t.track.size, 0));
    progress.start();
    try {
      for (const t of toVerify) {
        if (opts.signal.aborted) break;
        const crc = await crcOfFile(join(opts.dir, t.relPath), (n) => progress.addBytes(n));
        progress.itemDone();
        result.verified++;
        if (crc !== sfv.get(t.relPath)) {
          result.verifyMismatches.push(t.relPath);
          progress.log(`CRC mismatch, will re-download: ${t.relPath}`);
          await rm(join(opts.dir, t.relPath), { force: true });
          complete.splice(complete.indexOf(t), 1);
          todo.push(t);
        }
      }
    } finally {
      progress.stop();
    }
  }

  result.alreadyComplete = complete.length;
  result.missingChecksum = complete.filter((t) => !sfv.has(t.relPath)).map((t) => t.relPath);
  if (complete.length) log(`${complete.length} Tracks already complete, ${todo.length} to download.`);
  return todo;
}

async function downloadTracks(api: IBroadcastApi, todo: PlannedTrack[], opts: ExportOptions, result: ExportResult) {
  if (todo.length === 0) return;
  const { dir, signal } = opts;
  const sfv = new SfvWriter(join(dir, SFV_FILE));
  const gate = new ThrottleGate();
  const progress = new Progress("Tracks", todo.length, todo.reduce((s, t) => s + t.track.size, 0));
  progress.start();

  const downloadOne = async (t: PlannedTrack) => {
    const finalPath = join(dir, t.relPath);
    const partPath = `${finalPath}.part`;
    for (let attempt = 1; ; attempt++) {
      let written = 0;
      try {
        await gate.wait(signal);
        progress.pausedUntil = gate.until;
        const body = await api.openTrackDownload(t.track.id, signal);
        await mkdir(dirname(finalPath), { recursive: true });
        const fh = await open(partPath, "w");
        let entry;
        try {
          entry = await extractSingleEntry(body, t.track.size, async (chunk) => {
            await fh.write(chunk);
            written += chunk.length;
            progress.addBytes(chunk.length);
          });
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(partPath, finalPath);
        await sfv.append(t.relPath, entry.crc);
        const zipExt = extname(entry.name).slice(1).toLowerCase();
        if (zipExt && zipExt !== t.ext) result.extensionMismatches.push({ track: t, zipName: entry.name });
        result.downloaded++;
        result.downloadedBytes += t.track.size;
        progress.itemDone();
        if (attempt > 1) progress.log(`OK on attempt ${attempt}: ${t.relPath}`);
        return;
      } catch (e) {
        progress.addBytes(-written);
        if (signal.aborted) return; // leave the .part file; the next run starts this Track over
        if (e instanceof ApiError && e.retryAfterMs !== undefined) {
          gate.pauseFor(e.retryAfterMs);
          progress.pausedUntil = gate.until;
        }
        if (attempt >= MAX_TRACK_ATTEMPTS) {
          result.failed.push({ track: t, reason: errMsg(e) });
          logError(`Track ${t.track.id} ${t.relPath}`, e);
          progress.itemFailed();
          progress.log(`FAILED after ${attempt} attempts: ${t.relPath}: ${errMsg(e)}`);
          await rm(partPath, { force: true }).catch(() => undefined);
          return;
        }
        progress.log(`Retry ${attempt}/${MAX_TRACK_ATTEMPTS - 1} for ${t.relPath}: ${errMsg(e)}`);
        try {
          await sleep(2 ** attempt * 1000 + Math.random() * 1000, signal);
        } catch {
          return;
        }
      }
    }
  };

  try {
    await pool(todo, opts.concurrency, signal, downloadOne);
  } finally {
    progress.stop();
  }
}

async function downloadCovers(
  api: IBroadcastApi,
  artworkServer: string,
  covers: PlannedCover[],
  opts: ExportOptions,
  result: ExportResult,
) {
  const { dir, signal } = opts;
  const missing: PlannedCover[] = [];
  for (const c of covers) {
    const names = await readdir(join(dir, c.folder)).catch(() => [] as string[]);
    if (names.some((n) => COVER_EXTENSIONS.some((ext) => n.toLowerCase() === `cover.${ext}`))) result.coversAlreadyPresent++;
    else missing.push(c);
  }
  if (missing.length === 0) return;

  const progress = new Progress("Cover Art", missing.length, 0);
  progress.start();
  const gate = new ThrottleGate();
  try {
    await pool(missing, opts.concurrency, signal, async (c) => {
      for (let attempt = 1; ; attempt++) {
        try {
          await gate.wait(signal);
          const res = await api.fetchCoverArt(artworkServer, c.artworkId, signal);
          const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
          const bytes = new Uint8Array(await res.arrayBuffer());
          const path = join(dir, c.folder, `cover.${IMAGE_EXT[type] ?? "jpg"}`);
          await mkdir(dirname(path), { recursive: true });
          await writeFileAtomic(path, bytes);
          result.coversDownloaded++;
          progress.itemDone();
          return;
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof ApiError && e.retryAfterMs !== undefined) gate.pauseFor(e.retryAfterMs);
          if (attempt >= MAX_COVER_ATTEMPTS) {
            result.coverFailures.push({ folder: c.folder, reason: errMsg(e) });
            logError(`Cover Art ${c.artworkId} for ${c.folder}`, e);
            progress.log(`FAILED Cover Art for ${c.folder}: ${errMsg(e)}`);
            progress.itemFailed();
            return;
          }
          try {
            await sleep(2 ** attempt * 1000, signal);
          } catch {
            return;
          }
        }
      }
    });
  } finally {
    progress.stop();
  }
}
