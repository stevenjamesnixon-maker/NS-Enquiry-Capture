# NS Enquiry Capture

NetSuite website Task processor for Nu-Heat (account 472052). The CRM Perks Gravity
Forms feed already creates (or matches) a customer and a Task for every website
submission, assigned to a service-account employee. A scheduled script works through
those Tasks every 15 minutes: when the enquiry has plans it creates a Project against
the customer, otherwise it closes the Task or hands it to the account manager. Anything
it cannot decide goes to a fallback employee.

This repo covers the first half of the enquiry pipeline only. The second half already
exists: saving a Project with *Auto Create QRs and Prequotes* ticked makes
`customscript_project_ue` raise the lead Opportunity. This repo never creates, edits
or deletes Opportunities, and never updates a Project after creating it.

## Canonical reference

**[`docs/context.md`](docs/context.md) is the single source of truth for this
project.** Read it before changing anything.

## Layout

```
src/FileCabinet/SuiteScripts/NuHeat/Enquiry Capture/   the scheduled script and its lib/ modules (File Cabinet path is identical)
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
- `npm test` runs the node tests for the pure parsing module (no dependencies).
