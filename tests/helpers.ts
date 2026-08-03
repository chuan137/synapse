// Shared test setup. Every test stands its run up through synapse init,
// never through raw inserts (per task instructions).

import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db";
import { initRun, type InitResult } from "../src/subtasks";
import { readFileSync } from "fs";
import { join } from "path";

const schemaSql = readFileSync(join(import.meta.dir, "..", "src", "schema.sql"), "utf-8");

export function freshDb(): Database {
  const db = openDb(":memory:");
  initSchema(db, schemaSql);
  return db;
}

export function freshRun(db: Database, goal = "test goal"): InitResult {
  return initRun(db, goal);
}

// Phase 2: fakes invoke `$SYNAPSE_BIN reply ...` as a real subprocess, so
// they need a real compiled binary, not the in-process dispatch() used by
// cli.test.ts. Compiled once per test run into TMPDIR (never into the
// repo — bun build --compile output is a 60MB+ binary).
let cachedBinPath: string | null = null;

export async function synapseBin(): Promise<string> {
  if (cachedBinPath) return cachedBinPath;
  const outfile = join(process.env.TMPDIR ?? "/tmp", `synapse-test-bin-${crypto.randomUUID()}`);
  const proc = Bun.spawn(
    ["bun", "build", "--compile", join(import.meta.dir, "..", "src", "cli.ts"), "--outfile", outfile],
    { stdout: "ignore", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`failed to compile synapse test binary: ${stderr}`);
  }
  cachedBinPath = outfile;
  return outfile;
}

export const FAKES_DIR = join(import.meta.dir, "fakes");
