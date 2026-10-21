# Review automation

Both review automation settings are off by default. In **Settings → General**,
turn on **Start review meetings automatically** to remove the project-level CEO
approval step. In the project editor each setting can use the global value,
explicitly enable automation, or explicitly disable it. Project overrides win even
when the global value is enabled. Existing projects inherit the global settings.

Meetings start when every active project task is in Review. The automation starts
all eligible root task meetings, keeping the existing unfinished-subtask,
collaboration, and video artifact checks. Pending revision-pick decisions are not
advanced by this setting. The gate is checked when a task reaches review and in
the background, so enabling the setting for an already-ready project also works.
An in-progress meeting is not started again. Unchanged safety holds retry after
30 seconds, with backoff capped at five minutes to avoid repeating CEO notices on
every timer tick. Task or subtask progress and fresh gate arrivals retry immediately.

Each automatic start logs exactly `Review meeting started automatically (setting)`.
The decision inbox keeps an informational item for each automatically started
task. It can be opened during the meeting and after completion, including after
restart; it has no approval action. The latest 100 task notices are shown.

**Apply all review items automatically** is independent. When enabled it submits
all offered revision-pick options in a pending review round through the existing
revision workflow. It does not choose Skip, start meetings, approve the final
review, or change merge policy. With only meeting auto-start enabled, revision
picks still wait for the CEO.

The pre-existing **YOLO mode** remains a separate broader opt-in: it can still make
its existing review decisions, including selecting recommended revision items,
when these new settings are off. When automatic review-item application is on,
all offered items are applied before YOLO's recommended-item selection.

## API and storage

- Global settings: `reviewMeetingAutoStart` and `reviewItemsAutoApply` accept JSON
  booleans; missing values read as `false`.
- Project fields: `review_meeting_auto_start` and `review_items_auto_apply` accept
  JSON booleans or `null` (inherit). Responses return booleans or `null`.
- Invalid values are rejected before settings or project changes are written.
- The additive SQLite migration leaves old projects inheriting and preserves
  explicit overrides across restart.

Review automation does not grant permission to publish. See [merge policy](merge-policy.md)
for independent local integration and manual merge behavior.
