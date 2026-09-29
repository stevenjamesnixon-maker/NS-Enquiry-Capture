# reference/ — read-only copies, do not edit

## What these are

One JavaScript file copied out of the NetSuite File Cabinet from a **different
project in the same account**:

- `project_ue.js` — `customscript_project_ue`, the User Event on the Project custom
  record `customrecord_project` (deployment `customdeploy_project_ue`), **v2.0.2**.

It is here so the Enquiry Capture work can be planned and reviewed against what the
account actually does when a Project is saved, rather than against a description of
it.

## Integrity

Committed byte-identical to the copy Steve supplied on 29 Sep 2026.

| File | Bytes | SHA-256 |
|---|---|---|
| `project_ue.js` | 30,780 | `7bca09330e702033d8d68529cc48aa4c235715704a70e103f5b96a1f34b8cb29` |

The file has **CRLF line endings and no final newline**. That is how it arrived, and
it stays that way: `.gitattributes` marks `reference/*.js` as `-text` so git never
normalises it, and editors must not "fix" it on save. Check it with:

```bash
sha256sum reference/project_ue.js
```

## Why it is committed

Reconnaissance and review only. The capture plug-in depends on one behaviour of this
script: a Project created with `custrecord_proj_create_qr_pq` ticked makes its
`afterSubmit` raise the lead Opportunity and write the Opportunity's ID back to
`custrecord_proj_lead_opp`. Having the source next to the notes makes that dependency
checkable.

It is **evidence, not code this repository owns.** Nothing here is deployed from
this repository, and nothing here is on this project's maintenance path.

## It must never be edited from this repository

The live version is in the NetSuite File Cabinet and is maintained by the project
that owns `customscript_project_ue`. Editing this copy **changes nothing in
NetSuite** — the account never sees it — while quietly creating a second, divergent
source of truth for someone to be misled by later.

So: no reformatting, no linting, no tidying, and no fixing defects, including ones
that are plainly defects — its `@NApiVersion 2.x`, its hardcoded internal IDs
(quote types, department, New/Existing/Returning values) and its line endings
included. If something in here looks wrong, note it in `docs/context.md` and raise it
with the owning project. If a newer version is needed, replace the file wholesale
from the File Cabinet, update the table above, and say so in the commit message.
