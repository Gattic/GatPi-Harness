# Copy this Pi/Hermes setup to another computer

Current status: this directory is portable. Project-local and repository extensions are loaded from this repo through Pi settings.

## What to copy

Copy the repo directory, including hidden project extensions:

```bash
rsync -a --exclude node_modules --exclude '.pi/cognitive-automation' --exclude '.pi/trace' --exclude '.pi/traces' \
  ~/GatPi-Harness/ user@new-host:~/GatPi-Harness/
```

Important source paths:

- `.pi/extensions/reasoning-runtime/index.ts`
- `.pi/extensions/trace-observability/index.ts`
- `extensions/hermes-advisory/index.ts`
- `src/`
- `scripts/`
- `docs/`
- `tests/`

Runtime state/cache is intentionally not copied by default.

## Bootstrap on the new computer

Install/configure the prerequisites first:

- `pi` CLI
- `hermes` CLI, if you want explicit typed advisory calls
- Node.js compatible with the installed Pi CLI

Then run:

```bash
cd ~/GatPi-Harness
scripts/bootstrap-new-machine.sh
```

That script delegates to `scripts/pi-harness-refresh.sh --extensions --skills --no-check`: it configures Pi's global settings to load the harness extension directories from source for every repo and refreshes the version-controlled skills under `~/.claude/skills` and `~/.agents/skills`.

```text
~/.pi/agent/settings.json extensions += [
  "<repo>/.pi/extensions",
  "<repo>/extensions",
  "-builtin:codemode"
]
```

The `-builtin:codemode` entry disables Pi's built-in CodeMode because `<repo>/extensions/codemode` registers the same `codemode` tool through the harness policy facade.

Project-local extensions are still auto-discovered when you launch Pi from this repo; Pi deduplicates the identical absolute paths.

## Validate

Quick setup validation:

```bash
scripts/check-project-setup.sh
```

Full validation through the unified entry point:

```bash
scripts/pi-harness-refresh.sh --check-only
```

## If using GitHub

This workspace currently needs to be initialized/pushed if you want `git clone` install flow:

```bash
git init
git add .
git commit -m "Add Pi/Hermes harness setup"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

On the new machine, replace the `rsync` step with:

```bash
git clone git@github.com:<owner>/<repo>.git ~/GatPi-Harness
cd ~/GatPi-Harness
scripts/bootstrap-new-machine.sh
```
