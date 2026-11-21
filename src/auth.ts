import { loggedFetch } from "./log.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { configDir, readJson, sleep, UserError, writeFileAtomic } from "./config.ts";

const OAUTH_URL = "https://oauth.ibroadcast.com";
const SCOPE = "user.library:read";
/** Refresh proactively when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

type StoredToken = {
  access_token: string;
  refresh_token: string;
  /** epoch millis */
  expires_at: number;
  scope?: unknown;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: unknown;
  error?: string;
  error_description?: string;
};

function tokenPath(): string {
  return join(configDir(), "token.json");
}

async function postToken(params: Record<string, string>): Promise<{ status: number; body: TokenResponse }> {
  const res = await loggedFetch(`${OAUTH_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  return { status: res.status, body };
}

function toStored(body: TokenResponse, previousRefresh?: string): StoredToken {
  if (!body.access_token) throw new Error("token response without access_token");
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? previousRefresh ?? "",
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    scope: body.scope,
  };
}

async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFileAtomic(tokenPath(), JSON.stringify(token, null, 2), 0o600);
}

/** OAuth device-code flow: show a code, poll until the user has approved it in a browser. */
export async function login(clientId: string, log: (msg: string) => void = console.error): Promise<TokenProvider> {
  const res = await loggedFetch(`${OAUTH_URL}/device/code?${new URLSearchParams({ client_id: clientId, scope: SCOPE })}`);
  if (!res.ok) throw new Error(`device code request failed: HTTP ${res.status} ${await res.text()}`);
  const dc = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };
  log(`\nAuthorize this tool in your browser:\n  ${dc.verification_uri_complete}\n` +
    `or open ${dc.verification_uri} and enter the code ${dc.user_code}\n`);

  let intervalMs = Math.max(1, dc.interval || 5) * 1000;
  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const { status, body } = await postToken({
      grant_type: "device_code",
      device_code: dc.device_code,
      client_id: clientId,
    });
    if (status === 200 && body.access_token) {
      const token = toStored(body);
      await saveToken(token);
      log("Login successful.");
      return new TokenProvider(clientId, token);
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 1000;
      continue;
    }
    if (body.error === "unauthorized_client") {
      throw new UserError(
        `${body.error_description ?? body.error}. Enable the "device_code" grant type for your app ` +
          `on media.ibroadcast.com (Apps → Developer).`,
      );
    }
    throw new Error(`token request failed: HTTP ${status} ${JSON.stringify(body)}`);
  }
  throw new UserError("The device code expired before it was authorized. Run login again.");
}

export async function logout(clientId: string): Promise<boolean> {
  const token = await readJson<StoredToken>(tokenPath());
  if (!token) return false;
  await loggedFetch(`${OAUTH_URL}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: token.refresh_token, client_id: clientId }),
  }).catch(() => undefined);
  await rm(tokenPath(), { force: true });
  return true;
}

/** Hands out valid access tokens, refreshing them as needed (shared by all workers). */
export class TokenProvider {
  #clientId: string;
  #token: StoredToken;
  #refreshing: Promise<void> | undefined;

  constructor(clientId: string, token: StoredToken) {
    this.#clientId = clientId;
    this.#token = token;
  }

  static async load(clientId: string): Promise<TokenProvider | undefined> {
    const token = await readJson<StoredToken>(tokenPath());
    return token ? new TokenProvider(clientId, token) : undefined;
  }

  async accessToken(): Promise<string> {
    if (this.#token.expires_at - Date.now() < REFRESH_MARGIN_MS) await this.refresh();
    return this.#token.access_token;
  }

  /** Refresh now; concurrent callers share one refresh request. */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<void> {
    const { status, body } = await postToken({
      grant_type: "refresh_token",
      refresh_token: this.#token.refresh_token,
      client_id: this.#clientId,
    });
    if (status !== 200 || !body.access_token) {
      throw new UserError(`Token refresh failed (HTTP ${status} ${body.error ?? ""}). Run login again.`);
    }
    this.#token = toStored(body, this.#token.refresh_token);
    await saveToken(this.#token);
  }
}
