# Implementation coverage view: directive planning fix

Design's response to the two review-revision requests (`476b6c4e`, `c755228c`). The final plan must clearly separate implementation from supporting work, name a Development owner for each requested code fix, and link every supporting task to that owner.

This view applies the [coverage presentation spec](implementation-coverage-presentation.md), including the new rule 7, to parent `5b948211`. Planning owns the consolidated resubmission. It should place the section below first in [the CEO acceptance review](../plans/2026-10-21-planning-ceo-acceptance-review.md), before the acceptance matrix. Design does not edit that document, because Planning is revising it on `climpire/5b948211`.

Facts come from the CEO review, its ownership map and Development's reports. Design ran no tests. Status marks repeat what Development reported.

---

## Implementation coverage

Requested code changes: 3 · Owned by Development: 3 · Owner missing: 0
Code implemented 3/3 · Verified 3/3 (per Development's final report: `test:api` 582 pass, `test:web` 178 pass)

**1. Recognize code-change intent in any UI language and include Development in planning, with the chosen departments and reasons logged**
- Implementation items: `DEV-01` implementation participation (`e7d017d3`), `DEV-1` intent and units (`208c7cd1`), `DEV-2` pre-check inclusion (`3088bf6c`)
- Owner: **Development — Aria** (accountable); executed by Nova; F-01 mixed-request correction executed by Bolt
- Code: `2ad82c1`, F-01 correction `e359f32`. Files: `implementation-intent.ts`, `task-delegation.ts`, `meetings/leader-selection.ts`
- Expected code outcome: an Operations-only keyword match still gains Development when the directive asks for code. The log reads `Planning pre-check related departments: operations, dev` and `override=added dev; inferred=operations`.
- Verification: `implementation-intent.test.ts`, `task-delegation.planning.test.ts`, `leader-selection.test.ts`, `nexo-planning.api.test.ts`
- Status: Specified ✅ · Implemented ✅ · Verified ✅

**2. Require real code and test work in every approved code-change plan; repair the plan or block approval and notify**
- Implementation items: `DEV-02` coverage acceptance (`4c5f3cef`), `DEV-3` validation and repair (`d62f9b47`), conditional drafting and consolidation prompts (`96dfd9e7`)
- Owner: **Development — Aria** (accountable); executed by Nova
- Code: `2ad82c1`, `1139826`. Files: `planning-graph.ts`, `planned-approval.ts`, `meeting-prompt-tools.ts`, delegation and seeding guards
- Expected code outcome: a support-only plan is rejected, repaired with Development implementation items and revalidated. An unrepairable plan stays unapproved and is logged. Supporting work never counts as implementation.
- Verification: `planning-graph.test.ts`, `planned-approval.coverage.test.ts`, Nexo HTTP replay (rejection, then repaired acceptance)
- Status: Specified ✅ · Implemented ✅ · Verified ✅

**3. Keep the implementation owner through seeding, routing, materialization and execution**
- Implementation item: `DEV-03` execution ownership (`42817db7`)
- Owner: **Development — Aria** (accountable); executed by Nova
- Code: `2ad82c1`. Files: `subtask-seeding.ts`, `subtask-routing.ts`, `subtask-delegation-batch.ts`, `execution-run-auto-assign.ts`, `execution-run.ts`
- Expected code outcome: implementation children and their executors stay `dev`. An unavailable developer blocks or delays the work and never falls back to Planning or Operations.
- Verification: `subtask-implementation-ownership.test.ts`
- Status: Specified ✅ · Implemented ✅ · Verified ✅

## Supporting work

Each item is `supporting — does not satisfy implementation`. The arrow names the implementation row and owner it serves.

| Item | Department — agent | Delivered | Supports |
| --- | --- | --- | --- |
| `QA-01` regression definition (`4fffb9cc`) | Development — Nova | Regression contract | → all rows · Development — Aria |
| `DEV-04` routing and materialization regressions (`7f367e5e`) | Development — Nova | Tests only, no production change | → row 3 (`DEV-03`) and row 1 · Development — Aria |
| `QA-02` independent verification (`6ad1c405`) | Development — Bolt | Verification report | → all rows · Development — Aria |
| Nexo API replay (`83386cb9`) | Development — Bolt | HTTP regression `897b9a4` and evidence JSON | → rows 1 and 2 · Development — Aria |
| Final required verification (`720e0244`) | Development — Bolt | Five required commands and report | → all rows · Development — Aria |
| `PLN-01` acceptance criteria (`bad7764e`) | Planning | Acceptance contract | → all rows · Development — Aria |
| CEO acceptance review (`e277f358`) | Planning — Clio (item assigned to Sage) | Evidence consolidation | → all rows · Development — Aria |
| Implementation-owner checklist validation | Operations | `docs/procedures/directive-planning-checklist.md` | → row 2 (`DEV-02`) · Development — Aria |
| Implementation-owner assignment review (`82df85c6`) | Operations — Turbo | Review record | → row 3 (`DEV-03`) · Development — Aria |
| Code-change directive procedure | Operations | `docs/procedures/code-change-directives.md` | → all rows · Development — Aria |
| Coverage presentation spec | Design — Luna | Specification only, no code | → row 2 (`DEV-02`) · Development — Aria |

Supporting items not linked to an implementation item: 0.

Development verification items are listed here, not as extra implementation rows, because the directive asked for the planning fix with tests, not for separate test deliverables.

---

## Notes for Planning's resubmission

- **Rows come from the directive, not from item keys.** The three rows are the directive's three code outcomes. `DEV-01`/`DEV-1` and `DEV-02`/`DEV-2`/`DEV-3` stay separate keys under their row, matching the CEO review's rule not to merge key families.
- **Nexo #84/#85 are fixtures, not rows.** This directive did not ask for those issues to be fixed. Listing them as rows would suggest Nexo code was changed. The CEO review's fixture table can stay where it is.
- **F-03 (MEDIUM, report only).** Model summary prose can still omit repaired implementation items. This view is a static document; Design does not claim the live plan output renders it. No code change is requested under the MVP review policy.
