# Enquiry capture v1.0.0 — website Task processor

Implements the 29 Sep 2026 brief and its amendment 1 (D3 tightened; the no-Opportunity
message says what to do). The canonical description of the result is
[`docs/context.md`](context.md); this file covers what was built, where the brief turned out
wrong, and what is still to check in Sandbox.

**Not merged, not deployed.** Steve tests in Sandbox, merges and deploys.

## What was built

| File | Purpose |
|---|---|
| `src/FileCabinet/SuiteScripts/NuHeat/Enquiry Capture/enq_ss_process_tasks.js` | scheduled script: queue loop, case dispatch |
| `…/lib/enq_lib_config.js` | parameters, audit key, field IDs, date parsing, logging helpers |
| `…/lib/enq_lib_parse.js` | pure Notes parser, `truncate`, `flattenAddress`, D2 date tests |
| `…/lib/enq_lib_entity.js` | `readCustomer(id)` |
| `…/lib/enq_lib_task.js` | `searchQueue`, `readTask`, `hasEarlierWebsiteTask`, `complete`, `reassign`, `fail` |
| `…/lib/enq_lib_project.js` | `createProjectForEntity(cfg, input)` |
| `test/parse.test.js`, `package.json` | 26 node tests (`npm test`, no dependencies) |
| `README.md`, `reference/README.md`, `docs/context.md` | email-capture content replaced |

All files are SuiteScript 2.1, ES5 style, `'use strict'`, `VERSION = '1.0.0'` and
`@version 1.0.0`. No `log.warn`, `let`/`const`, arrow functions, template literals or
`Array.prototype.includes`. No numeric internal IDs. Nothing creates, edits or deletes an
Opportunity; nothing updates a Project; there is no user event script.

**Verification done here:** `npm test` (26 pass); `node --check` on every script; and an
off-repo harness with mocked `N/*` modules that ran the processor end to end: cases 1–4 and F,
D2(b) with two Tasks on a new Lead, the rerun of a completed Task (Project reused, "already
existed"), the UE not raising an Opportunity (fallback with the PROJ_UE message), a cleared
fallback parameter (ERROR, no Task touched), D8 (every Task save failing: logged, left in the
queue, processed once), and the 30-Task governance stop and resume. None of this replaces
Sandbox: every NetSuite field ID and value in it was mocked.

## Contradictions and defects found in the brief

1. **Branch.** The brief says `feat/enquiry-capture-v1`. The work is on
   `claude/fervent-dijkstra-kglmvu` and the PR is from it; amendment 1 accepted that branch in
   place of `feat/enquiry-capture-v1`.
2. **Test 11 cannot end with a linked Opportunity.** `project_ue.js` only raises the lead
   Opportunity on **create** (`if (isCreate)`, line 206, hint); an edit reconciles alternate
   customers only. So a Project saved while the Execution Context filter lacked Scheduled never
   gets its lead Opportunity from the UE, on a rerun (D4 never re-saves) or on a later edit.
   Accepted in amendment 1. Expected: the fallback gets the Task, with the result `Project <name>
   created (or found) but no Opportunity was raised: check the PROJ_UE execution log, then raise
   the Opportunity by hand`; a person raises the Opportunity by hand; a rerun changes nothing
   (the Task is no longer in the queue, and D4 would reuse the Project without saving it).
3. **D2(a) wording.** "A customer created *after* the Task, or more than 1 minute after it, is
   not new" reads both ways. Implemented as: up to 1 minute after the Task still passes (the
   timestamps are to the minute and can straddle a boundary); more than 1 minute after fails.
   Both are logged. Tighten to 0 in `parse.createdWithinWindow()` if that was the intent.
