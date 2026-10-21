# Directive workflow

A root task owns `climpire/d-<root task id>`. Following `source_task_id` ancestry
keeps collaboration and revision tasks on the same integration branch. The branch
is created once from the root's configured base branch (otherwise the initial
project HEAD). New task branches start from its current tip. Existing task
branches remain valid; registered worktrees, including uncommitted revision work,
are recovered rather than deleted or reset.

Approval integrates Git objects with `merge-tree --write-tree`, creates a merge
commit, and advances the directive ref with compare-and-swap. Concurrent approval
retries against the latest tip. Neither the project checkout nor an agent's index
is used for integration. Conflicts leave the ref unchanged and return the same
task to its owner for revision in its retained worktree. Git must support
`merge-tree --write-tree` (Git 2.38 or newer); failures remain actionable.
The integration branch survives task-worktree cleanup and is the single CEO
review result. Approval never pushes, opens a PR, or updates dev/main. The legacy
GitHub approval entry point also integrates locally. Publishing remains a
separate, explicit CEO action. The merge policy (`docs/merge-policy.md`)
decides whether a completed directive's branch is merged into the checkout.

Planning-capable leaders and seniors are selected by availability and assigned
workload. Department leaders draft concurrently from the same initial context;
the assigned planning lead consolidates their drafts. Independent departmental
work dispatches in parallel. Explicit subtask dependencies defer only dependent
items until prerequisite work has integrated. The lead emits a validated
`plan_items` graph with local keys; seeding resolves those keys to subtask IDs.
Graph items execute as department-owned children, including origin-department
items, and the root consolidates after them. Legacy prose plans and tasks remain
supported; dependency updates are also available through the subtask API.

Plans above the 30-item target receive one bounded summarizer pass that groups
work within its owning department. The merged graph must retain every department
and pass key, dependency and cycle validation. If merging fails or still exceeds
30 items, the validated original graph is retained and the size target is raised
for that meeting with a logged reason. Size alone never rejects a plan.

Dependency reuse copies/reflinks compatible pnpm installations into each
worktree instead of sharing a writable node_modules directory. Manifest, lockfile,
configuration, local dependency, workspace and script checks reject unsafe reuse.
Unsupported projects use their normal install. Automatic commits respect Git
ignore rules and skip known untracked tool/cache directories while retaining
restricted-file checks. No existing task data or branches are rewritten.

## Recovery and attention

Ready directive roots are re-queued on startup and every subtask-sweep interval.
Finishing or cancelling the last department revision triggers the same execution
path as task-card Resume immediately. Approval and integration remain prerequisites;
root-local revision consolidation runs on the resumed root. Explicit pauses and
unresolved review decisions stay under CEO control.

Resource waits record their start in task logs and survive restart. After fifteen
minutes they stop and notify the CEO; waiting tasks become pending so the task
card exposes Resume. Resume clears exhausted wait budgets and attention-blocked
department work, then retries delegation or planning. Planning-graph integration
uses a separate one-hour wait limit. Live parent runs continue while a blocked
department awaits attention.

A planning meeting that throws retries once, with its reason logged. A second
failure persists an attention reason, moves the directive to pending and notifies
the CEO. The task card shows the reason and a Retry planning meeting action that
uses the shared Resume path. Missing structured verdicts retain their
clarification limit and also require explicit attention rather than silently
starting execution.

## Testing

Regression coverage exercises base selection, worktree recovery, successful and
conflicting integration, unchanged checkouts, planner selection, parallel drafts,
and dependency-aware dispatch, including lost-callback recovery. Unit tests also
cover sibling refresh that keeps revision commits and dirty files, deferring
refresh when staged or conflicting work exists, nonstandard and orphaned branch
recovery, conflict retry, dependency release, and retention of the full
department drafts.

## Known limitations

- Staged or overlapping revision work needs the owning agent to reconcile it
  before the task's branch is refreshed from the directive branch.
- Integration needs Git 2.38 or newer for `merge-tree --write-tree`.
