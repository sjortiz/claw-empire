# Handling code-change directives

Process owner: Operations. Revision 1, 2026-10-21.

Purpose: ensure operational review flags code-change directives whose plans omit
the people and tasks that will implement them. Use the
[directive planning checklist](directive-planning-checklist.md) as the review
record. This procedure can start independently of production changes; it does
not implement or demonstrate server enforcement.

## Responsibilities

| Owner                                   | Responsibility                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning                                | Interpret the directive, preserve requirements, obtain implementation assignments, correct incomplete plans and consolidate evidence                                |
| Development (default coding department) | Own production implementation, intent detection, department participation, graph validation/repair, routing/assignment preservation and runtime regression coverage |
| Operations                              | Record the Implementation Owner coverage map, flag gaps, coordinate corrections and retain operational review evidence                                              |
| Named verification owner                | Plan verification, wait for required implementation prerequisites and report actual results                                                                         |

An unavailable implementer is an assignment/scheduling problem for Planning.
Operations must not silently replace that work with documentation. A different
coding department may own a change when its capability and named implementer
are recorded. Operations does not take over production code in this procedure.

## Procedure

1. **Capture scope.** Read the full directive and project context. Record the
   directive ID, confirmed checkout and requested outcome. Determine whether code
   changes are required from meaning in the directive's language, not department
   keywords alone. List each issue or implementation unit, requested tests and
   branch constraints. For docs-only or meeting-only requests, record why no code
   work is needed; resolve unclear or mixed scope with Planning.
2. **Check the draft.** Complete the checklist's coverage map. Every code unit
   needs a named Implementation Owner in a coding department, an actionable plan
   item and code/test deliverables. Development is the default even when the
   department pre-check lists only Operations or Planning. Retain other relevant
   departments and their recorded rationale. Process items must be requested or
   support identified implementation work.
3. **Raise gaps before operational sign-off.** Mark HOLD for missing owners,
   units, code/test deliverables or lost constraints. Send Planning the uncovered
   units, affected plan keys and requested correction; coordinate with the coding
   owner. Do not claim that specifications, readiness work or completion evidence
   implement a fix. If server acceptance has already occurred, retain the log
   and task references and escalate the enforcement defect to Development and
   Planning for a CEO-visible status update.
4. **Review the corrected plan.** Repeat the full checklist after consolidation
   or repair. Keep HOLD if gaps remain. Development owns automatic repair or
   runtime rejection with a clear log and CEO notification; Operations records
   observed results without claiming that this document enforces them. Ensure
   behavior-dependent verification names its owner and depends on implementation.
   Independent documentation, readiness work and test planning can proceed in
   parallel; implementer availability alone must not create unrelated dependencies.
5. **Check materialization and reassignment.** Map plan keys to created subtask
   IDs. Compare coding department, named owner, code/test deliverables, per-issue
   branches and dependency edges with the reviewed plan. Reopen HOLD and notify
   Planning and Development if routing or reassignment loses implementation
   coverage. This document does not certify any current live assignments.
6. **Retain completion evidence.** Require code diff/branch references and actual
   verification results per implementation unit. Record failed or unrun checks
   explicitly; docs-only delivery cannot complete a code-change directive.
   Development reports the parent directive's required format, lint, build, web
   and API checks. Planning consolidates the final acceptance evidence. Follow
   the directive's publishing restrictions; this procedure grants no permission
   to push, open a PR or comment on GitHub.

## Review examples

These are manual decision examples, not results of a runtime replay.

| Directive / plan                                                                                                                                       | Operational review outcome                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix Nexo issues #84 and #85, with tests and one branch per issue; seven Operations/Planning items covering readiness, specs and evidence               | HOLD: both implementation units lack coding owners and code/test tasks. Send both gaps to Planning; the number of supporting items does not establish coverage.                    |
| Same Nexo request, revised plan maps both issues to named Development implementers, explicit fixes/tests, separate branches and dependent verification | Planning coverage can PASS after the complete checklist; implementation completion still requires both fixes and actual test results. Confirm created task assignments separately. |
| Document a proposed fix without implementing it, or convene a meeting                                                                                  | Record Code changes required = No and Implementation Owner = N/A with rationale. Do not force an implementation item.                                                              |
| Fix an issue and update its runbook; the code item loses its coding owner during routing                                                               | HOLD for lost ownership. The runbook can proceed independently when it does not need the fix; behavior-dependent verification waits for the fix.                                   |

## Evidence and handoff

Retain the reviewed plan revision, coverage map, department-selection rationale,
gap/correction notes, created task references, implementation evidence and
verification results in the directive's task record. A checklist PASS records
manual planning coverage only. Production enforcement and regression proof
remain Development-owned. The later Operations assignment-review task must use
actual created subtasks after its prerequisites are ready; these examples do not
complete that task.
