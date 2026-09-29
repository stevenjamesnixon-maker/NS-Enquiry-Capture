# Enquiry Capture — project context

Canonical reference for this project. If this document and the repository disagree, **the
repository wins**: read the file, then fix this document in the same PR.

Scope of this document: the SuiteScript in this repo and the NetSuite configuration it depends
on. It does not describe the wider NetSuite account.

**Last updated:** 29 Sep 2026
**Status:** v1.0.0 built on the PR branch, **not deployed**. Sandbox checks open: see
[`phase-1-implementation.md`](phase-1-implementation.md).

---

## 0. Read this first

1. **The trigger is a scheduled script, not a plug-in or a user event.** The 22 Sep
   Email Capture plug-in design is abandoned (it was blocked on the plug-in being
   SuiteScript 1.0 only). The website side already creates a customer and a Task per
   submission through the CRM Perks Gravity Forms feed; this project processes those Tasks.

2. **This repo never touches the Opportunity.** The Opportunity is raised by
   `customscript_project_ue` in its `afterSubmit` when a Project is created with
   `custrecord_proj_create_qr_pq` ticked. That script is owned by another project; a read-only
   copy is in `reference/`. Do not create, edit or delete Opportunities from here, and do not
   edit `reference/project_ue.js`.

3. **A Project is created once and never updated from here.** No `record.submitFields`, no
   inline edit. An xedit reaches `project_ue.js`'s market sync (lines 244–251, hint) with only
   the changed fields, reads the build type as blank, and blanks the market on every
   Opportunity (recon R1d).

4. **No numeric internal IDs in the repo.** Employees come in through script parameters. Script
   IDs (`custscript_*`, `custrecord_*`, `custevent_*`) may be committed.

5. **List and select values come back raw.** `search.lookupFields` returns `[]` for an empty
   select, never `[{ value: '' }]`. Never read `[0].value` unguarded (`config.selectValue()`).

## 1. What this solves

Website enquiries arrive as Tasks created by the CRM Perks Gravity Forms feed. Until now a
person has read each one, decided whether it needs a Project, keyed the Project, and passed the
Task on. This project does that for the unambiguous cases and puts everything else in front of a
person.

| # | Customer | Plans | Action | Task ends up |
|---|---|---|---|---|
| 1 | Existing | None | Nothing created | `assigned` = the customer's `salesrep`; status stays Not Started |
| 2 | Existing | Yes | Project → the project UE raises the Opportunity | `transaction` = the Opportunity; status Completed |
| 3 | New | None | Nothing created | Status Completed |
| 4 | New | Yes | As 2 | As 2 |
| F | Anything fails, can't be parsed, or has no rep in case 1 | — | Nothing more | `assigned` = the fallback employee; status unchanged (Not Started) |

In every case `custevent_enq_result` records what happened in one line. A Task leaves the queue
when it is Completed or reassigned. Nothing is retried forever, and nothing sits unseen.

## 2. Components and versions

| Component | Version | Purpose |
|---|---|---|
| `enq_ss_process_tasks.js` | 1.0.0 | scheduled script: queue loop and case dispatch only |
| `lib/enq_lib_config.js` | 1.0.0 | parameters, what empty means, audit key, field IDs, date parsing |
| `lib/enq_lib_parse.js` | 1.0.0 | pure functions: Notes parser, truncate, address flattening, the D2 date tests |
| `lib/enq_lib_entity.js` | 1.0.0 | customer read: datecreated, salesrep, display name, default address |
| `lib/enq_lib_task.js` | 1.0.0 | queue search, earlier-website-Task search, Task updates |
| `lib/enq_lib_project.js` | 1.0.0 | `createProjectForEntity(cfg, input)`: the only code that creates a Project |
| `test/parse.test.js` | — | node tests for `enq_lib_parse` (`npm test`) |

All under `src/FileCabinet/SuiteScripts/NuHeat/Enquiry Capture/`. The folder is `NuHeat`,
matching Online quote and Design Email; Steve confirms the File Cabinet casing before upload.

> Treat this table as indicative and read the files to confirm. It will drift. The JSDoc
> `@version` and the `VERSION` constant are kept in step in every script.

Not owned by this repo, but depended on:

