# Instrument module

Owns instrument definitions, lifecycle state, and mint eligibility. Mint locks the instrument row,
derives verified collateral only from the collateral ledger, and posts through `packages/ledger`
using the same PostgreSQL transaction as the circulating-supply, audit, and outbox updates.

Each instrument must be configured with a credit-normal TOKEN distribution account (`AVAILABLE`)
and a debit-normal balancing issuance account (`RESIDUAL`). The residual balance is excluded from
circulating-supply reconciliation because it is the double-entry contra leg.
