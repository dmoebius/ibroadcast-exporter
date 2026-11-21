# Spec: iBroadcast Exporter

Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). The download source is fixed by [ADR 0001](adr/0001-originals-via-download-endpoint.md).

## Problem Statement

My personal music Library (tens of thousands of Tracks, hundreds of GB) lives on iBroadcast.com. From 2027-01-10 the free tier's limits (5 GB storage, 5 GB/month bandwidth) will be enforced on my account, so the Library will effectively become inaccessible. iBroadcast's own bulk export (MediaSync Lite "Download Library") is buggy and incomplete. I need every Track as its Original, plus the Cover Art of every Album, in a local directory with a clean, player-friendly structure. The export has to survive interruptions and be safely repeatable. It must finish before the deadline.

## Solution

A small Node/TypeScript command-line tool that I run against an Export Directory of my choice.

- **Login.** It logs me in via the OAuth device-code flow.
- **Library.** It loads the complete Library and keeps the raw Library response in the Export Directory.
- **Tracks.** It downloads every Track as its Original into an `Album Artist / Year - Album / Disc-Nr Title.ext` layout, and verifies each file against the checksum iBroadcast supplies.
- **Cover Art.** It stores one Cover Art image per Album.
- **Repeat runs.** Running it again skips everything that is already complete and only transfers what is missing, incomplete or corrupt.
- **Feedback.** A progress bar shows Tracks, bytes, throughput and remaining time. Each run leaves an Export Report as a Markdown file in the Export Directory.

## User Stories

