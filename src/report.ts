/** The Export Report: one Markdown file per run. */
import type { Duplicate, PlannedTrack } from "./plan.ts";
import { formatBytes, formatDuration } from "./progress.ts";

export type ExportResult = {
  startedAt: Date;
  finishedAt: Date;
  dir: string;
  dryRun: boolean;
  verify: boolean;
  limit: number | undefined;
  aborted: boolean;
  /** Tracks considered in this run (after --limit). */
  planned: number;
  plannedBytes: number;
  alreadyComplete: number;
  downloaded: number;
  downloadedBytes: number;
  failed: Array<{ track: PlannedTrack; reason: string }>;
  collisions: PlannedTrack[];
  unknownTypes: PlannedTrack[];
  extensionMismatches: Array<{ track: PlannedTrack; zipName: string }>;
  /** Existing files whose size did not match; re-downloaded. */
  wrongSize: string[];
  /** Same recording uploaded more than once; only the better-quality upload is exported. */
  duplicates: Duplicate[];
  /** Files of skipped duplicates left over from earlier Exports; deleted. */
  removedStaleDuplicates: string[];
  /** Better-quality uploads moved from their old collision name to the plain name. */
  movedDuplicates: string[];
  /** Complete files without an entry in checksums.sfv. */
  missingChecksum: string[];
  /** --verify: files whose CRC did not match checksums.sfv; re-downloaded. */
  verifyMismatches: string[];
  verified: number;
  coversPlanned: number;
  coversAlreadyPresent: number;
  coversDownloaded: number;
  coverFailures: Array<{ folder: string; reason: string }>;
  foldersWithoutCover: string[];
  logFile: string;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

export function reportFileName(startedAt: Date): string {
  const d = startedAt;
  return (
    `export-report-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.md`
  );
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `\n## ${title} (${lines.length})\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
}

const code = (s: string) => "`" + s.replaceAll("`", "'") + "`";

export function renderReport(r: ExportResult): string {
  const status = r.dryRun ? "dry run (nothing downloaded)" : r.aborted ? "**aborted**" : r.failed.length ? "**completed with failures**" : "complete";
  const rows: Array<[string, string]> = [
    ["Status", status],
    ["Export Directory", code(r.dir)],
    ["Started", r.startedAt.toLocaleString("de-DE")],
    ["Duration", formatDuration(r.finishedAt.getTime() - r.startedAt.getTime())],
    ["Options", [r.verify && "--verify", r.limit !== undefined && `--limit ${r.limit}`, r.dryRun && "--dry-run"].filter(Boolean).join(" ") || "–"],
    ["Tracks planned", `${r.planned} (${formatBytes(r.plannedBytes)})`],
    ["Already complete", String(r.alreadyComplete)],
    ["Downloaded", `${r.downloaded} (${formatBytes(r.downloadedBytes)})`],
    ["Failed", String(r.failed.length)],
    ["Duplicates skipped (better quality kept)", String(r.duplicates.length)],
    ["Verified (--verify)", r.verify ? String(r.verified) : "–"],
    ["Log file", code(r.logFile)],
    ["Cover Art", `${r.coversPlanned} planned, ${r.coversAlreadyPresent} present, ${r.coversDownloaded} downloaded, ${r.coverFailures.length} failed`],
  ];

  return (
    `# Export Report\n\n${rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n")}\n` +
    section("Failed Tracks", r.failed.map((f) => `${code(f.track.relPath)} (Track ${f.track.track.id}): ${f.reason}`)) +
    section("Verify mismatches (re-downloaded)", r.verifyMismatches.map(code)) +
    section("Wrong size on disk (re-downloaded)", r.wrongSize.map(code)) +
    section(
      "Duplicates: better quality kept",
      r.duplicates.map(
        (d) =>
          `${code(d.kept.relPath)}: kept Track ${d.kept.track.id} (${formatBytes(d.kept.track.size)}), ` +
          `skipped Track ${d.skipped.id} (${formatBytes(d.skipped.size)})`,
      ),
    ) +
    section("Better-quality files moved to their plain name", r.movedDuplicates.map(code)) +
    section("Stale duplicate files removed", r.removedStaleDuplicates.map(code)) +
    section("Collisions", r.collisions.map((t) => `${code(t.relPath)} (Track ${t.track.id})`)) +
    section("Unknown types", r.unknownTypes.map((t) => `${code(t.relPath)}: ${t.track.mime || "(none)"}`)) +
    section("Extension mismatches", r.extensionMismatches.map((m) => `${code(m.track.relPath)}: ZIP entry ${code(m.zipName)}`)) +
    section("Complete files without checksum", r.missingChecksum.map(code)) +
    section("Cover Art failures", r.coverFailures.map((f) => `${code(f.folder)}: ${f.reason}`)) +
    section("Albums without Cover Art", r.foldersWithoutCover.map(code))
  );
}
