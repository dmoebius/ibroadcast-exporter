# ibroadcast-exporter

Exports the personal music Library from [iBroadcast](https://www.ibroadcast.com) into a local directory:

- every Track as its **Original**, byte-identical to the uploaded file and verified by CRC-32
- one **Cover Art** image per Album (1000 px)
- the complete raw Library metadata as `library.json`

The Export is resumable and repeatable. Running it again only transfers what is missing, incomplete or corrupt.

This is meant to be a one-shot tool. After **2027-01-10**, free-tier limits (5 GB storage and 5 GB bandwidth per month) are enforced on non-premium accounts, so you cannot download your library with a free account any longer. There exists an official exporter in the `iBroadcast Desktop App`, but it is buggy and currently unusable.

Background: [docs/SPEC.md](docs/SPEC.md), [ADR 0001](docs/adr/0001-originals-via-download-endpoint.md), vocabulary in [GLOSSARY.md](GLOSSARY.md).

## Requirements

- Node.js ≥ 24.
- pnpm, only for type checks and tests.
- A registered iBroadcast app:
  1. On [media.ibroadcast.com](https://media.ibroadcast.com) go to **Apps → Developer** and create an app.
  2. Enable the **`device_code`** grant type.
  3. Provide its client id, either as `export IBROADCAST_CLIENT_ID=...` or in `~/.config/ibroadcast-exporter/config.json` as `{"clientId": "..."}`.

## Usage

```sh
pnpm install                       # dev tooling only (TypeScript, @types/node)

node src/cli.ts login              # shows a URL + code; approve in the browser
node src/cli.ts export <dir> --dry-run > plan.md   # check layout, collisions, sizes; writes nothing
node src/cli.ts export <dir> --limit 20            # quick trial run
node src/cli.ts export <dir>                       # the real thing
node src/cli.ts export <dir> --verify              # re-check all files against checksums.sfv (local only)
node src/cli.ts logout             # revoke and delete the stored token
```

Instead of `node src/cli.ts` you can also use `npx`. It needs no `pnpm install`, because the tool has no runtime dependencies:

```sh
npx . export <dir>                                   # inside the repo
npx /path/to/ibroadcast-exporter export <dir>       # from any other directory
```

`export` options:

| Option | Meaning |
|---|---|
| `--concurrency <n>` | parallel downloads (default 4) |
| `--dry-run` | plan only; prints the Export Report to stdout, downloads and writes nothing |
| `--verify` | compute CRC-32 of every complete file and compare with `checksums.sfv`; mismatches are re-downloaded |
| `--limit <n>` | export only the first n Tracks (sorted by path) |

Ctrl+C once stops cleanly and still writes the Export Report. Ctrl+C twice quits immediately. Either way, just run `export` again to resume.

Exit codes: `0` everything complete, `1` some Tracks or Cover Art failed (see report), `2` usage/configuration error, `130` aborted.

## What ends up in the Export Directory

```
<Export Directory>/
├── library.json                         raw Library response, rewritten on every Export
├── checksums.sfv                        CRC-32 of every downloaded Original (standard SFV)
├── export-report-YYYY-MM-DD_HHmmss.md   one Export Report per run
└── <Album Artist>/<Year> - <Album>/
    ├── cover.jpg
    ├── 01 Title.mp3                     single-disc Album
    └── 02-01 Title.mp3                  multi-disc Album: <Disc>-<Nr>, Disc always two digits
```

Layout rules:

- **Year:** comes from the Album, otherwise the most common Track year. If there is none, the folder is just `<Album>`.
- **Track numbers:** two digits, or three digits when a Disc has a track number of 100 or more.
- **Missing metadata:**
  - Album without album artist: the single Track artist, or `Various Artists` if the Tracks have different artists.
  - Other gaps become `Unknown Artist`, `Unknown Album` or `Track <id>`. Without a track number there is no number prefix.
- **Names:** characters illegal on NTFS/SMB become `_`, and each name is at most 200 bytes.
- **Duplicates** (the same recording uploaded twice, e.g. at 128 and 320 kbit/s; artist, title, year, track number and duration all equal): only the larger, better-quality upload is exported, under the plain name. Later runs replace a worse copy already on disk and clean up leftover ` [<TrackId>]` files.
- **Collisions** (different Tracks with the same path): the lowest Track id keeps the plain name, the others get ` [<TrackId>]`. Each such case is listed in the report.
- **Completeness:** a Track counts as complete when its file exists with the size iBroadcast reports. Downloads go to `*.part` first and are renamed only after the CRC-32 check.

## Development

```sh
pnpm typecheck
pnpm test        # path planning + ZIP extraction
```

Every run writes a diagnostic log to the system temp dir (`/tmp/ibroadcast-exporter-<timestamp>-<pid>.log`, mode 0600). It contains all messages, errors with stack traces, a progress line every minute, and every HTTP request and response with headers but without bodies; tokens are redacted. The path is printed only when something went wrong, and it is also listed in the Export Report.

Credentials are stored in `~/.config/ibroadcast-exporter/token.json` (mode 0600). The access token lives one hour and is refreshed automatically.
