# NS Enquiry Capture

NetSuite Email Capture plug-in for Nu-Heat (account 472052). An enquiry emailed to
one inbound capture address becomes a Lead (or is matched to an existing entity), a
Project against it, and a Message on its Communication tab. Then someone is told what
happened.

This repo covers the first half of the enquiry pipeline only. The second half already
exists: saving a Project with *Auto Create QRs and Prequotes* ticked makes
`customscript_project_ue` raise the lead Opportunity. This repo never creates, edits
or deletes Opportunities.

## Canonical reference

**[`docs/context.md`](docs/context.md) is the single source of truth for this
project.** Read it before changing anything.

## Layout

```
src/FileCabinet/SuiteScripts/Nuheat/Enquiry Capture/   the plug-in and its lib/ modules (File Cabinet path is identical)
reference/                                            read-only copies of scripts owned elsewhere — never edit
docs/                                                 context document and phase notes
test/                                                 node tests for the pure parsing module
```

## Rules

- Nothing is merged or deployed by an implementer. Steve tests in Sandbox, merges and
  deploys.
- No numeric internal IDs are committed. Script IDs (`custscript_*`, `custentity_*`,
  `customrecord_*`) may be; everything account-specific comes in through script
  parameters.
- `reference/` is read-only. See [`reference/README.md`](reference/README.md).
