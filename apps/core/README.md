# Core application

NestJS modular monolith for exchange and clearing-house capabilities. The currently implemented
domain slices are the oracle gateway, verified collateral ledger, and collateral-backed minting;
their HTTP surface remains contract-first in `packages/contracts/openapi.yaml`.

Database-backed integration tests use `TEST_DATABASE_URL`. `fast-check` is a test-only dependency
used to exercise randomly generated reserve/mint/release sequences against the collateral and
supply invariants; it is not included in the production runtime.
