/** Diagnostic log file in the system temp dir: messages, errors, and every HTTP request/response (no bodies). */
import { openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_NAME } from "./config.ts";

const SECRET_PARAMS = ["Signature", "token", "_token", "access_token", "refresh_token", "device_code"];
const SECRET_HEADERS = ["authorization", "cookie", "set-cookie"];

let fd: number | undefined;
let path: string | undefined;
let requestSeq = 0;

const pad2 = (n: number) => String(n).padStart(2, "0");

export function logFilePath(): string {
  if (!path) {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    path = join(tmpdir(), `${CLIENT_NAME}-${stamp}-${process.pid}.log`);
  }
  return path;
}

/** Append one line to the log file (synchronously, so nothing is lost on process.exit). */
export function logLine(msg: string): void {
  try {
    fd ??= openSync(logFilePath(), "a", 0o600);
    writeSync(fd, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging must never break the export
  }
}

export function logError(context: string, e: unknown): void {
  logLine(`ERROR ${context}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of SECRET_PARAMS) if (u.searchParams.has(p)) u.searchParams.set(p, "***");
    return u.toString();
  } catch {
    return url;
  }
}

function headersToJson(headers: HeadersInit | Headers | undefined): string {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = SECRET_HEADERS.includes(key) ? "***" : value;
  });
  return JSON.stringify(out);
}

/** `fetch` that logs the request line + headers and the response status + headers. */
export async function loggedFetch(url: string, init: RequestInit = {}, label?: string): Promise<Response> {
  const id = ++requestSeq;
  const method = init.method ?? "GET";
  logLine(`#${id} → ${method} ${redactUrl(url)}${label ? ` [${label}]` : ""} headers=${headersToJson(init.headers)}`);
  const started = performance.now();
  try {
    const res = await fetch(url, init);
    const ms = Math.round(performance.now() - started);
    logLine(`#${id} ← ${res.status} ${res.statusText} (${ms} ms) headers=${headersToJson(res.headers)}`);
    return res;
  } catch (e) {
    logLine(`#${id} ✗ ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
