# Settlement

This module executes gross T+0 delivery-versus-payment inside the Commodity Chain double-entry
ledger. It has no public HTTP API. `SettlementCreatedConsumer` receives the idempotent
`domain.settlement.created.v1` outbox envelope emitted by OMS.

OMS has already moved the buyer cash commitment and seller token commitment into the instrument's
clearing `RESERVED` accounts. Funding verifies both commitments without moving value. DvP then
uses one database transaction and one `packages/ledger` posting containing independently balanced
cash and token denominations. A failure at any point rolls back every leg.

The commit that contains the ledger posting and the transitions through `TECHNICALLY_CONFIRMED`
to `LEGALLY_FINAL` is the legal finality point for the internal trust perimeter. No code or direct
SQL operation may return a legally final settlement to a pre-final status; a PostgreSQL trigger
enforces the same transition matrix. When an external bank is connected, this boundary will become
an orchestrated saga and `TECHNICALLY_CONFIRMED` will no longer imply immediate legal finality.

## Integer rounding

All calculations use `bigint` minor units. For a fee rate in parts per million, the whole part of
`notional * rate / 1_000_000` goes to the exchange `FEE` account. If a fractional tail exists, one
minor unit from the ceiling already reserved by OMS goes to the `RESIDUAL` account. Banker's
rounding and floating-point arithmetic are forbidden.

## Reconciliation

`pnpm reconcile:settlements` verifies that every trade has one settlement, that each legally final
settlement has exactly one immutable DvP posting, and that gross cash, token, fee, and residual legs
match the recorded trade. Clean settlements move to `RECONCILED`; discrepancies move to
`PENDING_RECONCILIATION`, append an `INCIDENT`, and make the command exit with status 1.
