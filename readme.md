## Architecture rationale

The orchestrator implements a synchronous saga-style checkout flow in strict order:

1. payment authorize
2. inventory reserve
3. shipping create
4. notification send

Key implementation decisions:

- Sequential orchestration only, without parallel downstream calls
- Per-request idempotency using `Idempotency-Key`
- Restart-safe persistence via JSON files:
  - `/data/idempotency-store.json`
  - `/data/saga-store.json`
- Timeout-aware downstream invocation using Axios timeout
- Timeout-triggered flows return HTTP `504` with code `timeout`
- Compensation rules:
  - inventory failure -> payment refund
  - shipping failure/timeout -> inventory release + payment refund
  - notification failure/timeout -> inventory release + payment refund
- Deterministic replay for same key + same payload
- `409 idempotency_payload_mismatch` for same key + different payload
- `409 idempotency_conflict` for same key while in progress
- Trace captures execution order and timing for forward and compensation steps

## AI usage note

AI assistance was used for implementation guidance, debugging, and refinement of orchestration logic.
All final code changes were reviewed, understood, and validated by running the provided public test suite locally.