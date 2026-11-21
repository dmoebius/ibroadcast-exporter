import type { TokenProvider } from "./auth.ts";
import { loggedFetch } from "./log.ts";
import { CLIENT_NAME, CLIENT_VERSION } from "./config.ts";

const LIBRARY_URL = "https://library.ibroadcast.com";
const STATUS_URL = "https://api.ibroadcast.com/status";
/** Undocumented endpoint used by the web player; the only source of Originals (ADR 0001). */
const DOWNLOAD_URL = "https://download.ibroadcast.com/";
const DEFAULT_RETRY_AFTER_MS = 30_000;

export class ApiError extends Error {
  /** Set when the server asked us to slow down; all downloads pause this long. */
  retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function throttle(res: Response): number | undefined {
  const after = parseRetryAfter(res.headers.get("retry-after"));
  if (after !== undefined) return after;
  if (res.status === 429 || res.status === 503) return DEFAULT_RETRY_AFTER_MS;
  return undefined;
}

export class IBroadcastApi {
  #tokens: TokenProvider;
  #userId: Promise<number> | undefined;

  constructor(tokens: TokenProvider) {
    this.#tokens = tokens;
  }

  async #json(url: string, mode: string): Promise<{ raw: string; data: any }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.accessToken();
      const res = await loggedFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          client: CLIENT_NAME,
          version: CLIENT_VERSION,
          device_name: CLIENT_NAME,
          user_agent: `${CLIENT_NAME}/${CLIENT_VERSION}`,
        }),
      });
      const raw = await res.text();
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ApiError(`${mode}: invalid JSON response (HTTP ${res.status})`, throttle(res));
      }
      if (data?.authenticated === false && attempt === 0) {
        await this.#tokens.refresh();
        continue;
      }
      if (!res.ok || data?.result === false) {
        throw new ApiError(`${mode} failed: HTTP ${res.status} ${data?.message ?? ""}`.trim(), throttle(res));
      }
      return { raw, data };
    }
  }

  /** The complete Library; `raw` is the verbatim response body. */
  fetchLibrary(): Promise<{ raw: string; data: any }> {
    return this.#json(LIBRARY_URL, "library");
  }

  /** Fetched once; concurrent callers share the request. */
  userId(): Promise<number> {
    this.#userId ??= this.#json(STATUS_URL, "status").then(({ data }) => {
      const id = Number(data?.user?.user_id ?? data?.user?.id);
      if (!id) throw new ApiError("status response contains no user id");
      return id;
    });
    this.#userId.catch(() => {
      this.#userId = undefined; // retry on next call
    });
    return this.#userId;
  }

  /** Request one Track's Original; resolves to the body of a single-entry ZIP. */
  async openTrackDownload(trackId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const [token, userId] = [await this.#tokens.accessToken(), await this.userId()];
    const res = await loggedFetch(DOWNLOAD_URL, {
      method: "POST",
      body: new URLSearchParams({
        _token: token,
        _user_id: String(userId),
        mode: "downloadlibrary",
        container_type: "tracks",
        ids: trackId,
      }),
      signal,
    }, `Track ${trackId}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.includes("zip") && res.body) return res.body;

    const text = await res.text().catch(() => "");
    if (/"authenticated"\s*:\s*false/.test(text)) {
      await this.#tokens.refresh();
      throw new ApiError("not authenticated (token refreshed)");
    }
    throw new ApiError(
      `download failed: HTTP ${res.status} ${contentType} ${text.slice(0, 200)}`.trim(),
      throttle(res),
    );
  }

  /** Cover Art needs no authentication. */
  async fetchCoverArt(artworkServer: string, artworkId: string, signal: AbortSignal): Promise<Response> {
    const res = await loggedFetch(`${artworkServer.replace(/\/$/, "")}/artwork/${artworkId}-1000`, { signal }, `Cover Art ${artworkId}`);
    if (!res.ok) {
      await res.body?.cancel();
      throw new ApiError(`cover art ${artworkId}: HTTP ${res.status}`, throttle(res));
    }
    return res;
  }
}
