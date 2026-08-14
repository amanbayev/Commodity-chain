# Electronic grain receipt registry adapter

`EzrRegistry` is the shared boundary for the PostgreSQL mock and a future regulated registry integration. Quantities cross this boundary only as `bigint` in the commodity unit's minimal units.

The mock resolves `unit` and the initial `instrumentId` through constructor callbacks because the fixed `issueReceipt(owner, commodity, quantity, elevatorId)` operation does not carry fields that are mandatory in `OracleEventEnvelope`.
