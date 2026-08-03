// spec §4.5 (guaranteed worker exit signal, layers 2+3), §4.6 (terminal
// rejection), §6 ("a worker killed mid-flight becomes failed")
//
// Exercises src/spawn.ts against the fakes in tests/fakes/ — real
// subprocesses, real compiled binary, real .synapse/synapse.db on disk.
// hang.sh's sweep case uses src/watcher.ts's pidSweep (Phase 3); it was
// written expected-fail in Phase 2 and is now a real passing test.

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDb } from "../src/cli";
import { createSubtask, initRun } from "../src/subtasks";
import { spawnSubtask } from "../src/spawn";
import { pidSweep } from "../src/watcher";
import { synapseBin, FAKES_DIR } from "./helpers";

function freshRepoDb() {
  const cwd = mkdtempSync(join(tmpdir(), "synapse-spawn-"));
  mkdirSync(join(cwd, ".synapse"), { recursive: true });
  const db = getDb(join(cwd, ".synapse", "synapse.db"));
  return { cwd, db };
}

let bin: string;
beforeAll(async () => {
  bin = await synapseBin();
});

function initTaskAndSubtask(db: ReturnType<typeof getDb>) {
  const { runId, taskId } = initRun(db, "test goal");
  const subtaskId = createSubtask(db, {
    runId,
    taskId,
    title: "fake work",
    assigneeRole: "coder",
    dependsOn: [],
  });
  return { runId, taskId, subtaskId };
}

describe("spawn wrapper — three-way failure guarantee (spec §6)", () => {
  test("good.sh: reply lands, row ends done, no wrapper override", async () => {
    const { cwd, db } = freshRepoDb();
    const { subtaskId } = initTaskAndSubtask(db);

    const result = await spawnSubtask(db, {
      subtaskId,
      command: [join(FAKES_DIR, "good.sh")],
      synapseBin: bin,
      cwd,
    });

    expect(result.finalStage).toBe("done");
    const row = db.query("SELECT stage, result_summary, delivered FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.stage).toBe("done");
    expect(row.result_summary).toBe("good.sh: did the work");
    expect(row.delivered).toBe(0); // delivered=0 until watcher delivers after turn
  });

  test("silent.sh: exits 0 without replying -> row ends failed, rev assigned", async () => {
    const { cwd, db } = freshRepoDb();
    const { subtaskId } = initTaskAndSubtask(db);

    const result = await spawnSubtask(db, {
      subtaskId,
      command: [join(FAKES_DIR, "silent.sh")],
      synapseBin: bin,
      cwd,
    });

    expect(result.finalStage).toBe("failed");
    const row = db.query("SELECT stage, result_summary, delivered FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.stage).toBe("failed");
    expect(row.result_summary).toContain("exit 0");
    expect(row.delivered).toBe(0); // failed is never born delivered (§4.2)
  });

  test("crash.sh: exits 1 with stderr -> row ends failed, stderr tail captured", async () => {
    const { cwd, db } = freshRepoDb();
    const { subtaskId } = initTaskAndSubtask(db);

    const result = await spawnSubtask(db, {
      subtaskId,
      command: [join(FAKES_DIR, "crash.sh")],
      synapseBin: bin,
      cwd,
    });

    expect(result.finalStage).toBe("failed");
    const row = db.query("SELECT stage, result_summary FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.stage).toBe("failed");
    expect(row.result_summary).toContain("exit 1");
    expect(row.result_summary).toContain("crash.sh: simulated failure on stderr");
  });

  test("liar.sh: second reply rejected, row unchanged after first reply", async () => {
    const { cwd, db } = freshRepoDb();
    const { subtaskId } = initTaskAndSubtask(db);

    const result = await spawnSubtask(db, {
      subtaskId,
      command: [join(FAKES_DIR, "liar.sh")],
      synapseBin: bin,
      cwd,
    });

    expect(result.finalStage).toBe("done");
    const row = db.query("SELECT stage, result_summary FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.stage).toBe("done");
    expect(row.result_summary).toBe("liar.sh: first reply");
  });

  test("hang.sh + kill -9 the wrapper: row still ends failed via the Phase 3 pid sweep", async () => {
    // spec §4.5 layer 3, plan Phase 2 (written expected-fail then) + Phase 3
    // (src/watcher.ts's pidSweep, the backstop). The wrapper's own guarantee
    // (layer 2) only fires if the wrapper's own process survives to see the
    // child exit. If something kills the WRAPPER itself mid-spawn, the row
    // is orphaned in `assigned` with a live worker pid until the watcher's
    // pid sweep notices the pid is gone.
    const { cwd, db } = freshRepoDb();
    const { runId, subtaskId } = initTaskAndSubtask(db);

    const hangProc = Bun.spawn([join(FAKES_DIR, "hang.sh")], {
      cwd,
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    // Simulate what spawnSubtask's markAssigned write would have done, had
    // the wrapper lived long enough to run it — then simulate the wrapper
    // itself being killed before it could await proc.exited and write the
    // guaranteed terminal state (layer 2 never fires).
    db.query(
      `UPDATE subtasks SET stage = 'assigned', worker_session_id = ?, worker_pid = ?, updated_at = ? WHERE id = ?`
    ).run(crypto.randomUUID(), hangProc.pid, new Date().toISOString(), subtaskId);

    hangProc.kill(9);
    await hangProc.exited;

    const beforeSweep = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(beforeSweep.stage).toBe("assigned"); // orphaned — wrapper never got to write failed

    pidSweep(db, runId);

    const row = db.query("SELECT stage, result_summary, delivered FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.stage).toBe("failed");
    expect(row.result_summary).toContain("pid sweep");
    expect(row.delivered).toBe(0); // failed is never born delivered (§4.2)
  });
});

describe("spawn wrapper — invariant (spec §6, plan Phase 2)", () => {
  test("50 randomized fake runs: no row left assigned with a dead pid and no terminal write", async () => {
    const fakes = ["good.sh", "silent.sh", "crash.sh", "liar.sh"];
    const { cwd, db } = freshRepoDb();

    for (let i = 0; i < 50; i++) {
      const fake = fakes[Math.floor(Math.random() * fakes.length)];
      const { subtaskId } = initTaskAndSubtask(db);
      await spawnSubtask(db, {
        subtaskId,
        command: [join(FAKES_DIR, fake)],
        synapseBin: bin,
        cwd,
      });
      const row = db.query("SELECT stage, worker_pid FROM subtasks WHERE id = ?").get(subtaskId) as any;
      expect(["done", "failed"]).toContain(row.stage);
    }
  }, 30000);
});
