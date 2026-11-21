#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { IBroadcastApi } from "./api.ts";
import { login, logout, TokenProvider } from "./auth.ts";
import { CLIENT_VERSION, getClientId, UserError } from "./config.ts";
import { runExport, writeReport } from "./export.ts";
import { renderReport } from "./report.ts";
import { logError, logFilePath, logLine } from "./log.ts";

const USAGE = `Usage:
  ibroadcast-exporter login                 Authorize via device code and store the token
  ibroadcast-exporter logout                Revoke and delete the stored token
  ibroadcast-exporter export <dir> [options]

Export options:
  --concurrency <n>   parallel downloads (default 4)
  --dry-run           plan paths/collisions/sizes only; download and write nothing
  --verify            re-check complete files against checksums.sfv (local, no network)
  --limit <n>         only export the first n Tracks (trial runs)

The client id of your registered iBroadcast app is read from IBROADCAST_CLIENT_ID
or from ~/.config/ibroadcast-exporter/config.json ({"clientId": "..."}).`;

function positiveInt(value: string | undefined, name: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`--${name} must be a positive integer`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  logLine(`ibroadcast-exporter ${CLIENT_VERSION}, node ${process.version}, args: ${JSON.stringify(argv)}`);
  const [command, ...rest] = argv;
  switch (command) {
    case "login": {
      await login(await getClientId());
      return 0;
    }
    case "logout": {
      const had = await logout(await getClientId());
      console.error(had ? "Logged out; token revoked and deleted." : "Not logged in.");
      return 0;
    }
    case "export": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          concurrency: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          verify: { type: "boolean", default: false },
          limit: { type: "string" },
        },
      });
      if (positionals.length !== 1) throw new UserError(`export needs exactly one Export Directory.\n\n${USAGE}`);
      const dir = resolve(positionals[0]!);

      const clientId = await getClientId();
      const tokens = (await TokenProvider.load(clientId)) ?? (await login(clientId));

      const controller = new AbortController();
      let interrupts = 0;
      process.on("SIGINT", () => {
        if (++interrupts > 1) process.exit(130);
        console.error("\nAborting… (press Ctrl+C again to quit immediately)");
        controller.abort(new Error("aborted by user"));
      });

      const result = await runExport(new IBroadcastApi(tokens), {
        dir,
        concurrency: positiveInt(values.concurrency, "concurrency", 4)!,
        dryRun: values["dry-run"],
        verify: values.verify,
        limit: positiveInt(values.limit, "limit"),
        signal: controller.signal,
      });

      if (result.dryRun) {
        process.stdout.write(renderReport(result));
        return 0;
      }
      const reportPath = await writeReport(result);
      console.error(`Export Report: ${reportPath}`);
      if (result.aborted) return 130;
      if (result.failed.length || result.coverFailures.length) {
        console.error(
          `${result.failed.length} Track(s) and ${result.coverFailures.length} Cover Art failed. ` +
            `Details: ${reportPath}\nLog file: ${logFilePath()}`,
        );
        return 1;
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    logError("fatal", e);
    if (e instanceof UserError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(`Export failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`Log file: ${logFilePath()}`);
    process.exit(1);
  },
);
