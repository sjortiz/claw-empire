# Review automation

Two settings let review meetings and revision picks proceed without a CEO click in
the Decision Inbox. Both default to off, so existing behaviour is unchanged.

| Setting (UI)                         | Global key        | Project override    |
| ------------------------------------ | ----------------- | ------------------- |
| Start review meetings automatically  | `reviewAutoStart` | `review_auto_start` |
| Apply all review items automatically | `reviewAutoApply` | `review_auto_apply` |

Scoping works like the merge policy (`docs/merge-policy.md`). The global keys are
booleans in settings; `PUT /api/settings` rejects other values. A project's
override is `null` (inherit the global value), `"on"` or `"off"`, and the project
override beats the global setting. The additive SQLite migration leaves existing
projects at `null`. The project API rejects other values before writing changes.
The settings are independent: auto-apply does not require auto-start.

## Start review meetings automatically

The project review gate holds a root task in Review until every active task of its
project is in Review. Without this setting it then waits for the CEO to approve
"project-level review meeting" in the Decision Inbox. The task log shows
`Review gate: waiting for project-level decision (N/N active tasks in review)`.

With the setting on:

- While other tasks are still running, the gate keeps waiting and logs
  `Review gate: waiting for other project tasks (…)`.
- When the gate conditions are met, the team-lead review meeting starts for every
  root task of the project in Review, as if the CEO had approved it. Each started
  task logs `Review meeting started automatically (setting)`.
- The CEO gets a chat notice and an informational Decision Inbox item
  ("Review Meeting Auto-Started"). It lists the tasks, needs no decision, and stays
  until the CEO clicks **Acknowledge**.
- It waits, as the Decision Inbox item does, while a project review meeting is
  running or a review round decision is pending, so a revision pick is never
  skipped.
- The existing review holds still apply (unfinished subtasks, collaboration
  children, video artifacts). A held task starts later, when the gate runs again.
  No notice is posted for held tasks.

The gate runs when a task reaches Review. Turning the setting on does not release
a gate that is already waiting; approve that one from the Decision Inbox.

## Apply all review items automatically

When a review round ends with revision requests, the Decision Inbox asks the CEO
which review items to apply. With this setting on, once the planning lead
has prepared the options, every review item is applied as revision work. The
round's skip option and the planner's recommendation are ignored. The task logs
`Review items applied automatically (setting)` after the regular
`Decision inbox: review decision resolved (action=apply_review_pick, …)` entry.
Video pre-production tasks keep this decision manual, as in YOLO mode.

With the setting off, revision picks stay manual even when review meetings start
automatically.

## Relation to YOLO mode

YOLO mode (`yoloMode`) answers every Decision Inbox item with the planner's
recommendations. These settings are narrower and can be enabled per project.
Auto-apply runs before YOLO mode, so with both on, review rounds apply every item.
The informational auto-start item is never answered automatically.

## Testing

Server tests cover the gate with the setting off (waits, as before) and on (starts
without a decision, once). They also cover waiting for other tasks, the project
override beating the global setting in both directions, and auto-apply
choosing every item only when its own setting is on. Further tests cover API
validation, the migration, the inbox notice and its acknowledgement. Web tests
cover the global toggles, the project selectors and the inbox notice label in
all four UI languages.
