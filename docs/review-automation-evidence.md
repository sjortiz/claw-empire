# Review automation: Development acceptance evidence

Reviewed 2026-10-21. This record addresses the four Development revision items in
task `35b4a4e9-d038-481d-a822-241f071e7287`, in checklist order. No critical/high
production defect was found. The revision adds regression evidence and clarifies
existing behavior; production code remains unchanged.

## Revision and UI evidence

The selected implementation is `b2da2b6c68e5c747e8a80110e2fc95db01898380`.
Its integrated revision `01df5878b6b3dc55cfda3fd2a220c9299d060cf2` has the identical
Git tree `9b6c7a033e3ea1f33f407a6c829d2bbdfb8b3cb4` (confirmed with
`git rev-parse b2da2b6^{tree} 01df587^{tree}`). This Development revision builds on
that integrated snapshot.

Design owns the UI acceptance artifacts in commit `2d95c9f`, under
`docs/design/review-automation-evidence/`. The report was inspected through that
commit; Planning owns artifact integration. Required screenshots are:

- `01-global-default-off-en.png`: global auto-start and auto-apply both off.
- `02-global-start-on-apply-off-en.png`: independent setting state.
- `03-project-inherit-en.png`, `04-project-on-en.png`, `05-project-off-en.png`:
  Use global setting / On / Off selections.
- `inbox-en.png`: open informational notice with Acknowledge only.
- Global, project, and inbox captures in Korean, Japanese, and Chinese, plus the
  narrow component-layout capture. See Design's README for capture details.

These render production components, defaults and localization from `01df587` in a
local fixture preview. They establish UI states, not persisted server state or
actual meeting execution. The technical checks below use isolated in-memory
SQLite fixtures; no live application database is used.

## Technical acceptance

All test paths below are relative to the repository root.

| Acceptance criterion                                                                                     | Code and executable evidence                                                                                                                                                                                                                                                                                                                                                              | Result |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Missing or false global settings preserve CEO approval                                                   | `src/types/index.ts` defines both defaults as false; `server/modules/workflow/core/review-automation.ts` resolves missing/malformed settings to false. `server/modules/workflow/orchestration/review-finalize-tools.review-auto-start.test.ts` asserts the exact manual wait log, no meetings and no auto-start notices for absent/false settings.                                        | Pass   |
| Project override beats global in both directions                                                         | `server/modules/workflow/core/review-automation.test.ts` checks resolution; gate tests exercise global on/project off and global off/project on. `server/modules/routes/ops/messages/decision-inbox/review-automation.test.ts` checks the same precedence for auto-apply.                                                                                                                 | Pass   |
| Project inheritance and persistence remain safe                                                          | `server/modules/routes/core/projects.review-automation.test.ts` checks create/update/reset-to-null and rejects invalid writes; `server/modules/bootstrap/schema/project-merge-policy.test.ts` checks additive migration with existing projects inheriting. `server/modules/routes/ops/settings-stats.seed-init.test.ts` checks boolean round trips and rejection before unrelated writes. | Pass   |
| A ready enabled gate starts all root reviews once with the required log                                  | `server/modules/workflow/orchestration/review-finalize-tools.review-auto-start.test.ts` checks both roots start without CEO input, the exact `Review meeting started automatically (setting)` log, one notice and no duplicate starts on another pass.                                                                                                                                    | Pass   |
| Running tasks and existing safety holds still block                                                      | The gate tests cover other running tasks and existing in-progress/revision-requested meetings. `server/modules/workflow/orchestration/review-auto-start-safety.test.ts` covers unfinished subtasks, collaboration children and missing video artifacts; held tasks produce no false auto-start notices.                                                                                   | Pass   |
| Auto-start alone leaves revision picks manual; auto-apply chooses all applicable items only when enabled | `server/modules/routes/ops/messages/decision-inbox/review-automation.test.ts` checks independent configuration, every `apply_review_pick` option, exclusion of Skip, project precedence and video pre-production behavior.                                                                                                                                                                | Pass   |
| Inbox remains consistent and informational notice can be acknowledged                                    | Added gate regression exercises actual settings route and project/informational inbox builders. The consensus boundary fixture writes in-progress meeting rows, matching the runner's synchronous creation. The manual card disappears once meetings start, leaving one Acknowledge-only notice. Existing notice tests check acknowledgment persistence and removal.                      | Pass   |
| Enabling settings explains already-waiting gates accurately                                              | Added regression starts with an already-waiting gate, saves `reviewAutoStart: true` via `PUT /api/settings`, verifies no start and the manual card remains, then explicitly retries the gate and verifies both reviews start. See the clarified behavior in `docs/review-automation.md`.                                                                                                  | Pass   |

The meeting runner itself is stubbed at the external consensus boundary; these
tests prove gate decisions, database-backed inbox behavior and notices, without
invoking CLI/LLM review meetings. Existing frontend tests verify labels and saved
values in all four UI languages.

## Required checks

All five required commands pass on the final test/doc delta:

| Command                 | Result                                 |
| ----------------------- | -------------------------------------- |
| `pnpm run format:check` | Exit 0                                 |
| `pnpm run lint`         | Exit 0; 0 errors, 40 existing warnings |
| `pnpm run build`        | Exit 0; existing bundle-size warning   |
| `pnpm run test:web`     | Exit 0; 204/204 tests, 44 files        |
| `pnpm run test:api`     | Exit 0; 538/538 tests, 86 files        |

Final Development check results and raw logs are recorded in the
[check manifest](review-automation-checks/checks-manifest.json) alongside the five command logs.
The manifest identifies the implementation baseline and hashes the changed test
and feature documentation so the evidence is tied to the reviewed source.

Planning also supplied exact-`b2da2b6` verification under its checkout's
`.tmp/review-round1-b2da2b6/evidence/`: all five required commands exited 0,
web 204/204 and API 537/537. Its manifest and source-integrity record were inspected.
The additional gate regression increases the API count by one. The initial build
caught null placeholder names in the new test fixture; these were corrected to
strings, and the affected format/lint/build/API checks passed on rerun. The
unchanged web source retains its successful run; the initial build log is also
retained for traceability.

## Review warnings and ownership

- **Medium, Development:** saving the setting alone does not retry already-waiting
  gates. Existing Inbox approval remains usable, and a later workflow gate pass
  uses the newly effective setting. This is documented and regression-covered;
  no automatic sweep was added under the MVP policy.
- **Medium, Design:** global explanatory text is hover-only. See Design's report.
- **Low, Design:** project inheritance does not display the effective global value.

No critical/high blocker remains within Development's assigned scope. Planning
owns consolidation of this technical record, the Design artifacts and final review
approval. No merge, rebase, cherry-pick, push or GitHub publication is performed by
this Development task.
