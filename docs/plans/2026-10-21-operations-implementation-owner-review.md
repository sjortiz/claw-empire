# Operations review: directive implementation owners

Review date: 2026-10-21. Reviewer: Turbo, Operations; review accountability:
Atlas, per delegated Operations item. Review item:
`82df85c6-752a-4084-a109-075c8900fa67`; execution task:
`d9f43f07-1451-44b6-a140-b10856ff101c`.

This records a manual assignment review during planning. It does not certify
runtime enforcement, implementation completion or the Development-owned API
replay. No production code, task assignments or dependency edges were changed.

## Prerequisite and reviewed sources

- The [directive planning checklist](../procedures/directive-planning-checklist.md)
  and [handling procedure](../procedures/code-change-directives.md) are present
  at review baseline `eaecf15`, incorporating Operations commit `f9d9e3e`.
  The prerequisite `OPS-PLAN-001` is therefore satisfied before this review.
- Parent directive `5b948211-0b00-47b1-91f8-9f96a4ecb8ff`, including its
  complete 8,642-character description, was read through the task-scoped
  reference API. Its planning memo retains both `DEV-01` style and `DEV-1`
  style keys; these are distinct items.
- Planning acceptance contract
  `docs/plans/2026-10-21-implementation-coverage-acceptance.md` was reviewed
  read-only at integration revision `f91169c` (Planning commit `d9bc927`).
  It maps AC-01 through AC-09 to the existing Development work. No integration
  operation was performed in this worktree.
- Development execution task `2ae1242d-0123-4a91-a194-6ba714852e07` was read
  through the same reference API. Its delegated checklist supplies the item IDs,
  named planned owner and deliverables below. The supplied session snapshot
  identifies Nova as the executing Development agent for this batch.

The scoped reference API exposes task descriptions, not persisted assignment
rows or execution logs. Description evidence establishes the delegated plan;
it cannot establish that every later assignment or reroute preserved that plan.
Owner confirmations and any remaining gaps are recorded below.

## Directive review log

| Directive                                                                                                                                | Code changes required / units                                                                                                             | Assigned implementation owners observed                                                                                                                                          | Review decision                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current parent: fix directive planning so code-change requests always get implementation owners (`5b948211-0b00-47b1-91f8-9f96a4ecb8ff`) | Yes: intent/units, planning inputs, coverage acceptance/repair, prompt rules and execution ownership; code plus regressions are required. | Aria / Development in the delegated implementation checklist; Nova / Development executing the six-item batch in the supplied task snapshot. Per-item mapping follows.           | Named Development work is present in this draft. HOLD final assignment sign-off pending the missing materialization and verification evidence below.        |
| Historical reference: “Fix the first two open issues on Nexo”, #84 and #85                                                               | Yes: two issue fixes, tests for each and one branch per issue.                                                                            | Original seven-item plan: Operations/Planning only; no coding owner. CEO-added Development work is reported in the parent narrative, without named per-issue owners or task IDs. | HOLD for the original draft: both units lacked implementation. The narrative does not establish the corrected per-issue assignments or a successful replay. |

### Current directive: coverage map

Aria is the named planned implementation owner for the rows below. Nova is the
batch executor shown by the provided session snapshot; that does not silently
replace the accountable owner in the delegated plan. Shared changes may cover
overlapping items only if their separate obligations remain traceable.

| Required unit                                                                                 | Plan key / delegated item ID                         | Implementation Owner / department | Code and test deliverables in reviewed plan                                                                                                                                                                        | Evidence still required                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Include implementation capability in planning inputs, preserving relevant support departments | `DEV-01` / `e7d017d3-4f56-4786-b0ff-092306277ff5`    | Aria / Development (`dev`)        | Change department pre-check/planning inputs; Nexo regression proves Development participation without a Development keyword. Coordinate with `DEV-1` and `DEV-2`.                                                  | Production diff, department-selection rationale/log and created assignment comparison.                                                         |
| Detect requested code work and distinct units in context                                      | `DEV-1` / `208c7cd1-67ee-443a-bc56-2abaaa662f6c`     | Aria / Development (`dev`)        | Implement deterministic intent/unit function; unit tests preserve #84/#85 and separate branches, with research/report/documentation negative controls.                                                             | Production diff, executed unit results and handoff to dependent `DEV-2`/`DEV-3`.                                                               |
| Reject deficient graphs and validate corrections                                              | `DEV-02` / `4c5f3cef-c961-45b6-8547-5aa80e1b1f05`    | Aria / Development (`dev`)        | Change graph acceptance so code/test implementation cannot be replaced by specifications/readiness/evidence; clear correction reasons and no invalid acceptance after exhausted attempts. Coordinate with `DEV-3`. | Accepted/rejected graph results, automatic repair or explicit block/notification evidence, and regression results.                             |
| Preserve coding ownership through creation and execution                                      | `DEV-03` / `42817db7-dd3c-454f-9055-991d3335cae3`    | Aria / Development (`dev`)        | Change materialization/assignment/execution; missing eligible developers leave implementation explicitly pending. Routing/materialization regressions are assigned separately to `DEV-04`.                         | Persisted child assignments and routing results, including unavailable-developer case.                                                         |
| Strengthen draft and consolidation instructions conditionally                                 | Prompt item / `96dfd9e7-7a6f-4d84-ad90-da952accf6d8` | Aria / Development (`dev`)        | Change prompts using agreed intent/unit interface; require executable code work for every unit and preserve non-code behavior. Snapshot/string tests demonstrate conditional rules.                                | Production prompt diff and executed tests. The parent excerpt does not establish this item's local graph key; do not infer one from numbering. |

