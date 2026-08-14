# Instrument module

Owns instrument definitions, lifecycle state, and mint eligibility. Mint locks the instrument row,
derives verified collateral only from the collateral ledger, and posts through `packages/ledger`
using the same PostgreSQL transaction as the circulating-supply, audit, and outbox updates.

The listing aggregate follows the forward-only lifecycle `DRAFT -> UNDER_REVIEW -> APPROVED ->
COLLATERALIZED -> PRIMARY -> ACTIVE`. Suspension remembers and restores the prior lifecycle state.
Passport review is versioned independently: a returned passport creates a new draft version while
the aggregate remains `UNDER_REVIEW`; approval requires decisions from two distinct operators.
Only the internal collateral outbox consumer may promote `APPROVED` to `COLLATERALIZED`.

Each instrument must be configured with a credit-normal TOKEN distribution account (`AVAILABLE`)
and a debit-normal balancing issuance account (`RESIDUAL`). The residual balance is excluded from
circulating-supply reconciliation because it is the double-entry contra leg.
