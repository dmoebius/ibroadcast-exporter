# Originals via the undocumented download endpoint

We fetch Originals from `download.ibroadcast.com` (`mode=downloadlibrary`, `container_type=tracks`), the endpoint the iBroadcast web player uses internally. It is not part of the documented API. The documented way is the streaming server's `/orig/` path. On a free account it silently returns a 128 kbit/s MP3 Transcode for every format (verified 2026-11-21 with mp3, m4a and ogg), which would defeat the purpose of the Export.

The download endpoint wraps each file in an uncompressed ZIP. The file inside is byte-identical in size to the library's `size` field, has the original extension in its name, and carries a CRC-32 that we use to verify the Original. It does not support HTTP Range requests, so an interrupted Track is re-downloaded from the start.

This is acceptable because the tool has a short, fixed lifetime. Free-tier limits of 5 GB storage and 5 GB/month bandwidth will be enforced on the account from 2027-01-10, so the full Library must be exported before then. If the endpoint changes, the fallback is MediaSync Lite's "Download Library" feature, which is known to be unreliable. Streaming Transcodes are not a fallback.
