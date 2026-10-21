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

Dependency reuse copies/reflinks compatible pnpm installations into each
worktree instead of sharing a writable node_modules directory. Manifest, lockfile,
configuration, local dependency, workspace and script checks reject unsafe reuse.
Unsupported projects use their normal install. Automatic commits respect Git
ignore rules and skip known untracked tool/cache directories while retaining
restricted-file checks. No existing task data or branches are rewritten.

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
