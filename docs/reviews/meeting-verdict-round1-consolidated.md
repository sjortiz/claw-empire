# Structured meeting verdicts: consolidated review

Review date: 2026-10-21. Owner: Planning.

**Current disposition: the owner checkout now matches the accepted integration production/test tree at `be45d88`, and Development reports all five required full checks passed on that reconciled tree. Ready for renewed approval and system integration, with UI acceptance and the original retry/final-round discrepancy retained as release concerns.**

This document consolidates existing review work; it is not a separate implementation specification. Planning coordinates and reviews; Development owns production reconciliation and verification. Planning changed no production code and ran no tests. Integration recovery does not open another meeting remediation round.

## Integration failure recovery

The system reported integration failure on nine overlapping files after round 3. The owner branch at `3183103` still carried its earlier production implementation (`6afa3e0`/`1895de8`), while system integration `climpire/d-670157a5-a43f-4006-8baa-e535094aa1ed` contained the accepted later implementation (`302cd3d` plus `be45d88`). A documentation-only owner update had not reconciled these competing implementations.

Development reconciled the complete dependent production/test delta in this existing owner checkout: 31 paths (15 modified, nine added, seven deleted). This covers all nine reported conflict paths and migrates their parser, resolver, regression, minutes, chat, and office-preview dependencies together. Obsolete `shared/meeting-verdict.ts`, core resolver, and summary-component duplicates were removed. This reuses the accepted implementation rather than introducing new meeting behavior. Existing Planning review documentation is retained; the Design document already on the system integration branch remains there.

Planning independently compared the union of 507 source/test paths under `server`, `src`, and `shared`, including newly added and removed paths, against the exact `be45d88f586cd0c10509f8d4c36b4bbb413233da` tree: **zero content or presence mismatches**. Development reports no obsolete imports, conflict markers, or unmerged entries. This establishes source equivalence; the system still owns the integration attempt.

Development ran these exact commands on the reconciled owner tree (same production/test content as `be45d88`):

| Required command | Result | Detail |
| --- | --- | --- |
| `pnpm run format:check` | Passed, exit 0 | All matched files formatted |
| `pnpm run lint` | Passed, exit 0 | 0 errors; 40 warnings in unchanged files |
| `pnpm run build` | Passed, exit 0 | 896 modules; existing Vite chunk-size warning (>550 kB) |
| `pnpm run test:web` | Passed, exit 0 | 42 files, 192/192 tests |
| `pnpm run test:api` | Passed, exit 0 | 84 files, 528/528 tests |

These fresh results close the four full-command evidence gaps from the earlier review; they do not rely on combining results from different candidates. Markdown-only review updates follow these checks. No fresh browser or Design acceptance is claimed, and the tests do not waive the documented original-contract discrepancy. No merge, rebase, cherry-pick, push, PR, or GitHub comment is part of this recovery.

## Latest CEO scope and ownership

The authorized reference for existing Development task `b80dbdb8-839c-425d-8eb7-e4460176f4ca` contains a narrower CEO decision than the historical review concerns:

- If consolidation omits `plan_items`, preserve department draft prose through `planningWorkFromVerdict` so approved drafts still seed executable subtasks.
- Exclude informational notes and duplicate summary work from fallback planning input.
- Pass shared `classifyMeetingReviewDecision` through dependencies instead of using a local planned-meeting regex.
- Add regressions for approved draft seeding, notes exclusion, and duplicates. No other remediation in this round.

Planning's initial note 210 restated the historical broader fallback finding. After reading the active task reference, note 212 immediately limited the handoff to the CEO's current checklist. Development notes 209/211/213/214 confirm that scope. Other original-contract discrepancies remain residual review context, not unfinished items in this narrow implementation checklist.

## Exact source and integration evidence

- Historical Planning checkout before review commit `3183103`: `083dd3b`, based on `1895de8` and `6afa3e0`. Its production source was the earlier implementation.
- Previous system integration: `a77fbd63c627a4a62ef0ad93050a4a9811309c23`. Its production files match prior candidate `302cd3d`; only the Design document differs.
- Corrected Development commit: `be45d88f586cd0c10509f8d4c36b4bbb413233da`, directly based on `a77fbd6`.
- At the final source inspection, `climpire/d-670157a5-a43f-4006-8baa-e535094aa1ed` resolves to **`be45d88`**. The system integration branch therefore includes the correction. At that earlier review, the Planning checkout had not incorporated that production tree. The integration recovery above now reconciles it through Development; Planning performed no merge, rebase, or cherry-pick.

The correction touches four scoped files: orchestration dependency wiring, planned approval, the parallel planning fixture, and planned-verdict integration tests. It changes no UI component, review resolver, or round-limit policy.

## Scoped acceptance review

| Owned requirement                                  | Evidence in `be45d88`                                                                                                                                  | Disposition                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Approved drafts survive missing `plan_items`       | Existing separate `workTranscript` receives only department drafts sanitized by `planningWorkFromVerdict`; fallback collector consumes that transcript | Retained and verified in source              |
| Drafts actually seed executable work               | Regression invokes real `createSubtaskSeedingTools` and asserts `[Plan Item] Implement API` exists                                                     | Covered; Development reports API pass        |
| Informational notes do not become work             | Notes-only regression expects an empty callback item list and no seeded plan items while keeping the note in the project memo                          | Covered; Development reports API pass        |
| Repeated consolidation does not duplicate work     | Repeated-draft summary regression expects one fallback item and one seeded subtask; summary is never appended to `workTranscript`                      | Covered; Development reports API pass        |
| Planning uses the shared decision classifier       | `orchestration.ts` injects `classifyMeetingReviewDecision`; draft and consolidation decisions call it on resolved verdict content                      | Implemented; no local planned revision regex |
| A verdict-only retry preserves original draft work | Regression asserts one seeded item and two shared-classifier calls returning `approved`                                                                | Covered; Development reports API pass        |
| Solo planner keeps its original draft              | Existing solo-planner regression remains; consolidation does not replace the draft's work input                                                        | Retained                                     |

