# Ledger

This package owns the PostgreSQL double-entry ledger API and its invariants. It has no NestJS dependency. All ledger mutations must pass through this package; direct SQL writes to ledger records are prohibited.

Postings lock affected account rows in stable UUID order with SELECT FOR UPDATE. This ties concurrency control directly to the balances being checked and prevents deadlocks between postings that touch the same accounts in different input orders.

Amounts are bigint at the TypeScript boundary and numeric(38,0) in PostgreSQL. A posting is immutable, balances independently by denomination, and can be corrected only through a compensating reversal.

Integration and property tests require TEST_DATABASE_URL pointing to a migrated PostgreSQL 16 database. CI provisions the database automatically.
