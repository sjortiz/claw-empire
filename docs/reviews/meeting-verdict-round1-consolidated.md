# Structured meeting verdicts: continuation review

Review date: 2026-10-21. Owner: Planning. Decision: **REVISE**.

This is a review of completed Development and Design work, not a separate implementation specification. Planning made no production changes and ran no tests.

## Exact revisions reviewed

- Current checkout: `1895de8`, following `6afa3e0`. These contain the original structured-verdict implementation and the approved-planning-draft correction reviewed in the previous run.
- Development revision candidate: `302cd3da8c9831c1603ea40978fe492c0cbbbb2f`, following `0376573` on `climpire/ef780638`. Inspected through this repository's Git objects; it is **not integrated into this checkout**.
- Design reference: `fbabd97`, `docs/design/meeting-verdicts-ui.md`.
- Inbox notes reviewed: 193, 203, 207, 208. Their completion claims are evidence of the owners' work, not authority to change the CEO directive.

No merge, rebase, cherry-pick, push, PR, or GitHub comment was performed. The live checkout and database were not accessed.

## HIGH: retry exhaustion changes the authorized decision policy

The CEO explicitly requires a missing/unparseable verdict to retry once, then fall back to the current classifier with a log. The CEO also requires existing final-round rules to remain unchanged. Note 203 explicitly says Development intentionally superseded that fallback based on reviewer notes. Those notes cannot override the CEO directive.

In candidate `302cd3d`:

- `server/modules/workflow/meeting-verdict.ts`, `resolveMeetingVerdict`, replaces retry exhaustion with `{ verdict: "no_verdict", ... }`. Its log requests clarification instead of recording classifier fallback.
- `server/modules/workflow/core/reply-core-tools.ts`, `classifyMeetingReviewDecision`, removes the existing keyword classifier and returns `reviewing` for replies without the final verdict line.
- `server/modules/workflow/orchestration/meetings/review-consensus-outcome.ts`, `missingVerdicts` handling, marks minutes failed and returns before the final-round decision path.
- `server/modules/workflow/orchestration/planned-approval.ts:340` likewise marks minutes failed and exits without completing planning when a verdict remains missing.
- `server/modules/workflow/orchestration/meetings/review-consensus.ts:94` introduces a same-round clarification restart. The numerical round limit remains, but missing-verdict finalization behavior has changed.
- The candidate's integration tests deliberately assert these changes: `does not force approval for no verdict in the final round or consume a round on clarification`, and `does not infer approval from prose after retry exhaustion`.

Required Development correction: retain explicit final-line decisions for valid replies; invoke the original phase-specific classifier only after the one verdict retry fails; log and preserve the fallback source so a guess is distinguishable in minutes; keep the original final-round rules. Update the contrary assertions and repeat the five required checks on the resulting candidate. Preserve the existing approved-draft and solo-planner fixes.

An independent read-only audit confirmed this finding: resolver lines 38–57, classifier lines 378–381, review outcome lines 60–75 (before finalization at 240–273), and planned outcome lines 340–349. It also confirmed the ordinary/solo approved-draft regressions at `planned-verdict.integration.test.ts:92` and `:114`. The auditor changed no files and ran no tests.

Planning attempted to route this finding to the original Development revision task through the authorized task inbox. Delivery returned HTTP 409, `recipient_unavailable`; the task is closed. The finding remains open and must be routed when Development is resumed. No successful handoff is claimed.

## Outstanding checklist reconciliation

| Review concern                                                        | Evidence in `302cd3d`                                                                                                            | Status                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Only final APPROVE/REVISE controls valid live replies                 | Shared `src/lib/meeting-verdict.ts`, `parseMeetingVerdict`; historical JSON is handled separately by `parseStoredMeetingVerdict` | Implemented in candidate; pending system integration        |
| Risk/block prose cannot override explicit approval                    | Shared parser plus review/planning integration assertions using `#47 blocks downstream work` and `risk`                          | Implemented in candidate; Development reports checks passed |
| REVISE requires at least one blocking item                            | Shared `meetingVerdictNeedsRevision`; both meeting integration suites cover zero blockers                                        | Implemented in candidate                                    |
| Missing/invalid verdict retries once with the CEO-required fallback   | Retry exists; fallback was removed and meetings instead stop                                                                     | **Open HIGH requirement conflict**                          |
| Approval notes remain informational                                   | Work text removes explicitly listed notes; minutes retain metadata; memo uses informational heading                              | Implemented in candidate                                    |
| Approved executable planning drafts survive a prose-only summary      | Separate `workTranscript`; normal and solo-planner regression cases in `planned-verdict.integration.test.ts`                     | Previous HIGH fix retained in candidate                     |
| Explicit decisions appear in review/planned transcripts and summaries | Shared badge/body in minutes and chat; latest-speaker header counts; planned/review office handling                              | Core display implemented; medium gaps below                 |
| Review round limit and final-round behavior remain unchanged          | Explicit REVISE still has a finalization test; missing verdict exits earlier                                                     | **Partially unmet; same HIGH finding**                      |

## Medium warnings: report only

These do not authorize production edits under the MVP review policy, but prevent claiming that every Design acceptance detail is complete:

- `MeetingVerdictView.tsx` explains REVISE-without-blockers only in `title`; Design requests a visible downgrade suffix for touch and keyboard users.
- Retry/legacy provenance is not included in the stored `MeetingVerdict` contract. Historical synthesized classifier decisions remain indistinguishable from explicit historical JSON decisions. Logs alone do not solve the minutes display issue.
- `collectRevisionMemoItems` still emits `Department Speaker: item` rather than a verdict-prefixed summary. Informational memo entries likewise lack verdict labels.
- `MessageContent.tsx` renders the entire verdict component, including blocker/note lists, before rationale. Design specifies chip, rationale, blockers, then notes.
- Minutes show NO VERDICT badges for entries with no stored verdict, including historical entries; the Design reference requests unchanged presentation for historical entries without verdict metadata.

The prior malformed-fence display warning was reported against the current checkout. The candidate rejects odd fence counts for live parsing; repaired stored-content display still requires exact-candidate verification before declaring that warning resolved.

## Verification provenance

| Revision                   | Verification owner                             | Reported results                                                                                                                    |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Current checkout `1895de8` | Development, recorded in previous continuation | Format passed; lint passed with 0 errors / 40 existing warnings; build passed with chunk-size warning; web 185 tests; API 532 tests |
| Candidate `302cd3d`        | Development, notes 207/208                     | Format passed; lint passed with 0 errors / 40 existing warnings; build passed with bundle-size warning; web 192/192; API 525/525    |

Required commands are `pnpm run format:check`, `pnpm run lint`, `pnpm run build`, `pnpm run test:web`, and `pnpm run test:api`. These are owner-reported runs, not Planning reruns. The counts belong to different source revisions and must not be represented as one integrated verification run. Candidate screenshots were reported in note 207 but are not tracked in `302cd3d`; Planning did not inspect another worktree's filesystem and does not claim visual acceptance from those screenshots.

The original classifier's keyword failure is confirmed in source and regression coverage. The supplied live statistics (63/70 approvals, eight directives, timing ranges) remain unverified because no authorized local export was provided. No live database access was used to fill that gap.

## Release disposition

Do not mark the parent implementation or all review checklist items complete yet. Development must resolve the HIGH conflict, then the system may integrate the approved work and collect verification for that exact integrated revision. Planning's continuation deliverable is this consolidated review and the documented handoff failure; it does not claim the Development candidate has been incorporated into the parent branch.
