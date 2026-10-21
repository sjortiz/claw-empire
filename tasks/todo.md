# Directive recovery — Planning coordination and review

Task: `4a9d8a4c-b5df-4d43-bf79-e1a103d8fb0a`
Branch: `climpire/bce4c288`

Planning owns coordination and review. Development owns the implementation, regression tests, and five item-specific commits. This is the execution checklist requested by the project rules, not a separate specification.

- [x] Confirm the assigned checkout and read local rules.
- [x] Keep production code, test execution, and the live server/database outside this Planning pass.
- [x] Inspect the five reported failure paths and existing recovery safeguards.
- [x] Check for task-log evidence available inside this checkout; distinguish the CEO's incident report from independently verified history.
- [x] Record Development acceptance gates and review findings below.
- [ ] Review Development's implementation and five separate commits when available.
- [ ] Review Development's results for `pnpm run format:check`, `pnpm run lint`, `pnpm run build`, `pnpm run test:web`, and `pnpm run test:api`.

## Review status

Source review completed against `d9d30ad`. Implementation acceptance remains open. No Development implementation diff, five-commit series, or validation transcript was provided in this task session. Existing board assignment/status was not independently verified, and this checklist does not claim a new assignment was created.

No production code or tests were changed, and no tests were run by Planning. No live-server API or database was accessed. No incident log export or `logs/` directory was found inside this checkout. The reported 4.5-hour stalls, 11:09/11:21 start times, 38-second reply, and actual 32-item incident remain CEO-reported history; source inspection confirms the mechanisms, not those historical measurements.

## Verified source findings

Paths below are relative to the repository root; line numbers refer to the reviewed base revision.

| CEO item / Development commit boundary | Confirmed source evidence | Required proof before acceptance |
| --- | --- | --- |
| 1. Persistent root recovery and immediate revision completion | `server/modules/routes/ops/messages/decision-inbox-routes.ts:139` opens supplement rounds in Pending; busy/offline/missing agents return without queuing recovery at lines 144–172. `server/modules/routes/collab/subtask-delegation.ts:471` only auto-resumes Pending for the video render exception; line 557 only advances Review. `server/modules/workflow/orchestration/review-finalize-tools.ts:116` also requires Review. The existing sweep at `server/modules/lifecycle.ts:393` excludes Pending and roots with no unfinished undelegated foreign work. | Last revision completion and cancellation each resume an eligible Pending root immediately. Startup with fresh in-memory maps recovers an eligible root from persisted state; interval sweeps do likewise. Repeated sweeps and simultaneous completion callbacks start it once and log the reason. Cover ready roots in Pending, Planned, Collaborating, and Review while retaining stage-specific gates. |
| 2. Bounded, visible waits and restart recovery | Missing leaders retry every 15 seconds at `server/modules/routes/collab/subtask-delegation-batch.ts:246`; unavailable agents retry every five seconds and repeat the wait log at line 350. `server/modules/routes/collab/task-delegation.ts:422`, `:441`, and `:538` poll integration/planning/self-execution without a limit. `server/modules/routes/collab/subtask-delegation.ts:156` and `:187` keep consolidation retry timers and attempt counts only in memory; the delay is capped, the attempt count is not. | An available eligible alternative is used within the allowed agent pool; otherwise log the department/agent or prerequisite being awaited once per wait episode. Prove a finite deadline, one CEO escalation on exhaustion, no uncontrolled retry chain, and recoverable persisted wait state after restart. Include missing-leader and busy-planning-lead cases, not just department execution. |
| 3. Planning meeting retry and attention state | `server/modules/workflow/orchestration/planned-approval.ts:395–419` catches errors, logs them, already notifies the CEO, fails the minutes, and releases the lock. It does not retry or transition the directive out of Planned. `src/components/taskboard/TaskCard.tsx:92–95` exposes generic Run for Planned and Resume only for Pending/Cancelled. | First meeting failure logs its cause and retries once; success continues once. Second failure persists an attention condition and notifies the CEO with a clear task-card retry action. Restart/sweep must not reset exhausted attempts into an infinite loop. Explicit retry begins a new bounded attempt cycle; cancellation/pause during a meeting prevents relaunch. |
| 4. Run-status-only timeout detection | `server/modules/workflow/orchestration/planned-approval.ts:136–139` concatenates error and successful reply text before matching `timeout after`, `timed out`, `request timed out`, or `aborted`. Bare `timeout` alone does not match this implementation. The same defect exists in `server/modules/workflow/orchestration/meetings/review-consensus.ts:186–189`. `server/modules/workflow/core/conversation-types.ts:37–40` currently provides `text` and optional `error`, without a separate timeout field. | Successful replies containing each matched phrase are accepted without timeout retry, including department drafts and consolidation. Real timeout errors still retry correctly, and non-timeout failures still fail correctly. Keep the shared review behavior consistent in this commit rather than leaving the duplicate detector behind. |
| 5. Oversized planning graphs | `server/modules/workflow/agents/planning-graph.ts:17–18` rejects any declared plan with more than 30 items. `server/modules/workflow/orchestration/planned-approval.ts:321` parses directly without a size-repair request; the consolidation prompt at line 311 does not state the cap. | A valid 32-item plan completes through one summarizer merge request to at most 30, or a documented raised-cap policy. Size alone never fails the whole meeting, including when a repair still exceeds 30. Preserve all work, ownership, evidence, and remapped prerequisites; do not slice items or silently fall back to prose. Malformed/cyclic/missing dependencies must still be rejected. |

