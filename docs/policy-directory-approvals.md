# Directory write approvals

Use `/policy-approve-directory <directory>` **inside Pi** to permanently allow the current project to write into another directory and its descendants. The destination must already exist and be a directory. Absolute paths, `~/` paths, relative paths, and a single quoted path are supported. These are Pi slash commands, not shell commands.

After updating the harness, restart existing Pi processes so both the extension and its policy library are freshly loaded. Newly started processes use the updated implementation.

## Two explicit pairs

Start Pi with its working directory set to `~/dev/ExampleGame/`, then run:

```text
/policy-approve-directory ~/dev/ExampleUniverse/
/policy-approve-directory ~/dev/ExamplePal/
```

Start Pi in `~/dev/ExampleUniverse/`, then run:

```text
/policy-approve-directory ~/dev/ExampleGame/
```

Start Pi in `~/dev/ExamplePal/`, then run:

```text
/policy-approve-directory ~/dev/ExampleGame/
```

This creates ExampleGame → ExampleUniverse, ExampleUniverse → ExampleGame, ExampleGame → ExamplePal, and ExamplePal → ExampleGame. It grants **neither** ExampleUniverse → ExamplePal nor ExamplePal → ExampleUniverse. There is no implicit reverse or transitive approval.

## Persistence and revocation

- Grants are permanent (`expiresAt: null`), with no TTL flag needed.
- State is stored in the **source project's** `.pi/policy-enforcer/approvals.json` and takes effect on the next tool call, including in other sessions at that working directory.
- Each grant records the canonical source working directory and destination directory. Copying the state file to another project does not transfer directory authority. Starting Pi in a subdirectory is a different source scope.
- Repeating the same grant updates it rather than adding a duplicate.
- `/policy-approvals` lists grants and their `approval_…` keys. Revoke a grant from its source project with `/policy-revoke <approval_key>`; no restart is needed.
- `/policy-enforcer-status` shows the mode, approvals, and state-file location. The model's `policy_enforcer` check operation also accounts for grants. Advisory `policy_gate` checks report raw policy findings without applying approvals.

## Scope and protections

Directory grants waive only the `outside-repo-write` denial for structured write/edit path requests extracted by the enforcer, including built-in `write` and `edit`. Existing files, new files, and new nested directories beneath the destination are covered. Exact-request approvals remain separate; approving a directory's path with the older `/policy-approve` command does not make that approval recursive.

Matching resolves symlinks, including the existing ancestors of new files. Parent traversal, similarly named siblings, links escaping the destination, dangling links, and unresolvable paths do not acquire authority. Replacing a stored canonical root with a symlink cannot redirect its grant. Protected path prefixes are checked against both the requested and resolved paths, and project policy changes remain effective after approval.

The command does **not** disable enforcement, approve dangerous shell commands or package-install warnings, or approve arbitrary paths outside the granted destinations. It is not an OS filesystem sandbox and does not inspect arbitrary shell-script side effects or prevent concurrent filesystem changes after preflight. Prefer structured `write`/`edit` calls for cross-project edits.

Directory authority is created explicitly through the user-facing slash command; the model's ordinary `approve` operation cannot create directory grants.

## Harness project scope

An active directory grant also puts the destination in the **session project scope**, so harness tools treat it as a working project instead of an unrelated path. Scope is read-only for state; writes still go through the policy enforcer's directory grant:

- `project_scope` (`list`, `state`, `logs`, `read`) reads the destination's `.pi` inventory, bounded diagnostic log tails, and bounded state files.
- `test_runner`, `code_context`, `docs_lookup`, `ast_search`/`ast_refactor`, `lsp`, `codegraph`, and `semgrep` accept project paths inside the destination and keep their state under that project's own `.pi`.
- `memory_explorer`/`memory_curator` accept `path` and use the destination's project identity, `.pi` state, and canonical vault notes.

Revoking the grant removes the scope root again. Grants stay directional and non-transitive, so a grant to ExampleUniverse does not add ExampleUniverse's own grants to this session's scope. `PI_HARNESS_PROJECT_DIRS` declares scope roots for state and log reads without granting write authority; see [Configuration, privacy, and runtime policy](../wiki/configuration.md#second-project-directories).