1. As the Library owner, I want to log in once via a device code shown in the terminal, so that I never type my iBroadcast password into a third-party tool.
2. As the Library owner, I want the tool to remember my login between runs, so that a resumed Export does not require re-authorization.
3. As the Library owner, I want an expired access token to be refreshed automatically during a long Export, so that a multi-hour run is not interrupted after one hour.
4. As the Library owner, I want a clear error message if my registered app lacks the device-code grant, so that I know which setting to change.
5. As the Library owner, I want to log out, which revokes the token and deletes it locally, so that no credentials remain once the project is archived.
6. As the Library owner, I want to supply my app's client id via environment variable or config file, so that no credential is hard-coded.
7. As the Library owner, I want to choose the Export Directory on the command line, so that I can export to any disk or NAS.
8. As the Library owner, I want the complete raw Library response saved as `library.json` in the Export Directory on every Export, so that all metadata (ratings, plays, playlists, original upload paths) survives even though only audio and Cover Art are exported as files.
9. As the Library owner, I want every Track exported as its Original, byte-identical to what I once uploaded, so that I lose no audio quality.
10. As the Library owner, I want the tool never to fall back to a Transcode, so that I never mistake a lossy re-encode for my Original.
11. As the Library owner, I want each downloaded Track verified against its CRC-32 and size, so that I know a file is intact before it counts as done.
12. As the Library owner, I want Tracks laid out as `<Album Artist>/<Year> - <Album>/<Disc>-<Nr> <Title>.<ext>`, so that music servers like Navidrome, Plex or Jellyfin can read the export directly.
13. As the Library owner, I want the `<Year> - ` part omitted when no year is known, so that folders are not named `0 - Album`.
14. As the Library owner, I want the `<Disc>-` prefix, always two digits, only for multi-disc Albums, so that ordinary Albums stay uncluttered and Albums with 10+ Discs sort correctly.
15. As the Library owner, I want all Discs of an Album in one folder, so that a multi-disc Album is browsed as one unit.
16. As the Library owner, I want track numbers zero-padded to two digits, or to three digits when a Disc has a track number of 100 or more, so that files sort correctly.
17. As the Library owner, I want Albums without an album artist placed under the single Track artist if all Tracks share one, otherwise under `Various Artists`, so that compilations are not scattered across dozens of artist folders.
18. As the Library owner, I want sensible placeholders for missing metadata (`Unknown Artist`, `Unknown Album`, `Track <id>`, no number prefix when the track number is missing), so that no Track is skipped because of incomplete tags.
19. As the Library owner, I want the Album year taken from the Album, falling back to the most common Track year of that Album, so that year information is used where it exists.
20. As the Library owner, I want characters that are illegal on Windows/NTFS/SMB replaced and names limited to 200 bytes, so that the export can live on a NAS or be copied to any filesystem.
21. As the Library owner, I want two different Tracks that would map to the same path (a Collision) kept apart deterministically, with ` [<TrackId>]` appended to all but the lowest Track id, so that no Track overwrites another.
22. As the Library owner, I want such Collisions listed in the Export Report, so that I can inspect them later.
22a. As the Library owner, I want a Duplicate (the same recording uploaded twice, e.g. once at 128 and once at 320 kbit/s) exported only once in its best quality under the plain name, so that I don't keep inferior copies.
22b. As the Library owner, I want a later Export to recognize Duplicates in an existing Export Directory, replacing a worse copy at the plain name and removing or moving files left under collision names, so that the result is the same no matter which version of the tool exported first.
23. As the Library owner, I want the file extension derived from the Track's type (mp3, m4a, ogg, …), so that every file opens with the right application.
24. As the Library owner, I want unknown types saved as `.bin` and reported, so that nothing is silently dropped.
25. As the Library owner, I want each Album's Cover Art saved once as `cover.jpg` (1000 px) in the Album folder, so that players show artwork.
26. As the Library owner, I want the Cover Art chosen as the artwork used by most Tracks of the Album, so that one stray Track image does not become the Album's cover.
27. As the Library owner, I want Albums without Cover Art listed in the Export Report, so that I know which ones to fix by hand.
28. As the Library owner, I want an interrupted Export to resume when I run it again on the same Export Directory, so that a crash or network outage after 200 GB does not cost me 200 GB.
29. As the Library owner, I want incomplete downloads never to look complete, so that a resumed Export reliably re-fetches them.
30. As the Library owner, I want a Track considered complete when its file exists with the expected size, so that a repeat Export starts within seconds instead of re-reading the whole Library.
31. As the Library owner, I want every verified Track's CRC-32 recorded in a standard `checksums.sfv`, so that I (or any SFV tool) can check the archive's integrity years from now.
32. As the Library owner, I want an optional `--verify` mode that re-checks all local files against `checksums.sfv` without network traffic and re-downloads mismatches in the same run, so that I can detect bit rot or a bad copy.
33. As the Library owner, I want complete files missing from `checksums.sfv` accepted but reported, so that a crash between saving and recording does not cause a re-download.
34. As the Library owner, I want several Tracks downloaded in parallel (default 4, configurable), so that the whole Library finishes well before the deadline.
35. As the Library owner, I want the tool to honour throttling (HTTP 429/503, `retry-after`) by pausing all downloads, so that iBroadcast does not block me.
36. As the Library owner, I want failed Tracks retried with backoff, up to 5 attempts, and then recorded as failed while the Export continues, so that one bad Track does not stop the whole run.
37. As the Library owner, I want a progress bar showing transferred/total Tracks, transferred/total MB/GB, throughput and estimated remaining time, so that I can plan around a multi-hour run.
38. As the Library owner, I want already complete Tracks excluded from the progress totals and the time estimate, so that the remaining time is realistic on resumed runs.
39. As the Library owner, I want the first Ctrl+C to stop cleanly and still write the Export Report, and a second Ctrl+C to quit immediately, so that I can interrupt safely.
40. As the Library owner, I want one Export Report per run, named with its start timestamp, listing counts, failed Tracks with reasons, collisions, unknown types, Albums without Cover Art and checksum issues, so that I can review every run, including aborted ones.
41. As the Library owner, I want a `--dry-run` that computes all paths, collisions and sizes without downloading anything or writing into the Export Directory, so that I can check the layout against the real Library before hundreds of GB flow.
42. As the Library owner, I want a `--limit N` option that exports only the first N Tracks, so that I can do a quick trial run end-to-end.
43. As the Library owner, I want the tool to need no build step and no runtime dependencies, so that it still runs when I dig it out of the archive.
44. As the Library owner, I want a log file with all requests and responses (without bodies), whose path is shown when the Export fails, so that I can diagnose what went wrong.

## Implementation Decisions

