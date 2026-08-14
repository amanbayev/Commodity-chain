# Matching process

Thin autonomous process boundary around `@commodity-chain/matching-core`. Transport integration
belongs to a later adapter layer; the deterministic domain remains independent of HTTP, NestJS,
PostgreSQL, and NATS.

Each engine instance owns one instrument book. New PLACE and CANCEL commands receive a monotonic
exchange sequence; client timestamps are not accepted and cannot influence priority. LIMIT orders
match by price and then acceptance sequence, with execution at the resting order price.

Money and quantity values are bigint minor units. Every event carries a deterministic `eventId`
and monotonic bigint `nonce`. Replaying the ordered event log reconstructs orders, idempotency
indexes, command results, and the book.

The fixed-seed determinism and invariant workload lives with the shared matching-core package.
