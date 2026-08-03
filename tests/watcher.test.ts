// spec §4.2, §4.4, §4.6, §6 — "the three semantics bugs rev 2 exists to
// prevent" (plan Phase 3): mid-turn loss, coalescing, mutual exclusion —
// plus first-turn session/resume, watcher restart, cascade, and the
// zero-model-calls end-to-end milestone.

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDb } from "../src/cli";
import { createSubtask, initRun, replySubtask, failSubtask } from "../src/subtasks";
import { runIsDone, taskProgress } from "../src/queries";
import { pollOnce, watchLoop, type ManagerTurnFn } from "../src/watcher";
import { spawnSubtask } from "../src/spawn";
import { makePolicyManager } from "./fakes/policy-manager";
import { synapseBin, FAKES_DIR } from "./helpers";

function freshRepoDb() {
  const cwd = mkdtempSync(join(tmpdir(), "synapse-watcher-"));
  mkdirSync(join(cwd, ".synapse"), { recursive: true });
  const db = getDb(join(cwd, ".synapse", "synapse.db"));
  return { cwd, db };
}

let bin: string;
beforeAll(async () => {
  bin = await synapseBin();
});

describe("watcher — mid-turn loss and coalescing (spec §4.2, §6)", () => {
  test("a reply landing during the manager turn is reacted to on the NEXT poll, not lost", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    const subtaskId = createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });

    // First poll: nothing ready-relevant yet reacted to (rev 1 is the init
    // REQUEST) — the manager turn itself writes a reply mid-turn, simulating
    // a transition landing WHILE the turn is running. Because rev_seen was
    // captured before the turn started, this reply's rev is > rev_seen and
    // must NOT be considered reacted-to by this poll's own reactedRev write.
    let turnReplied = false;
    const turnFn: ManagerTurnFn = async () => {
      replySubtask(db, subtaskId, "landed mid-turn", null);
      turnReplied = true;
    };

    const first = await pollOnce(db, runId, turnFn);
    expect(turnReplied).toBe(true);
    expect(first.wokeManager).toBe(true);

    const runAfterFirst = db.query("SELECT manager_reacted_rev FROM runs WHERE id = ?").get(runId) as any;
    const subtaskRev = (db.query("SELECT rev FROM subtasks WHERE id = ?").get(subtaskId) as any).rev;
    // The mid-turn reply's rev must be strictly greater than what the first
    // poll marked as reacted — proving it was NOT swallowed by that poll's
    // own reactedRev write (which used the pre-turn rev_seen).
    expect(subtaskRev).toBeGreaterThan(runAfterFirst.manager_reacted_rev);

    // Second poll: the manager turn does nothing new. It must still be
    // woken (because the mid-turn reply is now visible as unreacted), and
    // after this poll, reacted_rev catches up to the reply's rev.
    let secondTurnCalls = 0;
    const noopTurn: ManagerTurnFn = async () => {
      secondTurnCalls++;
    };
    const second = await pollOnce(db, runId, noopTurn);
    expect(second.wokeManager).toBe(true);
    expect(secondTurnCalls).toBe(1);

    const runAfterSecond = db.query("SELECT manager_reacted_rev FROM runs WHERE id = ?").get(runId) as any;
    expect(runAfterSecond.manager_reacted_rev).toBeGreaterThanOrEqual(subtaskRev);
  });

  test("5 transitions during one turn produce exactly 1 follow-up wake, not 5", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    const subtaskIds = Array.from({ length: 5 }, () =>
      createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] })
    );

    // One manager turn performs all 5 transitions "during" itself.
    const bigTurn: ManagerTurnFn = async () => {
      for (const id of subtaskIds) {
        replySubtask(db, id, "done in the big turn", null);
      }
    };
    await pollOnce(db, runId, bigTurn);

    // Exactly one follow-up wake should be needed to catch up — not 5.
    let followUpCalls = 0;
    const followUp: ManagerTurnFn = async () => {
      followUpCalls++;
    };
    const result = await pollOnce(db, runId, followUp);
    expect(result.wokeManager).toBe(true);
    expect(followUpCalls).toBe(1);

    // A third poll with nothing new must NOT wake the manager again.
    let thirdCalls = 0;
    const third: ManagerTurnFn = async () => {
      thirdCalls++;
    };
    const thirdResult = await pollOnce(db, runId, third);
    expect(thirdResult.wokeManager).toBe(false);
    expect(thirdCalls).toBe(0);
  });
});