These are actionable production changes. Planning criteria, the Design
presentation specification and Operations procedures support them; none counts
as implementation. Development is appropriate because these units change the
planning server's behavior. Planning owns acceptance/evidence consolidation,
Design owns presentation requirements, and Operations owns manual review and
handling. This is the reviewer's capability rationale, not a captured runtime
department-selection log.

### Dependencies and verification ownership

The parent memo specifies the following prerequisites. They are review inputs,
not proof of the currently persisted graph:

| Item                                                                         | Required prerequisites                                                   | Assignment evidence / review state                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEV-2`: include Development in pre-check                                    | `DEV-1`                                                                  | Development department is specified; named executor and created item ID pending owner evidence.                                                            |
| `DEV-3`: validate and repair missing implementation items                    | `DEV-1`                                                                  | Development department is specified; named executor and created item ID pending owner evidence.                                                            |
| `QA-01`: define regression coverage / `4fffb9cc-2637-4be0-8eb6-a44982c1ce75` | No implementation prerequisite; test planning may proceed independently. | In Nova's Development batch, but delegated owner text says “explicitly assigned QA verification owner” without naming a reviewer. Clarification requested. |
| `DEV-04`: routing/materialization regressions                                | `DEV-01`, `DEV-02`, `DEV-03`, `QA-01`                                    | Development department is specified; named verifier and created item ID pending owner evidence.                                                            |
| `QA-02`: verify implementation and required checks                           | `DEV-04`                                                                 | Development department is specified; named verifier and created item ID pending owner evidence.                                                            |
| Nexo API replay                                                              | `DEV-2`, `DEV-3`                                                         | Development-owned; named verifier, accepted plan, created children and replay results pending.                                                             |
| Complete required verification/report                                        | `DEV-1`, `DEV-2`, `DEV-3`, `DEV-4`, `DEV-5`                              | Parent memo uses this separate key family; retain it without assuming equivalence to `DEV-04`. Actual key-to-item mapping pending owner evidence.          |
| Planning acceptance/consolidation                                            | `PLN-01`, `QA-02`                                                        | Remains pending implementation verification. Supporting document completion cannot satisfy it.                                                             |

No dependency should be added solely because work supports an implementation
item. Independent criteria, Design specification, Operations documentation and
test planning can stay parallel. Behavior-dependent verification must retain its
implementation prerequisites through graph repair and routing.

### Nexo unit constraints retained for subsequent replay review

| Unit     | Original draft owner/item           | Required corrected assignment evidence                                                                                                              |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nexo #84 | Missing coding owner and code task. | Named coding implementer, executable item/created task ID, #84 code fix plus tests, distinct issue branch, verification owner and prerequisites.    |
| Nexo #85 | Missing coding owner and code task. | Named coding implementer, executable item/created task ID, #85 code fix plus tests, a different issue branch, verification owner and prerequisites. |

This task reviews planning coverage in this project's checkout. It does not
repeat the Nexo fixes or request changes in Nexo's repository. A representative
API replay belongs to Development and must use an isolated environment. Docs-only
and meeting-only directives must retain `Implementation Owner = N/A` with their
scope rationale; that is an acceptance requirement, not an observed replay result
in this review.

## Open findings and handoff

1. **HOLD: assignment/materialization evidence incomplete.** The current draft
   has named Development implementation work, but later child assignments,
   dependent implementation IDs and routing preservation are not established by
   task descriptions. Planning owns the complete key-to-item/owner map;
   Development supplies assignment/routing evidence. Do not interpret this as
   proof of a runtime defect or delete/recreate their work.
2. **HOLD: verification owner not named in the reviewed QA item.** Planning and
   Development must identify the verifier and preserve implementation
   prerequisites. Being assigned to `dev` alone does not complete the manual
   checklist's named-verifier field.
3. **HOLD: historical Nexo correction/replay unverified.** Original plan fails
   coverage for both units. Await per-issue accepted-plan-to-child evidence from
   Development; a repaired draft alone cannot prove execution ownership.

The parent directive's format, lint, build, web and API checks remain
Development-owned and unrun by this Operations review. Final directive
completion remains pending production diffs and verification results.

## Coordination and document checks

- Initial inbox: no notes. Coordination requests sent to parent Planning
  task (note 104) and Development batch (note 105). The completed Planning
  criteria task was unavailable for a new note; its integrated document was
  reviewed instead.
- Findings and correction requests sent to Planning (note 106) and Development
  (note 107). No owner reply was present at the closing inbox check; no incoming
  note required acknowledgement. Requested evidence remains explicitly open.
- `pnpm exec prettier --check` for this review log passed. Both relative links
  resolve; all six delegated item IDs are included; the referenced Planning
  contract exists at its integration revision. `git diff --cached --check`
  passed before committing this document.

A manual HOLD records the evidence gap; it does not block server acceptance or
certify a code defect. Re-review the coverage map when the requested evidence is
available. Operations' review-log delivery is distinct from a PASS for the plan
or completion of the parent directive.
