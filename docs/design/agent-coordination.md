# Agent coordination

Delegated departments previously received the whole directive as their primary instruction. Persisted child descriptions and the separate immediate-launch prompt now put only that department's ordered checklist first, including item IDs and descriptions. Parent background is capped at 500 characters. The complete directive stays on the parent task and is fetched as read-only reference. Planned-meeting items now request execution of their assigned item instead of another planning pass.

All task launch paths add a shared related-work snapshot: automatic starts/resumes, explicit task runs, delegated batches, cross-department cooperation, and direct agent spawns. It covers the same source-task family and project, excludes the current task, and lists task ID/title, agent/department, status, actual worktree branch, local commits ahead of the explicit base branch (or current project HEAD), and latest report. Missing Git data is reported as unavailable; it never starts a merge or network operation. No related tasks means no added prompt section or inbox instructions.

A task-session capability authenticates the exact `GET/POST /api/agent-messages` endpoint. The server requires a loopback socket and Host, rejects browser Origin and forwarded requests, validates the active task/session/assignee, and limits recipients/references to the same source-task root or a nonempty matching project ID. The HMAC capability is separate from CEO authentication and interrupt control; it grants no other API access and expires when the execution session rotates or closes. Saved runtime prompt files use owner-only permissions.

Notes are ordinary agent-to-agent chat messages with an indexed `task_agent_notes` inbox and durable monotonic cursor. One savepoint writes the message, inbox record, and both task logs. The existing `new_message` event makes notes visible to the CEO; chat filtering includes incoming peer notes and renders recipient names in ko/en/ja/zh. An additive table/index migration preserves existing messages and the CEO pause/inject API.

Agents receive commands to read the inbox before work, between milestones, and before reporting. Notes that arrive too late for the agent to poll automatically trigger a continuation after successful process exit, before review or delegated completion. It reuses the same dirty worktree and assigned scope. There are at most three automatic continuations per execution session; overflow remains in the inbox for the next explicit run. Failed/stopped runs never auto-restart. A failed note continuation retains earlier work/branch and returns its delivered notes to the unread inbox. If the original worktree is missing, startup blocks pending rather than creating/replacing a worktree or marking delegated items complete. Running CLI stdin is never interrupted.

## Local protocol

Use the task ID, session ID, and capability supplied in the run prompt. Keep the capability local; do not put it in chat or task logs. Examples assume shell variables `AGENT_NOTE_TASK`, `AGENT_NOTE_SESSION`, and `AGENT_NOTE_TOKEN` contain those values. The port matches the server's configured `PORT` (8790 by default).

Read a page; use `next_cursor` as the next request's `after` value. Reads do not acknowledge notes:

```sh
curl --fail --silent \
  -H "Authorization: Bearer $AGENT_NOTE_TOKEN" \
  "http://127.0.0.1:8790/api/agent-messages?task_id=$AGENT_NOTE_TASK&session_id=$AGENT_NOTE_SESSION&after=0"
```

POST valid JSON to that same URL, with the same Authorization header and `Content-Type: application/json`. A JSON file (`--data-binary @note.json`) avoids shell quoting problems. The sender is always derived from the authenticated task session:

```json
{
  "task_id": "CURRENT_TASK_ID",
  "session_id": "CURRENT_SESSION_ID",
  "to_task_id": "RELATED_TASK_ID",
  "content": "Implementation is on my branch; please reuse the parser rather than rebuild it."
}
```

Exactly one of `to_task_id` or `to_agent_id` is required. Agent addressing resolves to a unique related active/pending task; ambiguity requires a task ID. Missing/unassigned, unrelated, self, done, or cancelled recipients are rejected. Acknowledgement uses the same POST URL and identity with `acknowledge_through: LAST_HANDLED_INTEGER_ID`, without a content/recipient field. It affects only that task's inbox. Notes are peer reference data and cannot override CEO instructions or authorize merges/pushes.

Fetch the full parent reference with the same authenticated GET, adding `reference_task_id=PARENT_TASK_ID`. Each response contains an 8000-character description page, `offset`, and `total_chars`; advance `offset` until complete. This capability does not authenticate the general `/api/tasks/:id` endpoint.

## Bounds and alternatives

- Checklist: 12,000 characters overall, 2000 per item detail; parent background: 500 characters. IDs preserve access to omitted details on the parent reference.
- Related work: six tasks, 6000 characters overall, 420 characters per latest report. Existing delegated status/artifact/conversation blocks also have caps.
- Note: 2000 characters; inbox: at most 12 rows and 8000 prompt characters per page. Only complete notes included in a prompt are marked delivered; omitted notes remain unread.
- Admission: 30 sends per source task per minute and 100 unread notes per recipient task. Cursor IDs disambiguate equal timestamps. Automatic continuations: three per session.

Embedding the full directive in a quoted appendix was rejected because it still amplifies prompts and encourages whole-job execution. Sharing the CEO bearer token was rejected in favor of a task/session capability. Reusing the paused-only inject endpoint would require pausing and grant the wrong authority. Writing to live CLI stdin is incompatible with existing one-shot runners, which close stdin after the initial prompt. Cooperative inbox reads plus a bounded provider-neutral continuation preserve the existing launch model and deliver late notes without CEO intervention.

## Known limitations

- Notes included in the initial prompt are marked delivered before the provider run succeeds. If that first run fails or is interrupted, they are not put back as unread. Explicit authenticated inbox reads still return them.
- A late note can only continue work in the task's original worktree. A note that arrives after that worktree is gone waits in the inbox for the next explicit run.

## Testing

Regression coverage includes scoped department descriptions/direct prompts, planned-item execution semantics, all four locales, related-task selection and Git fallbacks, authentication/session rotation, socket/host/origin guards, unrelated recipients, pagination/limits/reference access, durable chat/log visibility, dirty-worktree reuse, late-note continuation, failure preservation, and stop/pause behavior. All tests use in-memory databases or isolated test runtime paths.
