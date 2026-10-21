# Implementation coverage: plan and completion report presentation

Presentation requirements for code-change directives. This spec covers two existing text surfaces. It adds no UI task, endpoint or schema, and it blocks nothing in Development.

- **Plan:** the consolidated planned-meeting report that ends in the `plan_items` block (`server/modules/workflow/orchestration/planned-approval.ts`).
- **Completion report:** the planning lead's final consolidated report (`server/modules/workflow/orchestration/planning-archive-tools.ts`, including its fallback and evidence snapshot).

Planning (PLN-01) owns the acceptance rules. Development owns detection, validation and repair. This document defines only how their results are shown to the CEO.

## Why

In the Nexo directive (#84 and #85), the plan listed 7 Operations and Planning items. It looked complete, but no item changed code. A reader had to notice that something was missing, and nothing pointed it out. The fix is to make implementation coverage the first thing in both documents. It is organised by what the directive asked for, not by what the plan happens to contain, so a missing owner shows up as a visible row instead of an absence.

## Required presentation

**1. One section, first.** Both documents open with an **Implementation coverage** section. In the plan it comes before the prose and the JSON block. In the completion report it comes directly after the Executive Summary and before Team-by-team Consolidation. `parsePlanningGraph` reads only the fenced block, so adding text before it is safe.

**2. One row per requested code change.** Rows come from the directive's requested changes (for example, one per issue), not from plan items. Each row shows these fields in this order:

| Field | Content | Source when no structured field exists |
| --- | --- | --- |
| Requested change | What the directive asked for, with the issue number | Directive text |
| Implementation item | Plan key and title | `plan_items[].key`, `.title` |
| Owner | Department and agent: `Development — Aria` | `department_id` and the `Owner:` line in `description` |
| Branch | Shown only when the directive asks for branches | Directive constraint, then the task worktree branch |
| Expected code outcome | The production behaviour that changes, in one sentence | `Expected outcome:` line in `description` |
| Verification | The test that must exist and be run | `Verification:` / `Evidence:` line in `description` |
| Status | Three separate states (rule 4) | Subtask and child-task state, commit and test evidence |

If Development adds structured fields for these, read those first and fall back to the description lines.

**3. Owner missing state.** If a requested change has no item with an implementation department (`dev` today), the row still appears:

```
⚠ IMPLEMENTATION OWNER MISSING — <requested change>
   No Development item implements this change. Supporting items do not count.
   Plan status: not acceptable
```

- The headline counter shows the number of missing owners whenever it is above zero.
- The word "missing" always appears. Never show the state through colour or an icon alone.
- Supporting items (tests set up by Operations, documentation, observability) never fill this row. They are listed under **Supporting work** with the label `supporting — does not satisfy implementation`.
- A Development item with no expected outcome or no verification shows `⚠ outcome not specified` or `⚠ verification not specified` in that field. The row is not hidden.

**4. Three states, never merged.** Each row reports three states, each one a word plus a mark:

| State | Meaning | Evidence required to show ✅ |
| --- | --- | --- |
| Specified | The item, outcome and verification are written down | The plan item exists and its fields are filled in |
| Implemented | A production code change exists | A branch with commits ahead of the base, or a named diff |
| Verified | The required test was run and passed | The command run and its result |

- Use `✅` for done, `⬜` for not yet and `⚠` for claimed without evidence. Each mark is always followed by its word.
- One state never stands in for another. A finished design doc or test plan sets only Specified.
- An item marked done without a diff shows `Implemented ⚠ no code evidence`.
- The report headline for a code-change directive reads `Code implemented N/M · Verified K/M`. It never reads "complete" while either count is below M.

**5. Shared and split items.** When the directive asks for one branch per change, every row has its own branch. If one item covers two changes, both rows show `⚠ shared item — separate branch required`. One change may have several items (for example, implementation plus verification). They are listed under the same row.

**6. Not applicable vs missing.** A directive that asks for no code change shows `Implementation coverage: not applicable — no code change requested`, along with the reason. This text is grey and neutral, and it never uses the missing wording. If the intent is unclear, show the missing state. Do not show "not applicable" by default.

## Annotated examples

### A. Two fixes, plan (Nexo #84 and #85, corrected)

```
## Implementation coverage
Requested code changes: 2 · Owned by Development: 2 · Owner missing: 0        ← counter first

1. Nexo #84 — ‹issue #84 title›                                            ← row = requested change
   Implementation item: DEV-84 "Development: fix #84 ‹title›"              ← key + title
   Owner: Development — Aria
   Branch: fix/issue-84                                                     ← separate branch per issue
   Expected code outcome: ‹production behaviour that changes›
   Verification: regression test reproducing #84; fails before, passes after; run in the project's test command
   Status: Specified ✅ · Implemented ⬜ · Verified ⬜

2. Nexo #85 — ‹issue #85 title›
   Implementation item: DEV-85 "Development: fix #85 ‹title›"
   Owner: Development — Bolt
   Branch: fix/issue-85                                                     ← never shared with #84
   Expected code outcome: ‹production behaviour that changes›
   Verification: regression test reproducing #85; fails before, passes after
   Status: Specified ✅ · Implemented ⬜ · Verified ⬜

## Supporting work
- OPS-01 Operations — test automation setup        supporting — does not satisfy implementation
- PLN-01 Planning — acceptance criteria            supporting — does not satisfy implementation
```

### B. Same directive, original failed plan

```
## Implementation coverage
Requested code changes: 2 · Owned by Development: 0 · Owner missing: 2        ← cannot be overlooked

⚠ IMPLEMENTATION OWNER MISSING — Nexo #84 ‹title›
   No Development item implements this change. Supporting items do not count.
⚠ IMPLEMENTATION OWNER MISSING — Nexo #85 ‹title›
   No Development item implements this change. Supporting items do not count.
Plan status: not acceptable — 2 requested code changes have no implementation owner

## Supporting work (7)                                                        ← the 7 items stay visible
- Operations — test automation setup               supporting — does not satisfy implementation
- Operations — observability configuration         supporting — does not satisfy implementation
- Planning — documentation …                       supporting — does not satisfy implementation
```

### C. Mixed implementation and support work, completion report

```
# Final Consolidated Report: ‹directive›
## Executive Summary
Code implemented 2/2 · Verified 1/2 — not complete                         ← headline never says "complete" early

## Implementation coverage
1. Nexo #84 — DEV-84 · Development — Aria · fix/issue-84 (+3 commits)
   Expected code outcome: ‹…›
   Verification: ‹test name› — `pnpm test ‹path›` passed (12/12)            ← command + result
   Status: Specified ✅ · Implemented ✅ · Verified ✅
2. Nexo #85 — DEV-85 · Development — Bolt · fix/issue-85 (+2 commits)
   Expected code outcome: ‹…›
   Verification: ‹test name› — not run yet
   Status: Specified ✅ · Implemented ✅ · Verified ⬜                        ← implemented ≠ verified

## Supporting work
- OPS-01 Operations — CI test job added            Specified ✅ (supporting)
- DSN-01 Design — coverage presentation spec       Specified ✅ (supporting; no code)  ← spec counts only as Specified

## Team-by-team Consolidation …
```

### D. Documentation-only directive

```
## Implementation coverage
Not applicable — no code change requested ("Update the deploy README for nginx")   ← neutral, gives the reason
Specifications delivered: 1 · Code implemented: n/a · Verified: n/a
```

## Localisation

Section and state labels follow the report language (`resolveLang`). Suggested labels:

| en | ko | ja | zh |
| --- | --- | --- | --- |
| Implementation coverage | 구현 커버리지 | 実装カバレッジ | 实现覆盖 |
| Implementation owner missing | 구현 담당 누락 | 実装担当者なし | 缺少实现负责人 |
| Specified / Implemented / Verified | 명세 / 구현 / 검증 | 仕様 / 実装 / 検証 | 规格 / 实现 / 验证 |
| Supporting — does not satisfy implementation | 지원 작업 — 구현으로 인정되지 않음 | 支援作業 — 実装には含まれない | 支持工作 — 不计为实现 |
| Not applicable — no code change requested | 해당 없음 — 코드 변경 요청 없음 | 該当なし — コード変更の依頼なし | 不适用 — 未要求代码变更 |

Keep the `⚠`, `✅` and `⬜` marks the same in every locale.

## Out of scope

- Task board or modal UI changes. A later UI could render the same rows inside `DirectiveProgress`, but that is not authorised here.
- Detecting code-change intent, validating the plan, repairing it and rejecting it. Those belong to Development and to PLN-01. This spec only shows their results.
