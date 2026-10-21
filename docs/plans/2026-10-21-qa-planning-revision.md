# QA review revision: implementation ownership

**Decision: QA approval withheld.** The production implementation is available
and the original Nexo regression passes. New QA regressions reproduce a HIGH
coverage bypass for mixed implementation/documentation directives, including
representative requests in all four supported UI languages. Development must
correct this behavior before the parent is accepted.

Owned item: `ec497805-2967-4cc4-876d-b02d1689d15e`; QA task
`13a31790-fa10-43cd-9427-0b6690ce3525`; session
`234890de-cd93-4bcb-be5e-8cdd1cd8f0f0`. Review date: 2026-10-21.

## Actual implementation reviewed

QA ran the checks independently at integrated HEAD
`82ceced2df5386bfb892a03b19cd39128ca07193`, plus this batch's enabled test changes.
The parent branch at review was
`fbdc22b8cc3f01577f21ede6b3985e95cf390d4c`; its server tree matches this QA
baseline exactly. The earlier documentation-only concern is resolved.

Against immediate pre-coverage revision `5561a27`, the implementation changes
12 production TypeScript files, +691/-54 lines. Production commits are
`2ad82c1`, `1139826`, and `e359f32`; `897b9a4` supplies the HTTP regression.
The final mixed-intent correction previously described as an uncommitted patch
is committed in `e359f32` and is included in this review.

| Planning path | Actual production changes |
| --- | --- |
| Participation and intent | `implementation-intent.ts`, `task-delegation.ts`, and `meetings/leader-selection.ts` add Development from code intent and log override reasons. |
| Approval and task creation | `planning-graph.ts`, `planned-approval.ts`, and `subtask-seeding.ts` validate/repair per-unit code/test/branch deliverables, reject invalid graphs, and preserve real prerequisites. |
| Execution ownership | `subtask-routing.ts`, `subtask-delegation-batch.ts`, `execution-run-auto-assign.ts`, and `execution-run.ts` retain Development ownership or explicitly block unavailable execution. |
| Conditional prompts | `conversation-types.ts` and `meeting-prompt-tools.ts` propagate implementation requirements into planning prompts. |

These are server files under `server/modules/`; inspect the focused diff with
`git diff 5561a27..82ceced -- server/modules`. QA changes only tests and evidence.
Development remains accountable for production changes.

## QA-HIGH-01: mixed requests bypass all implementation coverage guards

Location: `server/modules/workflow/agents/implementation-intent.ts:44-86`.
The clause splitter handles sentence boundaries and English action conjunctions;
the supplemental-work splitter handles only `with/including/alongside/plus`.
The later `supportingTarget` check rejects a remaining clause containing a
documentation target, even when the same clause explicitly requests code fixes.
It returns `requiresImplementation=false`; downstream guards then accept the
support-only graph without implementation ownership.

Failing stored CEO directives in
[the independent QA acceptance suite](../../server/test/qa/planning-implementation.acceptance.test.ts):

- `Fix the first two open issues on Nexo, #84 and #85, add tests and documentation, one branch per issue`
- `Fix API authentication and documentation`
- `버그를 수정하고 문서를 업데이트해`
- `APIのバグを修正して文書を更新`
- `修复登录功能并更新文档`

All five return false instead of true. Four corresponding documentation-only
controls pass, including controls with a stored code-change project goal.
The suite also specifies required departments, unit constraints, rejection of
the support-only plan, and valid repaired deliverables once intent is corrected.
Those later assertions cannot run while the first intent assertion fails.

The [existing HTTP replay](../../server/modules/routes/collab/nexo-planning.api.test.ts)
now runs both the original directive and the comma-separated mixed variant:

| Request | Actual HTTP result | Persisted graph | Result |
| --- | --- | --- | --- |
| Original sentence-separated Nexo directive | 200 | Nine rows: seven supports plus two pending Development implementations with code/tests/separate issue branches; consumers depend on actual implementation IDs. | Pass |
| Comma-separated Nexo directive with tests and documentation | 200 | Seven Operations/Planning support rows, zero Development owners, every dependency empty. | Fail: expected two implementation owners, received zero. |

This is the original user-visible failure shape reproduced through real HTTP
intake, delegation, planning and SQLite seeding. The fixture always returns the
same deficient support-only graph. Real model calls, external execution and
ancillary integrations are stubbed; the database is in memory. No live server,
application database, Nexo checkout or actual Nexo issue branches are used.

**Required correction, owner Development / Aria:** retain the actual code action
and its per-issue test/branch constraints when supporting work shares the
request, in the supported languages; keep documentation-only controls negative.
Rerun both changed suites and all required checks on the corrected production
revision. QA has sent reproductions to parent Planning for assignment and has
not changed another department's production code.

## Independent command results

Runtime: Node 24.20.0, pnpm 10.30.1. All commands ran in this isolated checkout.
Final format, lint, build and API runs include both changed test files.
The web run preceded the API-test-only additions and uses the same production
and frontend tree. `--run` makes the requested Vitest scripts terminate.

| Command | Exit | Observed result |
| --- | --- | --- |
| `pnpm run format:check` | 0 | Pass. |
| `pnpm run lint` | 0 | Zero errors, 42 existing warnings. |
| `pnpm run build` | 0 | TypeScript and Vite pass; existing bundle-size warning. |
| `pnpm run test:web --run` | 0 | 39 files, 178 tests pass. |
| `pnpm run test:api --run` | 1 | 84 files pass, two fail; 586 tests pass, six fail. All six failures are the five added intent cases and added mixed-request HTTP replay. |
| Targeted independent QA suite | 1 | Four docs-only controls pass, five code/support cases fail. |
| Targeted Nexo HTTP suite | 1 | Original directive passes; mixed variant fails. |
| `git diff --check` | 0 | Pass. |

All 582 previously existing API tests pass; the added four negative controls
also pass. The six new regression failures remain enabled and are not skipped
or reclassified as expected successes. Existing parallel planning, dependency,
seeding, rerouting, execution ownership and unavailable-developer checks pass
within the full API suite. This does not turn the overall API check into a pass.
The parent does not require a `check` script, and this batch does not claim one.

[Machine-readable results and both persisted HTTP graphs](evidence/qa-planning-revision.json)
retain the before/after-input evidence. Raw local output is under
`.tmp/qa-planning-revision/` (ignored). Supporting documents and prior green
results cannot close QA-HIGH-01. AC-01, AC-02, AC-04 and AC-07 remain unmet for
these reproduced mixed requests; AC-09 cannot pass with the failing API check.

The prior MEDIUM warning that model prose can omit deterministically repaired
items remains report-only; QA made no presentation changes. No merge, rebase,
cherry-pick, push, PR or GitHub comment was performed. The QA investigation and
regression handoff are complete; approval of the parent remains blocked on the
Development correction and verification.
