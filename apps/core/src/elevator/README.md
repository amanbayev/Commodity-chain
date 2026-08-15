# Elevator cabinet API

This module exposes the elevator read models used by `apps/web`: receipt verification requests,
physical-delivery shipments, source oracle events, incidents, and dashboard counters. Quantities are
mapped from PostgreSQL `NUMERIC` values to `bigint` before entering the domain layer and are serialized
as integer strings at the controller boundary.

The two command endpoints are thin façades over the existing EZR adapter. Receipt locking emits
`RECEIPT_LOCKED`; shipment confirmation emits `GOODS_RELEASED`. The response always contains the
persisted oracle-gateway status, so `QUARANTINED`, `STALE`, and `REJECTED` are never presented as
success. Repeated commands return the already persisted receipt/event state and do not produce a
second adapter effect.

Event previews intentionally contain only known business fields. The adapter assigns `eventId`,
timestamps, monotonic `nonce`, and Ed25519 signature when the command is executed.
