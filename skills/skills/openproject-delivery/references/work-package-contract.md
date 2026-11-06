# OpenProject work package contract

Use fields available on the connected OpenProject version, not invented schema IDs. Capture **project**, **type**, **title**, **owner**, **description**, **priority**, **dependency links**, **estimated effort / confidence**, **milestone**, **acceptance conditions**, **evidence links**, **status**, **risk/blocked reason**, and **reviewer**.

Statuses are claims, not wishes:

- **New:** work defined, not started.
- **In progress:** tangible work observed; owner recorded.
- **Blocked:** prerequisite cannot proceed; owner and unblock action recorded.
- **In review:** artifact produced but quality gate not passed.
- **Done:** required artifact inspected, checks passed and owner/reviewer recorded.

The actual OpenProject workflow may use different status labels: map these semantics to existing states without altering project configuration unless permitted.

When API write access is not available, produce a CSV/import contract or proposal only; never claim tickets have been created.
