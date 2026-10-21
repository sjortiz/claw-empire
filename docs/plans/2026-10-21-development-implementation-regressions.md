# Implementation coverage regression contract

Regression definition owner: Nova / Development (delegated QA-01, 4fffb9cc-2637-4be0-8eb6-a44982c1ce75). Independent execution verification remains a separately assigned delivery. This matrix defines expected behavior; it does not claim the separately owned QA/API replay has finished.

| Case | Expected departments | Implementation coverage | Real dependencies | Completion behavior |
| --- | --- | --- | --- | --- |
| Explicit API/code fix with Operations keyword inference | Preserve Operations/Planning; add dev | Concrete dev code change + regression tests | Independent preparation parallel; execution verification follows fix | Pending until implementation integrates and verification finishes |
| Mixed code fix and documentation | dev plus inferred documentation owner | Documentation cannot replace dev fix | Standalone docs parallel; release evidence consuming code follows fix | No completion based on docs alone |
| Documentation-only, including API, fix, PR and implementation words | Preserve inferred owners; no forced dev | Not required | Preserve supplied graph dependencies | Existing non-code behavior |
| Announcement or research/report about a fix | Preserve inferred owners; no forced dev | Not required | No invented implementation dependency | Existing non-code behavior |
| Dev-owned implementation specification, readiness/evidence item, or tests-only replacement for a product fix | dev still required | Reject supporting-only graph with per-unit reason | Preserve valid items during correction | Repair/revalidate; exhausted corrections remain unapproved |
| No eligible Development agent (missing/offline/busy/no provider/manual scope) | dev ownership retained | Accepted implementation stays unfinished and explicitly blocked | Downstream verification waits | No Planning fallback; no success completion; retry after eligibility changes |
| Corrected plan | Preserve relevant owners | Revalidate each requested unit, code/tests and branch constraints | Retain real prerequisite keys | Materialize only accepted correction |
| Original Nexo two-issue directive (#84/#85, lint/tests/observability) | Preserve Operations/Planning; add dev | Two distinct dev fixes with tests and one branch per issue | Fixes independent; consuming verification depends on corresponding fix; independent readiness remains parallel | Original seven supporting items rejected; both fixes must complete |
| Meeting skipped or task seeding bypass requested for a code directive | dev remains required | Missing graph/materialization blocks execution explicitly | No prose bypass | Cannot complete without persisted implementation work |

Executable evidence: implementation-intent.test.ts; planning-graph.test.ts; planned-approval.coverage.test.ts; meeting-prompt-tools.test.ts; leader-selection.test.ts; subtask-implementation-ownership.test.ts. Existing parallel planning and subtask dependency tests remain required.

## Development check results

- `pnpm run format:check`: passed.
- `pnpm run lint`: passed, zero errors; 42 warnings (including two unnecessary quote escapes in the new prompt helper; remaining warnings are outside this change).
- `pnpm run build`: passed; Vite warns about existing large chunks.
- `pnpm run test:web --run`: 39 files / 178 tests passed.
- `pnpm run test:api --run`: 84 files / 552 tests passed.
- `git diff --check`: passed.

Accepted example: distinct `Fix Nexo #84` and `Fix Nexo #85` dev items with production code, regression tests and separate branch descriptions. Persisted SQLite evidence records `target_department_id = dev`, `assigned_agent_id = developer`, status `pending` before delegation; ownership regressions verify the actual child task and executor assignments.

Rejected example: the original seven Operations/Planning support items produces missing Development implementation reasons for both `issue-84` and `issue-85`. Dev-owned specifications and tests-only replacements for product fixes also fail. Repeated deficient corrections leave approval uncalled and the directive planned with no seeded subtasks. Missing eligible developers retain dev ownership, explicit blocked reasons, no fallback executor and retry eligibility.

Detection is deterministic and based on action/context evidence; isolated words and stored project goals do not establish code intent. Code directives without an accepted graph (including a skipped meeting) are explicitly blocked rather than executed through the legacy prose path. The independently owned live API replay and QA verification are not claimed by this developer evidence.


## Follow-up batch: routing, materialization and deterministic repair

Owner: Nova / Development, task `2b4b553e-aa79-4ded-93cb-b343412369fe` (implementation under Aria). This builds on integrated commit `2ad82c1`; it does not repeat independent verification or live API replay.

Shared fixture: `server/test/implementation-planning-fixture.ts` exports `nexoDirective`, `nexoImplementation(issue)` and `nexoSupportPlan()`. Planning was notified to forward this fixture to Bolt and the independent verifier. Existing integrated fixtures and production routing were reused.

| Regression | Executable evidence | Observed result |
| --- | --- | --- |
| Operations-only pre-check | `task-delegation.planning.test.ts` | Preserves Operations, adds dev, logs `override=added dev; inferred=operations` and both implementation units. |
| Parallel drafting after inferred department override | `planned-approval.coverage.test.ts` | Real leader selection with Operations-only inference starts Operations and Development drafts before either resolves; consolidation waits for both. |
| Original seven support items | `planning-graph.test.ts`, `planned-approval.coverage.test.ts` | Missing per-unit code ownership and the dangling implementation-owner handoff are rejected. One corrective prompt includes specific violations; repeated support-only output gains two distinct dev code/test/branch items. |
| Actionable materialization | `planned-approval.coverage.test.ts` | Nine SQLite rows retain seven supporting items and add two Development-owned implementations assigned to `developer`. Their code, regression tests and separate issue branch requirements remain in descriptions. |
| Real prerequisites | `planning-graph.test.ts`, `planned-approval.coverage.test.ts` | Per-issue verification waits for its corresponding fix; combined completion evidence waits for both. Setup/specification/readiness items stay parallel. Transitive prerequisite links remain unchanged. Reported completion alone does not unlock verification before delegated implementation is integrated. |
| Actual routing/execution | `subtask-implementation-ownership.test.ts` | Child tasks and executor remain Development-owned, and both distinct implementation items retain their separate branch/test deliverables in the child description and CLI execution prompt. Existing blocked-assignment/rerouting coverage remains intact. |
| Additional consumers | `planning-graph.test.ts` | Code review, lint execution, and work explicitly following implementation require the referenced fix. English, Korean, Japanese and Chinese completion/preparation cases distinguish verification from preparation. |
| Unsafe repair | `planning-graph.test.ts`, `planned-approval.coverage.test.ts` | Cycles introduced by repair, dangling keys, unknown departments and explicit test omission remain unapproved with item/key-specific feedback. The root stays planned and no subtasks are persisted. |
| Valid/non-code plans | `planned-approval.coverage.test.ts`, `planning-graph.test.ts` | Valid plans pass unchanged; documentation-only plans gain no Development work. |

The first added regressions reproduced absent handoff/dependency validation, absent deterministic repair, and generic missing-key feedback. Targeted regressions passed after the corresponding fixes. A focused second review reproduced code-review and after-implementation dependency gaps; those regressions also passed after correction.

Review warning (MEDIUM, reported only under the MVP review policy): after deterministic graph repair, the meeting's displayed prose summary still comes from the model response. The approved, memoized and persisted graph includes the repaired implementation items; the displayed prose can omit them. No presentation changes are included in this Development batch.

Final required checks for this follow-up:

- `pnpm run format:check`: passed.
- `pnpm run lint`: passed, zero errors / 42 existing warnings; this batch adds no lint warnings.
- `pnpm run build`: passed, including TypeScript; Vite retains its large-bundle warning.
- `pnpm run test:web --run`: 39 files / 178 tests passed.
- `pnpm run test:api --run`: 84 files / 574 tests passed (22 more than the integrated baseline).
- `git diff --check`: passed.

Independent verification and the live Nexo API replay remain with their separately assigned owners.
