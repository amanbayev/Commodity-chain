# Redemption module

This module implements physical-delivery redemption. `POST /v1/redemptions` atomically
reserves the holder's TOKEN balance and persists an idempotent redemption. Delivery is
started by `RedemptionTokensLockedConsumer`, which talks to the elevator only through the
`EzrRegistry` adapter and calls `releaseReceipt`.

Token burn is deliberately separated from the delivery request. Only an oracle event that
has reached `APPLIED`, has type `GOODS_RELEASED`, and carries the matching `redemptionId`,
asset, instrument and underlying quantity can trigger the atomic completion transaction.
That transaction burns RESERVED holder tokens against the instrument distribution account,
decrements `circulating_supply`, releases collateral through `packages/ledger` and the
collateral ledger, and writes `event_log` plus outbox records. A mismatch quarantines the
redemption without burning anything.

The state machine is `CREATED -> TOKENS_LOCKED -> IN_DELIVERY -> COMPLETED`, with terminal
alternatives `CANCELLED`, `EXCEPTION`, and `QUARANTINED`. PostgreSQL enforces the same graph,
so `COMPLETED` cannot move backwards. The timeout processor keeps tokens RESERVED when the
seven-day delivery window expires; legal/manual resolution is required and no automatic
burn or unlock occurs.

The mock EZR adapter releases complete receipts. Therefore the MVP delivery allocator uses
one locked receipt whose underlying quantity exactly equals `token quantity * unitPerToken`.
Splitting or aggregating receipts is intentionally deferred until the real registry contract
defines partial-release semantics.
