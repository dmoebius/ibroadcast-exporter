/** Status line on stderr: bar, Tracks, bytes, throughput, ETA. */
import { logLine } from "./log.ts";

const WINDOW_MS = 30_000;
const TTY_INTERVAL_MS = 500;
const PLAIN_INTERVAL_MS = 30_000;
const BAR_WIDTH = 24;
const LOG_FILE_INTERVAL_MS = 60_000;

const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${nf1.format(n / 1e9)} GB`;
  return `${nf1.format(n / 1e6)} MB`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export class Progress {
  readonly label: string;
  readonly totalItems: number;
  readonly totalBytes: number;
  doneItems = 0;
  doneBytes = 0;
  failedItems = 0;
  pausedUntil = 0;

  #samples: Array<[number, number]> = [];
  #timer: NodeJS.Timeout | undefined;
  #tty = Boolean(process.stderr.isTTY);
  #lastFileLog = 0;

  constructor(label: string, totalItems: number, totalBytes: number) {
    this.label = label;
    this.totalItems = totalItems;
    this.totalBytes = totalBytes;
  }

  start(): void {
    this.#samples = [[Date.now(), 0]];
    this.#timer = setInterval(() => this.#render(), this.#tty ? TTY_INTERVAL_MS : PLAIN_INTERVAL_MS);
    this.#timer.unref();
    this.#render();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#render();
    if (this.#tty) process.stderr.write("\n");
  }

  addBytes(n: number): void {
    this.doneBytes += n;
  }

  itemDone(): void {
    this.doneItems++;
  }

  itemFailed(): void {
    this.failedItems++;
  }

  /** Print a message above the status line. */
  log(msg: string): void {
    logLine(msg);
    if (this.#tty) process.stderr.write("\r\x1b[K");
    process.stderr.write(msg + "\n");
    if (this.#tty && this.#timer) this.#render();
  }

  line(now = Date.now()): string {
    this.#samples.push([now, this.doneBytes]);
    while (this.#samples.length > 2 && now - this.#samples[1]![0] > WINDOW_MS) this.#samples.shift();
    const [t0, b0] = this.#samples[0]!;
    const rate = now > t0 ? ((this.doneBytes - b0) / (now - t0)) * 1000 : 0;
    const remaining = Math.max(0, this.totalBytes - this.doneBytes);
    const eta = rate > 0 ? formatDuration((remaining / rate) * 1000) : "–";

    const countsOnly = this.totalBytes === 0; // e.g. Cover Art, whose sizes are unknown upfront
    const frac = countsOnly
      ? this.totalItems > 0 ? (this.doneItems + this.failedItems) / this.totalItems : 1
      : Math.min(1, this.doneBytes / this.totalBytes);
    const filled = Math.round(frac * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const parts = [
      `${this.label} [${bar}] ${nf0.format(frac * 100)}%`,
      `${nf0.format(this.doneItems)}/${nf0.format(this.totalItems)}`,
    ];
    if (!countsOnly) {
      parts.push(`${formatBytes(this.doneBytes)}/${formatBytes(this.totalBytes)}`, `${formatBytes(rate)}/s`, `ETA ${eta}`);
    }
    if (this.failedItems) parts.push(`${nf0.format(this.failedItems)} failed`);
    if (this.pausedUntil > now) parts.push(`throttled, pausing ${formatDuration(this.pausedUntil - now)}`);
    return parts.join(" · ");
  }

  #render(): void {
    const text = this.line();
    if (Date.now() - this.#lastFileLog >= LOG_FILE_INTERVAL_MS || !this.#timer) {
      this.#lastFileLog = Date.now();
      logLine(text);
    }
    if (this.#tty) {
      const width = process.stderr.columns || 120;
      process.stderr.write("\r\x1b[K" + text.slice(0, width - 1));
    } else {
      process.stderr.write(text + "\n");
    }
  }
}