4. **D3 let free text on the Plans: line mean "no plans".** `Plans: see attached` with no
   numbered URL lines was "no plans" as briefed, so a template change of that shape would have
   completed new-lead Tasks (case 3). Amendment 1 tightened D3: only the literal `Plans: None`
   means no plans; anything else that isn't plan URLs is unparseable (`Plans line not
   understood: <line>`). See `docs/context.md` D3.
5. **`project_ue.js` lines 71–74** (hint) claim the write-back re-triggers the UE. Per C1 it
   does not; corrected in `docs/context.md`. The file is untouched.
6. **`gh pr create`** is not available here; the PR was opened through the GitHub API with
   this file as its body.

## Decisions made that the brief did not

- **Dates.** The Task's `createddate` is read with `search.lookupFields` (a search string), not
  from the loaded record, so it has the same precision and timezone as the customer's
  `datecreated` and the other Tasks' `createddate`; all three go through
  `config.parseDateTime()` (`format.parse`, DATETIME). The record's own value is logged beside
  it.
- **D2(b) tie-break.** Two website Tasks in the same minute: the lower internal ID is earlier.
  An unparseable date counts as earlier (existing: doubt goes to a person).
- **D2(b) search skipped** when (a) already fails, since it cannot make the customer new.
- **D2(b) filtered in code**, not with a `createddate` filter (the brief allowed either).
- **`Plans: None` followed by plan URLs** is unparseable (fallback), not either answer.
- **Header fields** (`GF entry:`, `Form:`, `Email:`, `Phone:`, `Project stage:`) are only read
  above the `Message:` line, so text typed into the Message can't supply a GF entry.
- **HTML:** a source newline directly after `<br>`, `</p>` or `</div>` is part of the same
  break (otherwise nl2br output doubles every line).
- **Config:** the fallback equal to the service employee throws (failed Tasks would stay in the
  queue forever); `custscript_enq_min_governance` negative or not whole throws.
- **Queue re-check on load:** a Task reassigned or completed by a person between the queue
  search and the load is skipped, not touched.
- **Case 1 with the service employee as the customer's sales rep** fails to the fallback
  (reassigning to it would leave the Task in the queue).
- **A failed success write** (reassign/complete in cases 1–4) goes to the fallback with the
  work already done in the message (e.g. "Project PR123 (456) created. …"); D8 applies only if
  that also fails.
- **D4:** the GF-entry search includes inactive Projects, uses the oldest match and logs the
  count; a match on a **different customer** throws (fallback) instead of being reused.
- **Task saves** use `{ enableSourcing: true, ignoreMandatoryFields: true }`.
- **`fail()` leaves the status alone** (the brief's table says Not Started, which is what the
  feed sets).
- **Helpers placed in existing files, no new files:** `flattenAddress`, `isWebsiteTitle`,
  `createdWithinWindow` and `isEarlierTask` are pure and live in `enq_lib_parse.js` so they are
  tested; `parseDateTime`, the log helpers and `selectValue` live in `enq_lib_config.js`.
- **Customer search:** if the `address` column returns one row per address book entry, the
  first row is used and the row count logged.
- **`createProjectForEntity`'s `cfg`** is accepted but unused in v1.
- **`package.json`** added so `npm test` works (`node --test`, no dependencies).
- **Queue page** of 1,000 IDs per search; the loop re-searches until nothing new.

## ⚠️ Still to verify in Sandbox

| Item | Where | How it shows |
|---|---|---|
| Task search fields `assigned`, `status`, `company`, `title`, `createddate` | `enq_lib_task.js` | `ENQ queue search` logs the first row raw |
| Task status value `COMPLETE` (search `noneof` and record `setValue`) | `enq_lib_task.js` | `status raw` in `ENQ task read` |
| `message` is the Notes field | `readTask` | `notes:` in `ENQ task read` |
| `transaction` is the Task's transaction field | `complete` | Task shows the Opportunity after case 2 |
| Does a scripted save to Completed fill `completeddate`? (not set by the script) | `complete` | `completeddate after save` in `ENQ task completed` |
| Customer search reaches Leads and Prospects via `search.Type.CUSTOMER` | `enq_lib_entity.js` | cases 3/4 on a new Lead |
| Customer column `address` (valid? one row or one per address?) | `readCustomer` | `rows:` and `address raw` in `ENQ customer read` |
| `datecreated` precision and timezone vs the Task's `createddate` | `readCustomer`, `readTask` | raw and ISO in `ENQ task … new/existing` |
| `custrecord_proj_gf_entry`, `custevent_enq_result` IDs as created | `enq_lib_config.js` | tests 2 and 1 |
| Reassigning a Task emails the new assignee? | `reassign` | tests 1 and 7 |
| `custrecord_proj_notes` takes 3,900 characters | `enq_lib_project.js` | a long Message |
| `customdeploy_project_ue` runs for the Scheduled context | Steve's checklist 3 | `PROJ_UE afterSubmit` line in test 2 |

## Sandbox tests

As in the brief (1–17). For test 11 expect item 2 under Contradictions: the fallback gets the
Task, a person raises the Opportunity by hand, and a rerun changes nothing.

## Reference file

`reference/project_ue.js` is unchanged: SHA-256
`7bca09330e702033d8d68529cc48aa4c235715704a70e103f5b96a1f34b8cb29`.