No additional CRITICAL/HIGH defect was identified in this scoped correction by Planning's source review. Development reports that the draft-preservation path already existed in the integrated base; this commit strengthens end-to-end coverage and completes shared classifier wiring rather than claiming to newly implement that entire path.

## Verdict summary reconciliation

On exact integrated revision `be45d88`, backend `classifyMeetingReviewDecision` and UI `MeetingVerdictBadge`/`MeetingVerdictCounts` use the same shared verdict parser and `meetingVerdictNeedsRevision` predicate. Valid explicit approval remains approval despite risk/block prose; REVISE requires at least one blocker. Counts use each speaker's latest stored verdict, and historical JSON-only metadata remains readable. The backend persists resolved verdict metadata, which the minutes UI reads separately from rationale. These source relationships remain intact after the scoped classifier change.

This establishes source consistency for valid resolved verdicts. At the earlier review, screenshots and web 192/192 belonged to `302cd3d`; no corrected-revision web result or new UI artifacts had been supplied. Integration recovery now supplies a fresh web-suite pass (192/192) on the reconciled owner tree matching `be45d88`. Fresh browser acceptance and Design's broader visual sign-off remain unconfirmed.

## Previously supplied corrected-revision verification

Development note 213 explicitly attributes these runs to the corrected tree committed as `be45d88`:

| Required command        | Corrected-revision result supplied             |
| ----------------------- | ---------------------------------------------- |
| `pnpm run format:check` | Not supplied; targeted Prettier passed instead |
| `pnpm run lint`         | Not supplied; targeted ESLint passed instead   |
| `pnpm run build`        | Not supplied; `tsc -b` passed instead          |
| `pnpm run test:web`     | Not supplied                                   |
| `pnpm run test:api`     | **Passed: 84 files, 528/528 tests**            |

Development also reports focused 27/27 tests and `git diff --check` passed. Targeted checks and TypeScript compilation do not replace the four missing required full-command results. Planning requested those results through the same Development task after receiving completion, but delivery returned HTTP 409 `recipient_unavailable`; no successful follow-up or rerun is claimed.

Historical verification is preserved strictly as provenance: `1895de8` had reported format/lint/build passes, web 185, API 532; `302cd3d` had reported format/lint/build passes, web 192/192, API 525/525. The historical lint count was 0 errors / 40 existing warnings, and builds reported a bundle-size warning. Those results do not verify `be45d88` and are not combined with its API count.

## Residual review context outside this remediation

The original directive required one retry followed by logged legacy classifier fallback and unchanged final-round rules. The earlier revision `302cd3d` instead introduced `no_verdict` and clarification stops. The latest scoped correction deliberately leaves that behavior unchanged:

- `server/modules/workflow/meeting-verdict.ts` emits `no_verdict` after retry exhaustion.
- The shared classifier returns `reviewing` for missing explicit verdicts; injecting it into planning does not restore the old keyword fallback.
- Review consensus outcome still exits before finalization for missing verdicts, and planned approval still exits for clarification.
- Existing integration assertions still expect those clarification outcomes, including the changed missing-verdict final-round behavior.

This original-contract discrepancy remains explicit for the CEO's release decision. It is not silently waived by accepting the newer, narrower planning correction, and no additional remediation was requested this round.

Previously reported medium UI warnings remain report-only: the zero-blocker downgrade explanation is tooltip-only; retry/legacy provenance is absent from the stored contract; memo entries lack verdict prefixes; chat places blocker/note lists before rationale; historical entries lacking metadata receive a NO VERDICT badge. The malformed-fence display warning also lacks corrected-revision visual verification. None authorizes extra production edits under the current CEO scope.

## Coordination and final readiness

The scoped handoff succeeded (notes 210/212), Development completed and reported the correction (213/214), and the system integration branch now contains `be45d88`. Initial general task API discovery returned HTTP 401 and a prior-agent attempt returned HTTP 403; neither was treated as successful delivery. Inbox notes through 214 were reviewed; handled notes are acknowledged through the local task capability.

The narrow Development checklist was satisfied on source review, supported by corrected-tree API results. The integration recovery above addresses the subsequently reported owner/integration divergence and supplies fresh full-command passes for all five required checks. The recovered owner checkout is ready for renewed approval and system integration. Release approval remains conditional on the CEO's disposition of Design acceptance and original-contract concerns. Carry the remaining original-contract discrepancy and medium UI limitations as documented residual context, without creating another remediation round. Planning does not recommend unconditional merge approval from the available evidence.

The live checkout and database were not accessed. The keyword failure is supported by historical source and regressions, but the supplied live metrics (63/70 approvals, eight directives, timing ranges) remain unverified because no authorized local export was provided. Nothing was pushed, published, or posted to GitHub.