describe("watcher — mutual exclusion (spec §4.4, §6)", () => {
  // spec §4.4: mutual exclusion is structural — watchLoop is the ONLY
  // thing that starts manager turns, and it awaits each pollOnce (which
  // awaits runManagerTurn) to completion before looping again. So the
  // real claim to test is watchLoop's sequential behavior under a flood
  // of transitions, not pollOnce called concurrently by something else
  // (nothing in the design does that — pollOnce has no lock of its own
  // because it doesn't need one under the single-caller invariant).
  test("watchLoop never starts a second turn before the first resolves, even under a flood of transitions", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    // One subtask per turn we want to force — each turn's own reply is a
    // fresh rev-bearing transition, keeping watchLoop woken for the next
    // iteration (subtask creation itself carries no rev — a manager write —
    // so a turn must actually reply to something to keep the loop awake).
    const subtaskIds = Array.from({ length: 4 }, () =>
      createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] })
    );

    let concurrentCount = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const controller = new AbortController();

    const turnFn: ManagerTurnFn = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      calls++;
      if (calls === 1) {
        // Flood of transitions landing WHILE this (first) turn is still
        // running — all coalesced into whatever the loop reacts to next.
        for (const id of subtaskIds) replySubtask(db, id, "done", null);
      } else if (calls < 4) {
        // Keep the loop woken for a few more iterations by manufacturing
        // one more transition per turn (a fresh subtask + immediate reply).
        const freshId = createSubtask(db, { runId, taskId, title: "extra", assigneeRole: "coder", dependsOn: [] });
        replySubtask(db, freshId, "done", null);
      }
      await Bun.sleep(30);
      concurrentCount--;
      if (calls >= 4) controller.abort();
    };

    await Promise.race([
      watchLoop(db, runId, turnFn, { intervalMs: 5, signal: controller.signal }),
      Bun.sleep(5000),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(3);
  }, 10000);
});

describe("watcher — first turn session vs resume (spec §4.4, §6)", () => {
  test("first wake isFirstTurn=true, manager_turns becomes 1; second wake isFirstTurn=false", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });

    const seenFirstFlags: boolean[] = [];
    const turnFn: ManagerTurnFn = async (args) => {
      seenFirstFlags.push(args.isFirstTurn);
    };

    await pollOnce(db, runId, turnFn);
    expect(seenFirstFlags).toEqual([true]);
    const afterFirst = db.query("SELECT manager_turns FROM runs WHERE id = ?").get(runId) as any;
    expect(afterFirst.manager_turns).toBe(1);

    // Nothing new landed, so a second poll should not wake at all — force
    // a new transition first.
    const subtaskId2 = createSubtask(db, { runId, taskId, title: "t2", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, subtaskId2, "done", null);

    await pollOnce(db, runId, turnFn);
    expect(seenFirstFlags).toEqual([true, false]);
    const afterSecond = db.query("SELECT manager_turns FROM runs WHERE id = ?").get(runId) as any;
    expect(afterSecond.manager_turns).toBe(2);
  });

  test("a turn that throws before completing leaves manager_turns alone; next wake retries as first turn", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });

    const failingTurn: ManagerTurnFn = async () => {
      throw new Error("simulated turn failure before completion");
    };
    await expect(pollOnce(db, runId, failingTurn)).rejects.toThrow("simulated turn failure");

    const afterFailure = db.query("SELECT manager_turns, manager_reacted_rev FROM runs WHERE id = ?").get(runId) as any;
    expect(afterFailure.manager_turns).toBe(0);
    expect(afterFailure.manager_reacted_rev).toBe(0);

    const seen: { isFirstTurn?: boolean } = {};
    const succeedingTurn: ManagerTurnFn = async (args) => {
      seen.isFirstTurn = args.isFirstTurn;
    };
    await pollOnce(db, runId, succeedingTurn);
    expect(seen.isFirstTurn).toBe(true);
    const afterRetry = db.query("SELECT manager_turns FROM runs WHERE id = ?").get(runId) as any;
    expect(afterRetry.manager_turns).toBe(1);
  });
});

