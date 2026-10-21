# Review automation: round 1 evidence

This is an acceptance evidence record, not an implementation specification.
Planning coordinates and reviews; Development owns implementation and command
execution, and Design owns the requested UI captures.

## Integration revision (2026-10-21)

The failed integration combined different implementations. Parent `9baff52`
retained the original `4020c85` production files even though its acceptance
record reviewed the replacement candidate. Selected integration
`f3187fe758b3d0ec640fa04c5338d9c1b72cd67a` contains Development `b2da2b6`,
Development evidence/regression `0fa17c5`, and Design evidence `2d95c9f`.
Their shared base with the parent is `5561a2735574769fbfff3b77278385ca4da42296`.
The system reported 16 conflicting paths, including schema, project persistence,
gate, inbox, settings UI and feature documentation.

Development reconciled this checkout to the selected file contents: 61 files
restored exactly and seven obsolete variant paths removed. The selected schema,
API, gate, inbox and UI remain unchanged. The Design screenshots and Development
evidence are now present directly in this checkout, alongside this parent review
record. No separate specification or competing implementation was added.

Planning independently compared all 505 selected `src/` and `server/` files plus
the seven obsolete paths against the pinned target's Git blobs: zero mismatches.
Development's disposable-index comparison also confirms all 68 reconciled paths
match, including documentation and image artifacts. Before adding fresh command
evidence, its composed tree differed from the selected target only by this review
record. No merge, rebase or cherry-pick was performed; system integration and
renewed approval remain separate steps.

The round-3 excerpts reference explicit-verdict revision `302cd3d`. Its check
results do not establish acceptance or absence of this feature in the selected
autostart candidate. The source, UI artifacts and gate/inbox evidence below are
bound to the autostart revisions listed here. Historical check counts must not
be presented as fresh results for the reconciled parent.

### Fresh verification of the revised parent

Development ran the required commands in this actual checkout. Planning inspected
the command logs, exit-status manifest, source identity and compatibility proof;
Planning did not execute the tests.

| Command | Final exit | Result |
| --- | --- | --- |
| `pnpm run format:check` | 0 | Passed after isolating stale generated artifacts |
| `pnpm run lint` | 0 | 0 errors, 40 existing warnings |
| `pnpm run build` | 0 | Successful; existing chunk-size warning |
| `pnpm run test:web` | 0 | 44 files, 204 tests passed |
| `pnpm run test:api` | 0 | 86 files, 538 tests passed |

The [fresh manifest](../review-automation-checks/integration-revision/checks-manifest.json)
and [compatibility proof](../review-automation-checks/integration-revision/compatibility-proof.json)
are committed beside the raw command logs. Initial format failures involved
temporary preview/extracted slide artifacts and an unformatted generated proof,
not production source. The old preview directory was preserved intact in this
checkout's ignored `logs/review-integration-revision-local-archive/`, with its
original `.tmp` path retained as a symlink. Generated proof JSON was formatted;
the exact required format command then passed. Tracked formatting policy was
unchanged. Runtime databases, logs and temporary files stayed inside this checkout.

Planning approves this reconciled package for renewed integration review. No
critical/high finding remains from this focused review; this is not a claim that
the system integration has run successfully. The selected behavior remains:
saving auto-start does not immediately retry an already-waiting gate; manual
approval or the next workflow pass releases it. Hover-only global help, the
missing effective-global hint, lint warnings and the bundle warning remain
documented nonblocking limitations. The UI fixtures still do not establish
end-to-end persistence or live CLI/LLM meeting execution. The live checkout and
database were untouched, and nothing was pushed or published to GitHub.

## Revision and provenance

- Selected Development revision: `b2da2b6c68e5c747e8a80110e2fc95db01898380`.
- Integrated revision: `01df5878b6b3dc55cfda3fd2a220c9299d060cf2`.
- Both have source tree `9b6c7a033e3ea1f33f407a6c829d2bbdfb8b3cb4`.
- Final Development evidence/regression: `0fa17c569ff704077b5012da9ecc352b118b8713`.
- Design evidence: `2d95c9f`.
- At the original evidence review, the Planning checkout retained the older
  implementation. The integration revision above addresses that divergence.

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
