# OMS module

Accepts order commands, reserves assets through `@commodity-chain/ledger`, runs the deterministic
matching core, persists matching events, and creates trade and settlement obligations atomically.

One in-memory queue and one PostgreSQL transaction advisory lock serialize commands per instrument.
The persisted `matching_events` stream remains authoritative; a transaction-local engine is rebuilt
by replay before every command, so a rollback cannot advance the live book.

BUY reserves use the order's immutable fee-schedule version. Commission accrues cumulatively over
executed notional, so fragmented fills cannot multiply rounding; any limit-price improvement not
needed for the execution or accrued fee returns immediately to AVAILABLE. Executed cash and tokens
move to configured clearing RESERVED accounts until the settlement module performs DvP.