| Component | Version | Owner | What we rely on |
|---|---|---|---|
| `customscript_project_ue` / `customdeploy_project_ue` | 2.0.2 | another project | raises the lead Opportunity on Project **create** when `custrecord_proj_create_qr_pq` is ticked, and writes its ID to `custrecord_proj_lead_opp` |
| CRM Perks Gravity Forms feed | — | website side | creates/matches the customer, creates the Task with the Notes template below, assigns it to the service employee |

### Parameters (on the scheduled script record)

| Parameter | Type | Empty means | Behaviour |
|---|---|---|---|
| `custscript_enq_service_employee` | List/Record → Employee | the queue can't be identified | **throw** |
| `custscript_enq_fallback_employee` | List/Record → Employee | failures would have nowhere to go | **throw**; also throws if it equals the service employee |
| `custscript_enq_new_window_min` | Integer | default 10 | values below 1 or above 120, or not whole: **throw** |
| `custscript_enq_min_governance` | Integer | default 500 | negative or not whole: **throw** |

`config.load()` throws one error naming every problem. The processor logs it at ERROR and exits
without touching any Task.

### Custom fields (constants in `enq_lib_config.js`; Steve creates both)

| Field | Record | Type |
|---|---|---|
| `custrecord_proj_gf_entry` | Project | Free-Form Text |
| `custevent_enq_result` | Task | Text Area (written truncated to 3,900 characters) |

### Entry point for other callers

`lib/enq_lib_project.js` → `createProjectForEntity(cfg, input)`:

```
input:  { entityId, title, siteAddress, notes, gfEntry }
result: { projectId, projectName, leadOppId|null, reused: bool }
```

It is the entry point for the later "customer: new project" work (P9). It knows nothing about
Tasks, email or parsing, throws before touching anything when `entityId` or `gfEntry` is empty,
reuses a Project already carrying the GF entry (D4), and throws if that Project belongs to a
different customer. No other caller exists yet.

## 3. Environments

| Setting | Value |
|---|---|
| Account | 472052, **not OneWorld**. No `subsidiary` anywhere |
| File Cabinet folder | `SuiteScripts/NuHeat/Enquiry Capture/` (Steve creates it and `lib/`) |
| Account-specific values | script parameters only, set per environment by hand |

The repo is environment-agnostic. Sandbox and Production each carry their own parameter values.

## 4. Architecture

```
website form ──► CRM Perks feed ──► customer (created or matched) + Task assigned to the service employee
                                                  │
customdeploy_enq_ss_process_tasks (every 15 min) ─┘
   │ searchQueue: open Tasks assigned to the service employee, oldest first
   │ per Task:
   │   readTask ─ title must start "Website form submission", company must be set
   │   parseNotes ─ GF entry and Plans: lines required (D3)
   │   readCustomer ─ datecreated, salesrep, display name, default address
   │   new/existing (D2)
   │   no plans: reassign to the rep (1) or complete (3)
   │   plans:    createProjectForEntity() ─ D4 search, else record.create + save
   │                 └──► customscript_project_ue afterSubmit raises the Opportunity and
   │                      writes it to custrecord_proj_lead_opp (inside our save)
   │             re-read custrecord_proj_lead_opp ─ complete with transaction (2, 4)
   │   anything else: reassign to the fallback, result "ERROR: …" (F)
   │ search again until nothing new or governance is low
```

### The Notes template (C11; owned by the website side)

```
GF entry: 320422
Form: …

Email: …
Phone: …
Project stage: … |
Message: …

Plans:
1. https://…
2. https://…
```

or the single line `Plans: None`. The parser normalises `\r\n`/`\r`, turns HTML (`<br>`, `</p>`,
`</div>`) into lines and decodes entities (`&amp;` last), and trims every line.

### Confirmed facts this design rests on

- **C1.** User event scripts are not triggered by other user event scripts. Scheduled script
  saves do trigger them.
- **C2.** `project_ue.js` gates only its `redirect` on the UI context. A Project saved by a
  scheduled script raises the Opportunity **if** `customdeploy_project_ue`'s Execution Context
  filter includes Scheduled.
- **C3.** `custrecord_proj_lead_opp` is written by `submitFields` inside the UE's `afterSubmit`,
  synchronously within the caller's `save()`. Re-read with `search.lookupFields`. Blank means
  no Opportunity or a failed write-back; the PROJ_UE log says which.
