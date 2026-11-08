# Install and migrate Pi/Hermes environment

This guide bootstraps a new machine with Pi, Hermes, CodeGraph, Semgrep, and this repo's Pi extensions/configuration while avoiding local runtime state such as sessions, traces, caches, and durable memory databases.

The examples assume Linux/WSL and install this repo at `~/GatPi-Harness`. Adjust paths as needed.

## 1. Install base dependencies

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3 python3-venv python3-pip
```

Install Node.js. The linked Pi fork currently requires Node 22.19.0 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
```

## 2. Clone this repo

Using SSH:

```bash
git clone git@github.com:Gattic/GatPi-Harness.git ~/GatPi-Harness
cd ~/GatPi-Harness
```

Or using HTTPS:

```bash
git clone https://github.com/Gattic/GatPi-Harness.git ~/GatPi-Harness
cd ~/GatPi-Harness
```

If you have uncommitted local work on the old machine, commit/push it first. If you must copy a dirty tree directly, use the `rsync` example in [Copy this repo without local state](#copy-this-repo-without-local-state).

## 3. Install the linked Pi source fork

The normal runtime is built from the configured [`Gattic/GatPi`](https://github.com/Gattic/GatPi) source fork, not from a mutable published global package. On initial setup, run the unified wrapper without the full harness gate because Hermes and the optional adapters are installed in later steps:

```bash
cd ~/GatPi-Harness
scripts/pi-harness-refresh.sh --pi --no-check
pi --version
```

This clones or safely fast-forwards the configured sibling Pi checkout, installs pinned dependencies, builds committed sources, links the coding-agent package into the active user-writable npm prefix, and verifies the link. Routine later updates use `scripts/pi-harness-refresh.sh --pi`; use `--all` to refresh Pi, extensions, and skills together.

Portable dist patches under `patches/` are retained only as a legacy rollback path for machines that cannot build/link the source fork. See [`docs/pi-global-patches.md`](../docs/pi-global-patches.md) before using `scripts/apply-pi-global-patches.sh`; do not use `pi update` for the normal fork-backed workflow.

## 4. Install Hermes

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
hermes --version
hermes setup
hermes doctor
```

Current reference environment used Hermes Agent `v0.14.0`. Recreate credentials/settings with `hermes setup` rather than copying Hermes state databases.

## 5. Install CodeGraph

Install the CodeGraph CLI expected by this repo's adapter:

```bash
npm install -g @colbymchenry/codegraph
codegraph --version
```

Initialize/index this repo:

```bash
cd ~/GatPi-Harness
codegraph init -i
codegraph status
```

Inside Pi, verify with:

```text
/codegraph-doctor
/codegraph-sync --full
```

## 6. Install Semgrep

Preferred native install with `pipx`:

```bash
python3 -m pip install --user pipx
python3 -m pipx ensurepath
source ~/.bashrc
pipx install semgrep
semgrep --version
```

Alternative native install with `uv`:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
uv tool install semgrep
semgrep --version
```

Docker-wrapper alternative:

```bash
sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER"
newgrp docker

mkdir -p ~/.local/bin
cat > ~/.local/bin/semgrep <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
image="${SEMGREP_DOCKER_IMAGE:-semgrep/semgrep:latest}"
exec docker run --rm -v "$PWD:/src" -w /src "$image" semgrep "$@"
EOF
chmod +x ~/.local/bin/semgrep
semgrep --version
```

If the Docker wrapper reports permission errors, either fix Docker group membership or use the native install.

## 7. Install this repo's Pi package, extensions, and Agent Skills

Configure Pi to load this repo's extension directories, and refresh the cross-harness skill copies. The full gate is still deferred until all desired external adapters are installed:

```bash
cd ~/GatPi-Harness
scripts/pi-harness-refresh.sh --extensions --skills --no-check
scripts/check-project-setup.sh
```

The setup check uses extension slash-command smokes and should not require a Pi model login or API key. You still need `/login` or provider API keys before normal model-backed Pi prompts.

Multiple logins per provider and automatic account failover come from `extensions/multi-login` (see [configuration](configuration.md)).

It also updates `~/.pi/agent/settings.json` to load:

```text
~/GatPi-Harness/.pi/extensions
~/GatPi-Harness/extensions
```

Absolute extension paths from a previous harness checkout are removed during
the same update. Leaving both checkouts configured makes Pi load every tool
twice and report a conflict for each one on startup.

The same refresh installs the pinned Redis client for the Pi request queue
(`src/pi-queue/`). It does not create a broker, issue credentials or start
services. DeepSeek (`local`) requests are queued, so each machine needs its own
client credentials at `~/.config/pi-queue/client.env`; without them those
requests fail with an explicit error (`PI_QUEUE=0` calls DeepSeek directly). See
[Pi request queue](../docs/pi-queue.md) for issuing and installing credentials.

Restart Pi or run `/reload` in an existing Pi session.

## 8. Copy Pi config/settings, not local state

On the old machine, archive only portable Pi config:

```bash
mkdir -p ~/pi-migration

cd ~/.pi/agent
for p in settings.json models.json keybindings.json AGENTS.md SYSTEM.md APPEND_SYSTEM.md prompts skills themes; do
  [ -e "$p" ] && printf '%s\0' "$p"
done | tar --null -T - -czf ~/pi-migration/pi-agent-config.tgz
```

Optional external agent skill library:

```bash
[ -d ~/.agents/skills ] && tar -czf ~/pi-migration/agents-skills.tgz -C ~/.agents skills
```

Copy archives to the new machine:

```bash
scp ~/pi-migration/*.tgz newhost:~/pi-migration/
```

On the new machine:

```bash
mkdir -p ~/.pi/agent ~/.agents
tar -xzf ~/pi-migration/pi-agent-config.tgz -C ~/.pi/agent
[ -f ~/pi-migration/agents-skills.tgz ] && tar -xzf ~/pi-migration/agents-skills.tgz -C ~/.agents
```

Then rerun the unified resource refresh so absolute extension paths and skill copies match the new machine:

```bash
cd ~/GatPi-Harness
scripts/pi-harness-refresh.sh --extensions --skills --no-check
```

Do **not** copy Pi local state by default:

```text
~/.pi/agent/sessions/
~/.pi/agent/traces/
~/.pi/agent/traces-benchmark/
~/.pi/agent/extension-backups/
```

Do **not** copy `~/.pi/agent/auth.json` unless you intentionally want to transfer credentials. Prefer re-login:

```bash
pi
/login
```

or set provider API keys via environment variables.

## 9. Copy Hermes config, not Hermes state

On the old machine, review these files first because they may contain local paths or secrets:

```bash
mkdir -p ~/pi-migration

cd ~/.hermes
for p in config.yaml SOUL.md hooks skills; do
  [ -e "$p" ] && printf '%s\0' "$p"
done | tar --null -T - -czf ~/pi-migration/hermes-config.tgz
```

On the new machine:

```bash
mkdir -p ~/.hermes
tar -xzf ~/pi-migration/hermes-config.tgz -C ~/.hermes
```

Do **not** copy Hermes local state/secrets by default:

```text
~/.hermes/hermes-agent/      # reinstall instead
~/.hermes/state.db*
~/.hermes/kanban.db*
~/.hermes/sessions/
~/.hermes/memories/
~/.hermes/cache/
~/.hermes/audio_cache/
~/.hermes/image_cache/
~/.hermes/logs/
~/.hermes/sandboxes/
~/.hermes/auth.json
~/.hermes/.env
~/.hermes/gateway*.*
```

Recreate Hermes credentials/settings with:

```bash
hermes setup
hermes model
```

## Copy this repo without local state

If you cannot use a clean git clone because the old machine has uncommitted work, copy the repo while excluding runtime state:

```bash
rsync -a ~/GatPi-Harness/ newhost:~/GatPi-Harness/ \
  --exclude node_modules/ \
  --exclude .codegraph/ \
  --exclude .pi/ask/ \
  --exclude .pi/cognitive-automation/ \
  --exclude .pi/traces/ \
  --exclude .pi/goal-state/ \
  --exclude .pi/audit/ \
  --exclude .pi/evidence-binder/ \
  --exclude .pi/extension-ops/ \
  --exclude .pi/verification-center/ \
  --exclude .pi/runtime-doctor/ \
  --exclude .pi/performance-optimizer/ \
  --exclude .pi/privacy-guard/ \
  --exclude .pi/memory-explorer/ \
  --exclude .pi/memory-curator/ \
  --exclude .pi/session-stabilizer/ \
  --exclude .pi/test-gap-planner/ \
  --exclude .pi/project-profiler/ \
  --exclude .pi/policy-gate/ \
  --exclude .pi/policy-enforcer/ \
  --exclude .pi/ci-pr-companion/ \
  --exclude .pi/output-compactor/ \
  --exclude .pi/project-intelligence/ \
  --exclude .pi/runtime-cleanup/ \
  --exclude .pi/learning-loop/ \
  --exclude .pi/session-mining/ \
  --exclude .pi/automation-loop/ \
  --exclude .pi/codegraph/ \
  --exclude .pi/semgrep/
```

Keep these repo resources because they are source/config, not runtime state:

```text
.pi/extensions/
.pi/topologies/
extensions/
patches/
scripts/
docs/
```

## Final verification

```bash
node --version
npm --version
pi --version
hermes --version
codegraph --version
semgrep --version

cd ~/GatPi-Harness
scripts/check-project-setup.sh
# After Pi provider authentication is available, run the complete gate:
scripts/pi-harness-refresh.sh --check-only
```

Then in Pi:

```text
/reload
/hermes-status
/codegraph-doctor
/semgrep-doctor
/multi-login
```

If CodeGraph says uninitialized, run `codegraph init -i` in that repo. If Semgrep Docker fails, fix Docker permissions or install native Semgrep.

---

[Back to the README](../README.md) · [Wiki index](README.md)
