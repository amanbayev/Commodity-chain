# External-system adapters

This package defines the only permitted boundaries to external systems and provides deterministic mock implementations for local development and tests. Domain packages must depend on these interfaces rather than transport clients.

The PostgreSQL EZR mock uses `pg` because receipt state, the monotonic source nonce and its HTTP outbox must commit atomically. It uses the Node.js Ed25519 and `fetch` implementations instead of adding cryptography or HTTP client dependencies.
