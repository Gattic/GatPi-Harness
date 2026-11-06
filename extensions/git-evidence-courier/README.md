# git-evidence-courier

Generic Pi extension for evidence-backed git workflows.

## Slash commands

- `/git:evidence` — reports repository root, branch/upstream, local and remote SHA, clean-tree status, diff stats, last commit, and inferred verifier commands.
- `/git:verify [command && command]` — runs explicit shell commands, or inferred verifier commands when no arguments are supplied. Always includes `git diff --check` and `git diff --cached --check` in inferred mode. Inferred verification of a Prisma/PostgreSQL repository provisions a disposable isolated PostgreSQL container automatically.
- `/git:publish [--verify] [remote] [branch]` — refuses to push a dirty tree, optionally runs inferred verification, checks that the remote branch is an ancestor of local `HEAD`, requires explicit interactive user confirmation, pushes `HEAD:<branch>`, confirms the remote SHA matches local `HEAD`, and reports post-push clean-tree status.

## Model-callable tools

- `gitevidence` — read-only tool for agents to collect branch/upstream, local/remote SHA, clean-tree, diff, and verifier-hint evidence.
- `gitverify` — agent-callable verification tool that runs inferred verification. For Prisma/PostgreSQL repositories it provisions a disposable loopback-only PostgreSQL container and overrides `TEST_DATABASE_URL`, `DATABASE_URL`, and `DIRECT_DATABASE_URL` for every verifier command. It does not accept arbitrary shell commands and never pushes.

There is intentionally no model-callable publish tool. Publishing remains behind `/git:publish` and an interactive confirmation prompt. Explicit custom verification commands remain available only through the manual slash command `/git:verify <command && command>`.

## Inferred verifiers

The extension chooses a generic verifier profile from repository files:

- `lakefile.lean` / `lakefile.toml` → `lake build`
- `Cargo.toml` → `cargo test`
- `go.mod` → `go test ./...`
- `pyproject.toml` / `pytest.ini` → `pytest`
- `package.json` → `npm run lint --if-present`, `npm run typecheck --if-present`, `npm test --if-present`

When inferred verification detects `provider = "postgresql"` in `prisma/schema.prisma`, it creates a uniquely named, `pi.gitverify=isolated`-labelled local disk-backed data volume and starts a pinned PostgreSQL 16 container with a random credential, resource limits, and an automatically assigned loopback-only port. PostgreSQL data and migration temporary files share this disposable volume rather than a bounded RAM filesystem. The same isolated URL is injected as `TEST_DATABASE_URL`, `DATABASE_URL`, and `DIRECT_DATABASE_URL`. Cleanup verifies each resource's ownership label, removes the container and volume, and confirms both are absent. `docker stop` returns before Docker finishes auto-removing the `--rm` container, so container absence is re-checked every 250 ms for up to 10 seconds; a container still present after that fails cleanup, and its volume is not removed. Failed or interrupted provisioning still cleans any allocated volume, including when its container is already gone. Provisioning or cleanup failures fail verification closed. Explicit `/git:verify <commands>` invocations remain user-controlled and do not add infrastructure automatically.

## Safety

A command succeeds only with exit code zero and `killed=false`. Interrupted verifiers fail the run, stop subsequent commands, and still attempt ownership-checked cleanup. Interrupted discovery, required Git-state checks, or database setup/cleanup cannot establish successful verification. A missing exit status is never treated as zero. Each verifier command has a 120-minute deadline, sized for a full Prisma suite measured at 73 minutes; a command that reaches it is killed and fails verification.

Isolated verification uses only a uniquely named `docker run` or `podman run` container; it never invokes repository Compose services. Reports include runtime, container name, loopback port, and cleanup status but never the generated credential. `/git:publish` does not force push and does not publish with uncommitted changes. It also refuses to push in non-interactive contexts because it requires explicit user confirmation before running `git push`. After a confirmed push, it compares local and remote SHAs and reports whether the working tree is still clean.
