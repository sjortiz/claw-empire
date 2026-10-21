# Approval merge policy

Approval and integration can now be separate decisions. `mergePolicy` in global
settings accepts `auto` or `manual`. Missing settings default to `auto` for backward
compatibility. A project's nullable `merge_policy` overrides the global setting;
`null` inherits it. The additive SQLite migration leaves existing projects at
`null` and preserves overrides on subsequent starts. APIs reject invalid values
before writing changes.

In automatic mode approval uses the existing local merge into the project's
currently checked-out branch. In manual mode approval still completes the task,
but leaves its branch, worktree, pending edits, project HEAD, index and checkout
untouched. The task log records the effective policy and its source, the branch,
and instructions for reviewing/committing pending edits and merging locally.
Changing policy later does not merge previously kept branches.

Completed task cards, terminal details and reports expose branch review and
**Merge now**. This explicit action merges locally into the project's current
checkout after confirmation. The diff shows the source and actual target branch,
and confirmation names both branches and the project path. The merge API requires
`expectedTargetBranch`; a changed or detached checkout returns HTTP 409 before
auto-commit, merge or cleanup. A missing target returns HTTP 400. The UI refreshes
the diff after a target change and requires a fresh confirmation; detached HEAD
disables Merge now. A successful merge cleans up the worktree; a failed
merge retains it. Review includes staged and unstaged tracked changes and a
warning listing pending files; untracked contents must be reviewed in the
worktree. Registered task worktrees are rediscovered read-only after restart,
and rerunning a task reuses retained work rather than deleting it.

GitHub metadata no longer authorizes publishing. The legacy helper that switched
to `dev`, pushed `origin/dev`, created/updated a PR against `main`, and switched to
`main` has been removed. GitHub projects use the same local merge behavior as
other projects. Neither policy nor **Merge now** pushes or creates a PR. Publishing
requires a separate explicit user action using Git or the user's existing tooling.
No new automatic publishing opt-in is introduced.

## With directive integration branches

With the directive workflow (`docs/directive-workflow.md`), approving a task
integrates it into its directive branch (`climpire/d-<root task id>`) and never
changes the checkout. The merge policy applies once per directive, to that branch,
when the root task completes. In automatic mode the directive branch is merged
locally into the checked-out branch. In manual mode it is kept and the root task
log gives the merge command. Child and revision tasks only integrate.

**Merge now** on a completed root task with no retained worktree merges the
directive branch, with the same `expectedTargetBranch` check. Calling
`/api/tasks/:id/merge` without `expectedTargetBranch` on a task that isn't done
is directive approval: it only integrates into the directive branch.

## Alternatives considered

- A global switch alone cannot protect one sensitive checkout while allowing
  automatic integration elsewhere, so projects can inherit or override it.
- Disabling every automatic merge by default would change established workflows;
  the default stays automatic and sensitive projects can opt into manual review.
- Keeping the GitHub publishing helper behind `github_repo` or the merge policy
  would continue coupling review, integration and remote publication. Removing
  it makes local integration independent of publishing and avoids hidden branch
  switches.
- Deleting retained worktrees or relying only on the in-memory map would lose
  manual review access after restart. Git's existing registered worktrees provide
  recovery without adding another persistence table.

## Testing

Regression coverage includes default, global and project policies, GitHub
projects, legacy migrations, API validation, all four UI languages, retained
branch review, pending changes, restart recovery, and cleanup only after a
successful manual merge.

Real Git tests check that manual approval leaves the checkout HEAD, branch,
index, files, origin URL and the dirty task worktree untouched, including for
GitHub projects and after a restart. Further tests cover a target branch that
changes before confirmation, a missing confirmation and a detached HEAD.

## Notes

- Every manual merge caller must send `expectedTargetBranch` (read it from
  `/api/tasks/:id/diff` as `targetBranch`). Git operations by external processes
  are not serialized by this application-level check.
- Known follow-ups: light-theme colours for the retained-branch banner, showing
  the resolved policy next to "Use global setting", passing the UI language to the
  terminal banner, and consistent Chinese wording.

## Review meeting automation

[Review automation](review-automation.md) documents the separate default-off
settings for starting review meetings and applying review items, including global
values and per-project overrides. These settings do not change merge policy.
