# Matching process

Standalone deterministic, single-threaded, event-sourced matching sequencer. It is plain
TypeScript with no HTTP, NestJS, database, or external-system dependency. NATS integration belongs
to a later adapter layer.

Each engine instance owns one instrument book. New PLACE and CANCEL commands receive a monotonic
exchange sequence; client timestamps are not accepted and cannot influence priority. LIMIT orders
match by price and then acceptance sequence, with execution at the resting order price.

Money and quantity values are bigint minor units. Every event carries a deterministic `eventId`
and monotonic bigint `nonce`. Replaying the ordered event log reconstructs orders, idempotency
indexes, command results, and the book.

`fast-check` is test-only and generates the fixed-seed 10,000-command determinism and invariant
workload. It is not part of the runtime package.
