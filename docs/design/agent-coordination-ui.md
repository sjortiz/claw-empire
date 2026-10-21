# Agent coordination: task board UI

Task board UI for agent coordination. The server side (scoped delegation, the related-work prompt and agent notes) is described in `docs/design/agent-coordination.md`. This change is frontend-only. It adds no endpoints and changes no prompt or schema.

## What changed

**Assigned scope separated from parent context** (`DelegatedScopeView`). A delegated task card now shows:

1. A green **🎯 Assigned scope · {department}** block listing only that department's numbered checklist. The card shows two items when collapsed and every item with its detail when expanded.
2. A dashed, muted **📎 Parent context · reference only** block, collapsed by default. It holds the capped parent summary and the reference pointer to the full directive.

`parseDelegatedScope` reads the section markers that `buildDelegatedDescription` writes in ko/en/ja/zh. Older delegated tasks, which put the whole directive on the header line, also render correctly: their header text is shown as parent context. Descriptions without a numbered checklist return `null` and render exactly as before.

**Sibling ownership, branch and progress** (`RelatedWorkPanel`). Cards that belong to a source-task family (parent, siblings, children) show a collapsed **🧭 Related work · N** row with an "x done · y in flight" summary. Expanding the row lists up to six tasks, in-flight work first. Each entry shows:

- agent avatar and name, department chip, and status dot and label
- task title
- `⎇ branch · +N commit(s) (vs base)`, or "No active branch"
- the latest report (`task.result`), clipped to 160 characters

Branch and commit data loads only when the user expands the panel: one `GET /api/worktrees` call plus one `GET /api/tasks/:id/verify-commit` per visible task with a worktree. Both endpoints already exist and are local and read-only. Families are computed once per board render in `buildRelatedTaskIndex`.

**Agent notes.** The `ChatPanel` shows peer notes in the agent chat as "Sender · To Recipient" in all four locales, and they are logged to both tasks.

## Why

Departments were redoing the whole directive. Visually, the old card put the full directive first, so the instruction and the background looked the same. The new card gives the owned checklist the strongest visual weight and visibly marks the parent text as reference. The related-work row lets the user see the same thing the agents see in their prompts: who owns which part, what is done, and which branch holds it.

## Safe by default

- Tasks without a delegated checklist and without a family (single-agent tasks) render exactly as before. No panel is mounted and no request is made.
- Bounds: at most 6 related rows ("+N more" for the rest), 160-character reports, and at most 7 git-backed requests, made only on user action.

## Alternatives considered

- **Add `related_work` to the `/api/tasks` payload.** Rejected. It would run git for every task on every board refresh and duplicate the server-side `related-work.ts`. The on-demand panel reuses existing endpoints instead.
- **Show related work in a separate modal or a dedicated page.** Rejected. It is most useful at a glance on the card where the task already lives.
- **Parse the description on the server into structured fields.** Better long term (see known limitations), but it would need another schema change.
- **Restyle peer notes in `ChatMessageList` (distinct bubble colour).** Deferred to keep this change small.

## Known limitations

- The UI depends on the marker strings in `buildDelegatedDescription`. If those strings change, the card falls back to plain text rather than breaking. The tests mirror the four locale formats so drift shows up.
- The UI groups only the source-task family. The server prompt section also includes same-project tasks. This is a deliberate choice to keep the card compact.
- `verify-commit` reports commits relative to the task's compare ref. For tasks whose worktree was already merged or cleaned up, the panel shows "No active branch".
- Peer notes use the same bubble style as agent replies; only the recipient label marks them.
