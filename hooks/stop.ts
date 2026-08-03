#!/usr/bin/env bun
// spec §4.5 layer 1, D1 ("the Stop hook is a TS script invoking the
// compiled binary, not a separate runtime... keep it under ~20ms; it is in
// the worker's critical path").
//
// Registered in .claude/settings.json as the Stop hook command. Relays
// stdin (the S0.3 payload) to `synapse hook-check`, which does the actual
// DB lookup, and relays its stdout back unchanged — this file does no DB
// work itself, so the ~20ms budget is dominated by process spawn, not
// query logic.

const bin = process.env.SYNAPSE_BIN;
if (!bin) {
  // Not spawned by a Synapse worker (no SYNAPSE_BIN in env) — allow the
  // stop. Nothing to check against.
  console.log("{}");
  process.exit(0);
}

const stdinText = await new Response(Bun.stdin.stream()).text();

const proc = Bun.spawn([bin, "hook-check"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
proc.stdin.write(stdinText);
proc.stdin.end();

const output = await new Response(proc.stdout).text();
await proc.exited;

process.stdout.write(output);
