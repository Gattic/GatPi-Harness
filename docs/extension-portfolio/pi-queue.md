# pi-queue

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Shared concurrency limit and durable history for DeepSeek requests from every harness machine
- **Unique trigger:** Every local model request; explicit queue inspection
- **Canonical surface:** local streamSimple wrapper plus pi_queue_status/pi_queue_list
- **Overlap decision:** No consumer processes: each requester waits for its own slot; Redis is the only queue service
- **Mutation class:** model request gating
- **Privacy class:** private host credentials; request metadata and token counts only, no prompts or responses
- **Success metric:** Requests beyond the limit wait in FIFO order and every request is recorded
- **Dependency readiness:** installed src/pi-queue client, private queue client configuration, Redis broker
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_QUEUE
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `pi_queue_list`: **keep**; canonical=local streamSimple wrapper plus pi_queue_status/pi_queue_list; trigger=Every local model request; explicit queue inspection; evidence=unique trigger documented and regression coverage retained
- `pi_queue_status`: **keep**; canonical=local streamSimple wrapper plus pi_queue_status/pi_queue_list; trigger=Every local model request; explicit queue inspection; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