## Development review gates

- [ ] Keep all five implementation items in separate commits and provide hashes and regression evidence for each; no push, PR, or GitHub comment.
- [ ] Use one shared internal recovery path with manual Resume. `server/modules/routes/core/tasks/execution-control.ts:500` currently only accepts Pending/Cancelled, and line 526 directly launches execution. Planned recovery must re-enter planning; Review recovery must retain the existing review/decision flow. Do not implement an internal HTTP call to the live server or merely reset every candidate to Planned.
- [ ] Persist why a root is eligible for automatic recovery. Pending also means deliberate user pause (`execution-control.ts:307`) or a worktree error (`server/modules/workflow/orchestration/execution-start-task.ts:154`); an empty list of unfinished subtasks is insufficient evidence to resume either.
- [ ] Handle the last revision becoming Cancelled through the direct callback as well as the sweep. `server/modules/routes/core/tasks/subtasks.ts:168` currently calls completion handling only for Done.
- [ ] Atomically claim work and re-read task/agent availability before launch. Respect active processes, in-flight meeting locks including `planned:${taskId}`, legitimate persisted meetings, explicit pauses, and attention/exhaustion state. Startup must reconcile stale meeting/agent state rather than treating it as permanent active work.
- [ ] Preserve `depends_on` and integration gates. `server/modules/routes/collab/subtask-dependencies.ts:27–37` checks both prerequisite subtask and delegated-task completion; `server/modules/routes/collab/subtask-delegation.ts:431–438` blocks consolidation while children are not integrated. Cancelled revision completion must not make a cancelled prerequisite satisfy a dependent implementation item.
- [ ] Preserve concurrent independent department dispatch, project/manual agent restrictions, directive branch/worktree reuse, and existing merge policy. Do not count an unintegrated child's completed checklist as completed integration.
- [ ] Preserve structured verdict metadata and no-verdict clarification behavior. Recovery must not convert an unresolved verdict into implicit approval or seed nonblocking notes as work.
- [ ] Preserve review autostart settings and pending CEO decisions. `server/modules/workflow/orchestration/review-finalize-tools.ts:154–185` prevents autostart over running review meetings or unresolved revision decisions; recovery must not bypass this gate universally.
- [ ] Log each successful automatic re-queue with task, prior stage, reason, and attempt context. Persist wait/attempt deadlines and notification state so restarts neither lose recovery nor repeatedly notify the CEO.
- [ ] Supply a redacted incident-log export inside this checkout if independent confirmation of the reported historical stalls is required; do not access the live checkout or database to obtain it in this session.

## Required validation handoff

Planning did not execute these commands under the assigned role constraint. These are outstanding acceptance checks, not passing results.

| Command | Result in this Planning pass |
| --- | --- |
| `pnpm run format:check` | Not run; Development evidence required |
| `pnpm run lint` | Not run; Development evidence required |
| `pnpm run build` | Not run; Development evidence required |
| `pnpm run test:web` | Not run; Development evidence required |
| `pnpm run test:api` | Not run; Development evidence required |

Final review must identify the exact tested implementation revision, command exit statuses and test totals, and remaining failures. Source inspection and checklist completion do not establish runtime recovery or authorize implementation acceptance.
