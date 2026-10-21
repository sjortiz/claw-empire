# Directive planning checklist

Process owner: Operations. Revision 1, 2026-10-21.

Use this checklist during draft review, after consolidation or repair, and after
subtasks are created or reassigned. Attach the completed record to the directive's
planning evidence. This is a manual operational check; production detection,
validation, automatic repair and routing remain Development-owned.

## Directive record

| Field                          | Required entry                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Directive / project            | Task ID and confirmed project path                                                                                                       |
| Reviewer / reviewed plan       | Name, date and plan revision or task references                                                                                          |
| Code changes required?         | Yes / No / Unclear, with directive excerpt and reasoning                                                                                 |
| Requested implementation units | Each issue, fix or other distinct code deliverable; use N/A with reason for non-code work                                                |
| Chosen departments / rationale | Explain required capabilities, including Development for code work by default; retain relevant supporting departments                    |
| Implementation Owner           | For every implementation unit: named accountable implementer, coding department and plan item key; add created subtask ID when available |
| Requested constraints          | Tests, repository, one branch per issue and any other directive requirements                                                             |
| Verification Owner             | Named reviewer, verification item key and required implementation prerequisites                                                          |
| Review outcome                 | PASS / HOLD, uncovered units, correction owner and evidence references                                                                   |

The Implementation Owner field cannot be blank, "TBD", "implementation owner"
or merely a department name for a code-change directive. A named coding owner
must be recorded before the manual review can pass. This record does not add a
new API field or change the production plan schema.

## Coverage map

Copy one row per requested implementation unit. Shared implementation items are
acceptable only if every unit and its constraints remain explicit.

| Implementation unit / source requirement | Implementation Owner / coding department  | Plan key / created subtask ID | Code + test deliverables  | Branch / other constraints | Verification item / owner / prerequisites          | Evidence / gaps                    |
| ---------------------------------------- | ----------------------------------------- | ----------------------------- | ------------------------- | -------------------------- | -------------------------------------------------- | ---------------------------------- |
| `<issue or change>`                      | `<named implementer> / Development (dev)` | `<key> / <ID when created>`   | `<code change and tests>` | `<requested constraints>`  | `<key> / <named reviewer> / <implementation keys>` | `<references or missing coverage>` |

For a docs-only or meeting-only directive, record Implementation Owner as
`N/A — no code changes requested`, with the scope rationale. Do not invent code
work to fill this table. For mixed work, map the code units and track the
non-code deliverables alongside them.

## Manual validation

- [ ] Read the intended outcome in the directive's language. Fixing issues,
      implementing features, building software, changing code, adding tests or
      preparing a code PR can require implementation even without the word
      "Development". A request to document or discuss a fix alone is not a request
      to implement it. Record uncertain scope as HOLD for Planning to resolve.
- [ ] If code changes are required, flag the directive for implementation
      coverage review and include Development by default, or record why another
      assigned department can write the requested code. Keywords are hints, not
      a complete capability assessment.
- [ ] Map every implementation unit to a named Implementation Owner and an
      actionable implementation item with code and tests. Specifications,
      automation readiness, observability plans and evidence documents cannot
      satisfy this requirement by themselves.
- [ ] Preserve all requested deliverables and constraints. For separate issues,
      retain each issue's tests and requested branch separation.
- [ ] Include process work only when requested or when it supports an identified
      implementation item. Record the supported item; do not add a dependency
      solely to show this relationship.
- [ ] Check that verification needing implemented behavior depends on the
      relevant implementation items. Keep independent documentation, test
      planning and readiness work parallel; do not serialize unrelated work.
- [ ] Recheck the complete coverage map after consolidation or automatic repair.
      An unsuccessful correction remains HOLD. Do not treat a repair attempt as
      proof that the plan is valid. Retain distinct departmental items and
      dependency keys; flag dangling references, cycles or lost prerequisites.
- [ ] Compare created subtasks and later assignments against the map. Confirm
      implementation work still has a coding owner and its deliverables,
      constraints and dependencies have survived routing.
- [ ] At completion review, require implementation evidence and verification
      results for every unit. Supporting documents alone cannot close a
      code-change directive.

## Missing coverage response

Record `HOLD — missing implementation coverage` when any code unit lacks an
actionable implementation item or named coding owner, or when code/test scope
has been replaced by process work. List the directive ID, uncovered units,
current assignments, missing deliverables and the Planning correction owner.
Notify Planning and the Development owner through the task's coordination
channel; request the missing assignment rather than creating production changes
from Operations. Recheck the revised plan and created subtasks before PASS.

If the runtime accepts or completes an uncovered plan, retain the planning log
and task references, escalate to Planning for a CEO-visible status update, and
report the enforcement defect to Development. A manual HOLD does not itself
block the server. Follow the [handling procedure](code-change-directives.md).
