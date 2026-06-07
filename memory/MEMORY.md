# Memory Index

- [Delegate investigation too](delegate-investigation-too.md) — orchestrator should route investigate-and-fix tasks whole, not pre-research them
- [Worktree policy](worktree-before-routing-parallel.md) — always create a worktree for tasks with ≥3 lines of changes; external tools may modify working tree concurrently
- [Restraint on visual effects](restraint-on-visual-effects.md) — default to no hover effect on read-only content; effects pile up fast and feel inconsistent
- [Keep PLAN.md current](keep-plan-md-current.md) — update PLAN.md in lockstep with code commits; bus messages don't substitute
- [Message length asymmetry](feedback-message-length-asymmetry.md) — task dispatch and human replies need full content; tool return values and worker DONE reports should be lean
- [Approval button bug](project-approval-button-bug.md) — S-Deck approve button doesn't send a bus message; human must confirm manually