- **C4.** Blank build type and address don't break the save (`ignoreMandatoryFields: true`). The
  Opportunity's market and site address arrive blank; the rep sets the build type on the Project
  later and the UE's market sync carries it across.
- **C5.** A scheduled script runs as Administrator; `runtime.getCurrentUser()` is a system
  identity.
- **C6–C8.** A new Lead's `salesrep` is set at creation by SFA; the Project sources
  `custrecord_proj_sales_rep` from the customer. The Account Manager is the standard `salesrep`.
  Project title = `<customer name> new project`; site address = the customer's default address,
  else the title.
- **C9.** No notification in cases 2 and 4.
- **C10.** The plugin can create Individuals; the display name handles both kinds.
- **Project record** `customrecord_project` is auto-numbered `PR#####` with Include Name, so
  `name` is the number and `altname` the title. Field-level mandatory:
  `custrecord_proj_customer` and `custrecord_proj_address`.

## 5. Standing warnings and deliberate decisions

These will look wrong to a fresh reader. Do not reverse them.

- **D1. No Task user event in v1.** One scheduled deployment every 15 minutes is the only
  trigger. A queuing user event would add an "already queued" race, a second deployment able to
  run alongside the first, and a dependency on the plugin's web-services context. NetSuite never
  runs one deployment twice at once, so no two runs process the same Task. Up to 15 minutes'
  delay is accepted.
- **D2. Doubt goes to a person.** A customer is **new** only when both hold:
  (a) its `datecreated` is no more than `custscript_enq_new_window_min` minutes before the Task's
  `createddate` (a customer created up to 1 minute *after* the Task still passes, because the
  timestamps are to the minute; later than that is not new and is logged); and
  (b) no **other** Task on that company with a title starting `Website form submission` has an
  earlier `createddate` (same minute: the lower internal ID is earlier).
  Everything else is **existing**. Wrongly "new" silently completes a real customer's enquiry;
  wrongly "existing" only puts an open Task in front of the rep.
- **D3. The plans line decides, and only an unambiguous line counts.** No plans: `Plans: None`,
  or `Plans:` followed by no numbered URL line. Plans: a line matching `^\d+\.\s*https?://\S+$`
  after the **last** `Plans:` line, or a URL on the `Plans:` line itself. **Unparseable** (to the
  fallback, never Completed): no `GF entry:` line, no `Plans:` line, `Plans: None` followed by
  plan URLs, a title not starting `Website form submission`, an empty company.
- **D4. Idempotency is by GF entry.** Before creating a Project, search `customrecord_project`
  for `custrecord_proj_gf_entry` = the entry (inactive Projects included). A match is used as it
  is: nothing is created or saved. A match on a different customer throws (to the fallback).
- **D5. Plans stay as links.** The Project's notes hold the Task's full normalised notes, plan
  URLs included. No file download.
- **D6. The site address is truncated to 300 characters** (logged): the Opportunity's
  `custbody_opp_site_adress` may be Free-Form Text.
- **D7. The Task is updated last**, after the Project exists and its Opportunity has been read,
  so a crash leaves the Task in the queue; D4 makes the rerun safe.
- **D8. If the Task update itself fails,** `ENQ task update failed` is logged at ERROR with the
  Task ID and the run moves on. The Task stays in the queue and the next run retries it. This is
  the only automatic retry, and it only repeats the Task write. A failed *success* write (cases
  1–4) is first redirected to the fallback with what was done so far; only if that also fails
  does D8 apply.
- **Dates are compared as search strings.** The customer's `datecreated`, the Task's
  `createddate` and other Tasks' `createddate` are all read as search-formatted strings and
  parsed with `N/format`, so they share precision and timezone.
- **A Task no longer in the queue when loaded** (reassigned or completed by a person since the
  search) is skipped, not touched.
- **A customer whose sales rep is the service employee** fails to the fallback, rather than
  being "reassigned" back into the queue.
- **Task saves use `ignoreMandatoryFields: true`,** so a form-mandatory field the feed left blank
  cannot keep a Task in the queue.
- **Misspelled field IDs in `project_ue.js` are real** (`custbody_opp_site_adress`,
  `custbodycustbody_opp_max_status`). Never "correct" them.