- **Runtime:** Node ≥ 24, running TypeScript directly via Node's type stripping, so there is no build step. pnpm manages dev tooling (TypeScript for type checks only). There are no runtime dependencies: HTTP via native `fetch`, CRC-32 via `zlib.crc32`, argument parsing via `util.parseArgs`.
- **CLI:** the commands are `login`, `logout` and `export <dir> [--concurrency N] [--dry-run] [--verify] [--limit N]`. `export` starts the login flow on its own when no stored token exists.
- **Modules:**
  - configuration and credential storage
  - auth: device-code login, token refresh, revoke
  - iBroadcast API client: library, status/user id, track download, Cover Art
  - library parsing: the compact `{map, id: [values]}` format into typed Tracks, Album entries and artists
  - export planning: pure, Library → planned paths, collisions, Cover Art choices
  - streaming single-entry ZIP extraction
  - SFV reading and writing
  - progress display
  - Export Report rendering
  - export orchestration
- **Auth:** OAuth 2.0 device-code flow against `oauth.ibroadcast.com` with scope `user.library:read`.
  - `grant_type=device_code` (verified to work only after enabling that grant for the app).
  - Tokens are stored as JSON with an absolute expiry under the XDG config directory (`ibroadcast-exporter/`), mode 0600.
  - The access token lives 1 hour. It is refreshed proactively when less than 5 minutes remain, and once reactively when the API answers "not authenticated".
  - The client id comes from the `IBROADCAST_CLIENT_ID` environment variable or a `clientId` entry in the config file.
- **Library:** `POST library.ibroadcast.com` with `mode=library`. The raw response body is written verbatim, atomically, as `library.json` (no previous version kept). Trashed Tracks are ignored. The user id needed for downloads comes from `POST api.ibroadcast.com/status`.
- **Download (see ADR 0001):** one `POST download.ibroadcast.com` per Track. Form fields: `_token`, `_user_id`, `mode=downloadlibrary`, `container_type=tracks`, `ids=<trackId>`. The response is a ZIP with one stored (uncompressed) entry, a data descriptor (sizes and CRC follow the data) and a UTF-8 name.
  - The ZIP is parsed as a stream. The entry's bytes, exactly the Library's `size`, go straight into `<final path>.part` while the CRC-32 is computed.
  - The data descriptor's CRC and size are then checked, the file is synced and renamed atomically, and the CRC is appended to `checksums.sfv`.
  - Range requests are unsupported, so an interrupted Track restarts from zero and a leftover `.part` is simply overwritten.
- **Completeness:** a Track is complete when its planned path exists with size equal to `size`. `--verify` additionally computes local CRC-32s and compares them with `checksums.sfv`. Mismatching files are deleted and re-downloaded in the same run. Complete files without an SFV entry are accepted and reported. There is no manifest and no rename/move/delete logic, because the Library is frozen.
- **Layout rules (planning):**
  - Each iBroadcast "album" entry is one Disc.
  - Per Disc entry:
    - album artist name: if the entry has none, the single distinct Track artist, else `Various Artists`; if there is no artist at all, `Unknown Artist`
    - year: the entry's year, else the most common non-zero Track year, else none
    - name: else `Unknown Album`
  - Album folder: `<artist>/<year> - <name>`, or `<artist>/<name>` when there is no year.
  - Disc entries that end in the same folder (compared case-insensitively) form one Album. The Album is multi-disc if it has more than one distinct disc number.
  - The Disc number in the prefix is always two digits (`01-`, `02-`, …, `10-`), because Albums with 10 or more Discs exist.
  - Number width per Disc: 3 if the Disc's highest track number is ≥ 100, else 2. A missing or zero track number drops the whole `<Disc>-<Nr> ` prefix. A missing title becomes `Track <id>`.
  - Extension from the MIME type: `audio/mpeg3` and `audio/mpeg` → `mp3`, `audio/mp4` → `m4a`, `audio/ogg` → `ogg` (plus a few common others), unknown → `bin`. The path must be known before downloading, so the type is the source of truth. If the ZIP entry's extension disagrees, that is reported.
  - Sanitizing: replace `/ \ : * ? " < > |` and control characters with `_`, trim surrounding whitespace, replace trailing dots with `_`. Names that are empty, `.` or `..` become `_`. Each component is cut to 200 UTF-8 bytes, keeping the extension and collision suffix.
  - Tracks with the same path (compared case-insensitively after Unicode NFC normalization) are first checked for Duplicates. Two Tracks are the same recording if Track artist, year, track number and title (case-insensitive) are equal and the durations differ by at most 2 s.
  - Of each Duplicate group only the largest upload is exported (larger size at equal duration means higher bitrate or richer tags; ties go to the lower Track id). The others are skipped and listed in the Export Report.
  - The remaining Tracks on the same path are Collisions. In ascending numeric Track id order, the first keeps the plain name and later ones get ` [<TrackId>]` before the extension.
  - A later Export recognizes Duplicates on disk:
    - A worse copy at the plain name has the wrong size and is re-downloaded (overwritten).
    - A complete best-quality file left under its own ` [<TrackId>]` name by an earlier rule is moved to the plain name.
    - Files of skipped uploads under collision names are deleted.
    - `checksums.sfv` is updated accordingly.
  - At the end of every Export, `checksums.sfv` is compacted to one line per file (the latest), so that standard SFV tools agree.
