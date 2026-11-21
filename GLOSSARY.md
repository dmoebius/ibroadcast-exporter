# iBroadcast Exporter

Exports a personal music library hosted on iBroadcast.com into a local directory, so that it exists as plain files independent of the service.

## Language

**Library**:
The complete set of music a user has uploaded to their iBroadcast account.
_Avoid_: Collection, account

**Track**:
A single audio file in the Library, as originally uploaded.
_Avoid_: Song, file, item

**Album**:
All Tracks sharing the same album artist, album name and year, across all of their Discs. Exported into one folder.
_Avoid_: Release, record

**Disc**:
One part of a multi-disc Album. iBroadcast itself calls each Disc an "album".
_Avoid_: CD, volume, medium

**Duplicate**:
The same recording uploaded more than once: identical artist, Album, title, year, track number and duration, differing only in quality or embedded tags. Only the best-quality upload is exported.
_Avoid_: Copy, double, collision

**Collision**:
Two different Tracks that would end up at the same path in the Export Directory.
_Avoid_: Duplicate, clash, conflict

**Original**:
The bit-identical audio file as it was once uploaded to iBroadcast; the only form in which a Track is exported.
_Avoid_: Source file, master, high quality

**Transcode**:
An audio file re-encoded by iBroadcast on the fly (e.g. MP3 at a fixed bitrate); never exported.
_Avoid_: Stream, converted file

**Cover Art**:
The one artwork image chosen for an album: the artwork shared by most of the album's Tracks, if any Track has one.
_Avoid_: Artwork, thumbnail, album art

**Export**:
One run that brings the Export Directory up to date with the Library, transferring only what is missing or incomplete.
_Avoid_: Backup, sync, download

**Export Report**:
The human-readable summary of an Export, kept in the Export Directory, listing what was transferred, skipped, renamed due to collisions, or failed.
_Avoid_: Log, summary

**Export Directory**:
The local directory chosen by the user that holds the exported Tracks and Cover Art.
_Avoid_: Target, output folder, destination