### Notes on `reference/project_ue.js` (owned elsewhere; never modified here)

- It is `@NApiVersion 2.x`, not 2.1, and hardcodes internal IDs for the quote types, the Sales
  department and the New / Existing / Returning values. That is the owning project's business;
  this repo copies none of those values.
- **Correction to its own comment at lines 71–74 (hint):** the lead-Opportunity write-back
  uses `record.submitFields` from inside the UE, and a user event does **not** re-trigger user
  events (C1). The "re-triggers this script as an 'edit'" note in the file is wrong; the pass it
  describes never happens. The file itself stays untouched.
- **The lead Opportunity is only raised on create** (`if (isCreate)`, line 206, hint). A later
  edit with *Auto Create* ticked reconciles alternate customers only; it never raises a missing
  lead Opportunity. A Project created without one (e.g. the Execution Context filter lacked
  Scheduled) needs its Opportunity raised by hand.
- `nerCalc()` looks up `lastsaledate` with `record.Type.CUSTOMER`. A Lead has no last sale, and
  any lookup failure is caught, so a new Lead resolves to New either way.
- The Opportunity is saved with `ignoreMandatoryFields: true`, and no `salesrep` is set, so it
  sources from the entity. `redirect` is guarded to the UI context.
- The Project title (`altname`) is copied to the Opportunity's `custbody_quote_email_ref`.
- `getSalesRep()` is defined and never called, and the comment on `opportunityCustomers()` says
  "used only by the oldRecord fallback" when it is called on every reconcile. Both cosmetic.
  Report them to the owning project if convenient.

## 6. Known issues and limitations

- **Unverified field IDs and values (⚠️, Sandbox):** Task search/record fields `assigned`,
  `status`, `company`, `title`, `createddate`, `message`, `transaction`, `completeddate`; the
  status value `COMPLETE`; the customer search column `address` (and whether it returns one row
  per address); `datecreated` precision and timezone. Every one is logged raw at audit.
- **`completeddate`** is not set by the script. `complete()` logs its value after the save; if a
  scripted save leaves it blank, decide whether it matters.
- **Reassigning a Task may email the new assignee** if the feed ticks the Task's notify option.
  Not suppressed; check in Sandbox.
- **A Plans: line with free text** (`Plans: see attached`) and no numbered URLs counts as no
  plans (D3 as briefed). A template change of that shape would complete new-lead Tasks (case 3).
  The plans line is logged for every Task.
- **Queue page size 1,000.** Far above what one run's governance allows (~80 units per Task).

## 7. Audit log keys

| Key | Meaning | What to do if it fires |
|---|---|---|
| `ENQ` | every line written by this project's scripts starts `ENQ ` | grep the scheduled script's execution log; each create and Task update logs its record IDs |
| `ENQ config invalid` (ERROR) | a parameter is missing or invalid; no Task touched | fix the parameter named |
| `ENQ task update failed` (ERROR) | D8: a Task write failed twice; it stays in the queue | read the error; the next run retries |
| `PROJ_UE` | written by `customscript_project_ue` (not this repo) | read when a Task's result says no Opportunity was raised |

The scheduled deployment logs at **Audit**. A missing permission can show up as an empty result
rather than an error, so the IDs in the audit lines are the evidence.

## 8. Deployment sequence

1. Steve creates `SuiteScripts/NuHeat/Enquiry Capture/` and `lib/` inside it (confirm casing).
2. Upload `lib/` first, in this order: config, parse, entity, task, project.
3. Then upload `enq_ss_process_tasks.js` and create the scheduled script record with the four
   parameters.
4. **One** deployment, `customdeploy_enq_ss_process_tasks`, repeating every 15 minutes, log
   level **Audit**.

### Steve's checklist

1. Create the employee "Enquiry Automation" (no login access).
2. Create `custrecord_proj_gf_entry` and `custevent_enq_result`, and add them to the Project and
   Task forms.
3. On `customdeploy_project_ue`, make the Execution Context filter include **Scheduled**, and set
   its log level from Error to Audit.
4. Set the parameter values.
5. Test in Sandbox with the service account set on test Tasks **by hand**.
6. **Only then** change the CRM Perks feed's Assigned To to the service account in Production.
