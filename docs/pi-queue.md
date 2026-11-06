# Pi request queue

Every DeepSeek request a harness Pi makes (provider `local`) first joins a shared
Redis queue. At most *limit* requests run at once across all machines; the rest
wait their turn in FIFO order. Every request is recorded so you can see who is
waiting, what is running and what happened.

There are **no worker or consumer processes**. Each Pi process queues its own
request, waits until it is within the limit, sends the request to DeepSeek
itself through Pi's built-in implementation of the provider's API, and then
records the outcome. Redis is the only queue service.

```
Pi (any machine) ── join queue ──> Redis (queue-host) ── "your turn" ──> Pi ── request ──> DeepSeek
                 <──────────────── records outcome ───────────────────
```

## What is queued and stored

- **Queued:** every request through the `local` provider: agent turns, tool
  follow-ups, retries, compaction summaries and extension model calls. Other
  providers (Anthropic, OpenAI) are not queued. Set `PI_QUEUE_PROVIDER` to queue
  a different provider name.
- **Stored per request:** ID (`r123`), state, machine hostname, process ID, Pi
  session ID, provider, model, enqueue/start/finish times, wait and run time,
  stop reason, token counts and a short error message. **Prompts and responses
  are never stored.**
- **States:** `waiting`, `running`, `completed`, `failed`, `cancelled` (aborted,
  for example with Esc), and `abandoned` (the requesting Pi stopped renewing its
  30-second lease, for example because it was killed; its slot is freed).
- **Retention:** finished records expire after 30 days, and at most 10,000 are
  kept. Redis persists with an append-only file (`appendfsync always`), so queue
  state and history survive broker restarts.

While a request waits, the interactive footer shows `queued r123: position N`.

## Behavior when the queue is unavailable

The queue fails closed: if the client is not installed, not configured, or Redis
is unreachable, the `local` request is **not** sent and Pi reports an error
naming the cause. Nothing silently bypasses the limit. To call DeepSeek directly,
start Pi with `PI_QUEUE=0` (or set it in the environment).

A machine without a `local` provider is not affected.
If the provider's models use more than one API, the extension cannot wrap all of
them; it reports that those requests are not queued instead of hiding the gap.

## Inspect and control

```bash
scripts/pi-queue status          # limit, running and waiting requests, totals
scripts/pi-queue status r123     # one request
scripts/pi-queue list            # recent requests, newest first
scripts/pi-queue list --state failed --limit 50
scripts/pi-queue limit           # show the concurrency limit
scripts/pi-queue limit 6         # change it for every machine, immediately
```

In Pi, the `pi_queue_status` and `pi_queue_list` tools and the `/queue-status`
command return the same data. The limit defaults to 4 until it is set. Changing
it takes effect for the next waiting request; running requests are not affected.

## Install on a machine

The normal harness refresh installs the pinned Redis client (`src/pi-queue/`,
ioredis only):

```bash
scripts/pi-harness-refresh.sh --extensions --no-check
# then restart Pi or /reload
```

A development worktree can install just the client with
`scripts/setup-pi-queue.sh` (and `--check`). Installing or loading the
extension never connects to Redis; the first queued request does.

Each machine also needs its own client credentials (step 2 below).

## Broker administration (on queue-host)

The broker is a TLS-only Redis container, `pi-queue-redis`, with client
certificates, a queue-only ACL user and persistent data in
`~/.local/state/pi-queue/redis`. These are explicit operator actions, never
extension actions:

1. **Once, for a new broker:** `node src/pi-queue/scripts/server.mjs init`, then
   `node src/pi-queue/scripts/server.mjs start`. `init` creates the CA, server
   certificate and passwords in `~/.config/pi-queue/` and refuses to run if they
   exist. **Never rerun `init` on a live broker.** `start` also restarts a
   stopped broker without touching its data.
2. **Per machine:** `node src/pi-queue/scripts/server.mjs issue-client NAME`
   creates `~/.config/pi-queue/clients/NAME/` (`ca.crt`, `NAME.crt`, `NAME.key`,
   `connection.env`). Copy those four files privately to the machine's
   `~/.config/pi-queue/clients/NAME/` (directory 700, files 600), change the three
   certificate paths in its `connection.env` to that location, and link it:
   `ln -s ~/.config/pi-queue/clients/NAME/connection.env ~/.config/pi-queue/client.env`.
   Never copy `ca.key`, `admin-password` or `server/`.

Client certificates are valid for 365 days. All clients share the queue ACL
password; rotating it means updating `users.acl` and every `connection.env`.

## Verification

```bash
node tests/pi-queue-adapter.test.js   # configuration, fail-closed behavior, no secret leakage
node tests/extension-load.test.js     # extension registration and the local wrapper
scripts/check-pi-queue.sh             # FIFO, limit, cancellation, lease recovery, persistence
PI_CHECK_QUEUE=1 scripts/check-all.sh # include the queue gate in the full gate
```

`scripts/check-pi-queue.sh` needs Docker and the pinned Redis image cached
locally. It creates and removes its own loopback-only container and never reads
production credentials.