describe("watcher — restart (spec §6)", () => {
  test("a transition landing while the watcher is 'down' is reacted to after restart", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    const subtaskId = createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });

    let calls = 0;
    const turnFn: ManagerTurnFn = async () => {
      calls++;
    };
    await pollOnce(db, runId, turnFn); // "watcher" runs once, then "dies"
    expect(calls).toBe(1);

    // Watcher is down: a fake worker replies directly against the DB.
    replySubtask(db, subtaskId, "landed while watcher was down", null);

    // "Restart": a fresh pollOnce call (equivalent to `synapse watch --run R`
    // being invoked again) must react to it.
    const result = await pollOnce(db, runId, turnFn);
    expect(result.wokeManager).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("watcher — cascade (spec §4.6, §6)", () => {
  test("a failed coder row cascades cancel to its reviewer and tester with the right cancel_reason", async () => {
    const { db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    const coderId = createSubtask(db, { runId, taskId, title: "code it", assigneeRole: "coder", dependsOn: [] });
    const reviewerId = createSubtask(db, {
      runId,
      taskId,
      title: "review it",
      assigneeRole: "reviewer",
      dependsOn: [coderId],
    });
    const testerId = createSubtask(db, {
      runId,
      taskId,
      title: "test it",
      assigneeRole: "tester",
      dependsOn: [coderId, reviewerId],
    });

    failSubtask(db, coderId, "coder blew up");

    const noopTurn: ManagerTurnFn = async () => {};
    await pollOnce(db, runId, noopTurn);

    const reviewerRow = db.query("SELECT stage, cancel_reason FROM subtasks WHERE id = ?").get(reviewerId) as any;
    const testerRow = db.query("SELECT stage, cancel_reason FROM subtasks WHERE id = ?").get(testerId) as any;
    expect(reviewerRow.stage).toBe("cancelled");
    expect(reviewerRow.cancel_reason).toBe(`dependency ${coderId} failed`);
    expect(testerRow.stage).toBe("cancelled");

    // synapse done unblocks: every subtask is now terminal.
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
    expect(runIsDone(db, runId)).toBe(true);
  });
});

describe("watcher — end to end with fakes only, zero model calls (spec §6, plan Phase 3 milestone)", () => {
  test("coder -> reviewer -> tester rows all done, task settled", async () => {
    const { cwd, db } = freshRepoDb();
    const { runId, taskId } = initRun(db, "goal");
    const coderId = createSubtask(db, { runId, taskId, title: "code it", assigneeRole: "coder", dependsOn: [] });
    createSubtask(db, { runId, taskId, title: "review it", assigneeRole: "reviewer", dependsOn: [coderId] });
    // tester depends on coder (subject) and will be created once reviewer exists in a real
    // manager; for this scripted end-to-end we materialize all three up front, sibling rows,
    // per spec §2.3.2's "up-front" creation path.
    const reviewerRowId = (
      db.query("SELECT id FROM subtasks WHERE task_id = ? AND assignee_role = 'reviewer'").get(taskId) as any
    ).id;
    createSubtask(db, {
      runId,
      taskId,
      title: "test it",
      assigneeRole: "tester",
      dependsOn: [coderId, reviewerRowId],
    });

    const manager = makePolicyManager(db, { synapseBin: bin, cwd });

    // Drive polls until settled or a generous cap, since each wake only
    // dispatches whatever is ready at that moment (siblings unblock in
    // sequence as their deps complete).
    for (let i = 0; i < 10; i++) {
      const result = await pollOnce(db, runId, manager);
      const progress = taskProgress(db, taskId);
      if (progress.work_settled === 1) break;
      if (!result.wokeManager) {
        // Nothing left to react to, but also not settled — dispatch a
        // manual manager pass directly since fresh rows becoming ready
        // don't themselves carry a rev.
        await manager({ runId, sessionId: "n/a", isFirstTurn: false });
      }
    }

    const progress = taskProgress(db, taskId);
    expect(progress.work_settled).toBe(1);
    const rows = db.query("SELECT assignee_role, stage FROM subtasks WHERE task_id = ?").all(taskId) as any[];
    for (const row of rows) {
      expect(row.stage).toBe("done");
    }
  }, 30000);
});
