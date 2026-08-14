# Matching core

Pure TypeScript deterministic matching engine. It owns command sequencing, price-time matching,
event application, snapshots, and replay. It has no HTTP, NestJS, PostgreSQL, or NATS dependency.

All prices and quantities are `bigint` values in their documented minimal units.