- **Cover Art:** per Album, the `artwork_id` used by most Tracks (ties go to the lower id). Fetched without auth from `<artwork_server>/artwork/<id>-1000`. Saved as `cover.<ext>` by content type (normally `cover.jpg`) via `.part` + rename. An existing `cover.*` counts as complete. Fetched after all Tracks, with up to 3 attempts, and not counted in the Track progress.
- **Concurrency and throttling:** a worker pool (default 4). A shared pause gate: HTTP 429/503 or a `retry-after` header pauses all workers (default 30 s if no header). Up to 5 attempts per Track with exponential backoff, then the Track is recorded as failed and the Export continues.
- **Progress:** one status line on stderr (redrawn on a TTY, a periodic plain line otherwise) with a bar, Tracks done/total, bytes done/total, throughput and ETA. Totals cover only Tracks still to transfer. Throughput and ETA come from bytes over a sliding ~30 s window. German number formatting.
- **Interruption:** the first SIGINT aborts all in-flight requests, leaves `.part` files, writes the Export Report and exits with code 130. The second SIGINT exits immediately.
- **Export Report:** `export-report-<YYYY-MM-DD_HHmmss>.md` (local start time) in the Export Directory. It contains:
  - start, duration, aborted yes/no
  - counts (planned, already complete, downloaded, failed, bytes)
  - failed Tracks with reasons
  - collisions
  - unknown types, extension mismatches
  - files without checksum, verify mismatches
  - Cover Art fetched/failed, Albums without Cover Art
- **Log file:** every run appends to a log file in the system temp directory (`ibroadcast-exporter-<timestamp>-<pid>.log`, mode 0600). It contains:
  - CLI messages and retries
  - errors with stack traces
  - a progress line every minute
  - every HTTP request (method, URL, headers, the Track or Cover Art it belongs to) and its response (status, duration, headers); no bodies, secrets redacted

  The CLI points to the log file only when the Export ended with failures or an unexpected error, not on success. The Export Report also lists it.
- **Exit codes:** 0 when everything is complete, 1 when something failed, 2 for usage or configuration errors, 130 when aborted.

## Testing Decisions

- This is a one-shot tool that will be used once or twice and then archived, so testing stays minimal and pragmatic. There is no test harness against a fake iBroadcast server.
- Only the two places where bugs would silently corrupt the result get automated tests, and only through their public functions:
  - **export planning**: the layout rules, multi-disc, padding, placeholders, Various Artists, collisions, sanitizing, Cover Art choice
  - **ZIP extraction**: correct bytes, CRC mismatch, truncated stream, wrong size
- Tests use Node's built-in test runner. There is no prior art in the repo.
- Everything else is validated by real runs: `--dry-run` against the real Library first, then `--limit 20`, then the full Export.

## Out of Scope

- Exporting playlists, ratings, play counts, tags or the queue as files. They remain available only inside the saved `library.json`.
- Writing or updating tags inside audio files.
- Transcodes of any kind, including as a fallback.
- Handling Tracks deleted, renamed or re-tagged in iBroadcast between Exports. The Library is frozen.
- Uploading, syncing back, or any write access to iBroadcast.
- Using the original upload paths (`path`) for the layout. They are inconsistent.
- Re-downloading to verify (`--verify` is local only).
- Multi-user support, publishing, packaging.

## Further Notes

- Hard deadline: the free-tier limits apply from **2027-01-10**. The whole Library must be transferred before then.
- The download endpoint is undocumented (ADR 0001). If it breaks, there is no automated fallback.
