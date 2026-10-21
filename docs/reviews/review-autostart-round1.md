# Review automation: round 1 evidence

This is an acceptance evidence record, not an implementation specification.
Planning coordinates and reviews; Development owns implementation and command
execution, and Design owns the requested UI captures.

## Revision and provenance

- Selected Development revision: `b2da2b6c68e5c747e8a80110e2fc95db01898380`.
- Integrated revision: `01df5878b6b3dc55cfda3fd2a220c9299d060cf2`.
- Both have source tree `9b6c7a033e3ea1f33f407a6c829d2bbdfb8b3cb4`.
- Final Development evidence/regression: `0fa17c569ff704077b5012da9ecc352b118b8713`.
- Design evidence: `2d95c9f`.
- The Planning checkout remains on the older implementation; no integration or
  production edits were performed in this continuation.

The selected API is `reviewAutoStart` / `reviewAutoApply`, with nullable
`"on"` / `"off"` project overrides in `review_auto_start` / `review_auto_apply`.
Earlier `4020c85` logs and its different API are not evidence for this candidate.

## Observed command results

A delegated Development agent extracted the exact selected revision with
`git archive` into `.tmp/review-round1-b2da2b6/source` inside this checkout.
Database, log and temporary fixtures stayed inside that snapshot. Planning
inspected the retained logs and exit-status manifest; Planning did not run tests.
That baseline passed all five checks, with 204 web and 537 API tests.

Development subsequently committed one additional settings/inbox regression,
clarified feature documentation and durable command evidence in `0fa17c5`.
Planning inspected its manifest and raw logs directly from Git, verified the two
changed-source SHA-256 hashes and all six log hashes, and reviewed the regression.
The final results below cover that delta. A test-fixture type issue found by the
initial build was corrected; affected format/lint/build/API checks passed on rerun.
The unchanged web source retains its successful run.

| Command | Exit | Observed result |
| --- | --- | --- |
| `pnpm run format:check` | 0 | All matched files use Prettier style |
| `pnpm run lint` | 0 | 0 errors, 40 warnings |
| `pnpm run build` | 0 | Built successfully; chunk-size warning |
| `pnpm run test:web` | 0 | 44 files, 204 tests passed |
| `pnpm run test:api` | 0 | 86 files, 538 tests passed |

Local artifacts are retained under `.tmp/review-round1-b2da2b6/evidence/`:
`checks-manifest.json`, `source-integrity.json`, `format-check.log`, `lint.log`,
`build.log`, `test-web.log`, and `test-api.log`. The source-integrity comparison
found zero differences across all 764 archived regular files after verification.
The snapshot and runtime outputs are excluded from Git.

Durable final logs and manifest are in Development commit `0fa17c5`, under
`docs/review-automation-checks/`; its acceptance matrix is
`docs/review-automation-evidence.md`. Unchanged Git-object copies are retained
locally under the evidence directory's `final-development/` folder.

## Acceptance evidence inspected

| Condition | Evidence in selected revision |
| --- | --- |
| Defaults off; unchanged CEO gate | `workflow/core/review-automation.test.ts` and `workflow/orchestration/review-finalize-tools.review-auto-start.test.ts`: missing/false waits, without starting meetings or creating automatic notices |
| Automatic start after readiness | Finalize tests: each eligible project root starts without a decision and logs `Review meeting started automatically (setting)` |
| Project overrides global | Resolver/finalize tests exercise project on/global off and project off/global on |
| Safe automatic triggering | Finalize and `review-auto-start-safety.test.ts`: other active tasks, unfinished subtasks, collaboration children, video artifacts, running meetings and pending revision rounds hold; duplicate gate passes do not duplicate starts |
| Independent revision selection | `routes/ops/messages/decision-inbox/review-automation.test.ts`: auto-start alone leaves picks manual; auto-apply selects all apply options, never Skip, and respects its own override |
| Informational inbox item | Notice tests retain an informational item until acknowledgement; localized modal tests display it without the start-meeting action |
| Four UI languages | Global, project-selector and notice tests cover English, Korean, Japanese and Chinese |

Server paths above are relative to `server/modules/`. Web evidence is in
`src/components/settings/GeneralSettingsTab.test.tsx`,
`src/components/project-manager/ProjectReviewAutomationSelector.test.tsx`, and
`src/components/DecisionInboxModal.review-automation.test.tsx`.

## Visual evidence and disposition

Design evidence is committed separately as `2d95c9f`, under
`docs/design/review-automation-evidence/`: a README and 16 screenshots from
unchanged selected production components, defaults, localization and CSS.
Planning extracted those exact artifacts from the Git objects into the local
evidence directory's `design/` folder and visually inspected all 16 images.

The captures show both global controls off, auto-start on while auto-apply stays
off, project Use global setting / On / Off selected states, global/project/notice
labels in all four UI languages, and an open informational notice offering only
Acknowledge. The narrow component capture uses a 388 CSS-pixel iframe viewport.
Native dropdown popups are not captured; the three selected states and inspected
option lists establish the choices. Visual acceptance is closed.

These are local fixture renders of the selected components, with no-op save
handlers and an inbox fixture. They do not prove backend triggering or persisted
settings. The English fixture summary is intentionally shared across languages;
the production notice label and action are localized. Design reports its local
acknowledgement callback dismissed the fixture modal.

Design's nonblocking warnings are retained without production changes under the
MVP policy: medium, global explanatory help is hover-only; low, the inherited
project choice does not display the effective global value.

The final Development regression exercises the actual `PUT /api/settings` route
and actual database-backed project/informational inbox builders. Saving on leaves
the waiting gate/manual card; the next explicit workflow gate pass starts both
roots, removes that card and leaves an Acknowledge-only notice. The external
meeting-consensus boundary is stubbed with synchronous meeting rows, so this is
gate/inbox integration evidence without CLI/LLM meeting execution.

Planning's evidence review is complete: all requested visual and technical
conditions have concrete artifacts, and the final changed test tree passes the
required checks. System integration and the CEO's publication remain separate.

No critical/high finding was identified in the focused source/evidence review.
The medium selected-candidate limitation remains: saving auto-start after
a gate is already waiting does not itself reevaluate it. Approve that gate
manually, or the next workflow gate pass will use the new setting.
This differs from the older implementation's background retry behavior.

The reported 30-minute and 11-minute delays remain CEO-provided historical
evidence. No live checkout/database was accessed, and no live timing reduction
or end-to-end browser persistence claim is made. Nothing was merged, rebased,
cherry-picked, pushed, published, or posted to GitHub.
