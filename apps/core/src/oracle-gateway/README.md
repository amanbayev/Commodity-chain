# Oracle gateway module

Accepts the contract-first `POST /v1/oracle-events` command and persists every processing outcome.
The synchronous pipeline is `RECEIVED -> SCHEMA_VALIDATED -> SIGNATURE_VALIDATED ->
POLICY_VALIDATED -> APPLIED`; duplicate, stale, quarantined, and rejected events are terminal.

Validation is compiled directly from `packages/contracts/openapi.yaml`. Signatures are Ed25519 over
UTF-8 canonical JSON after removing the top-level `signature`: object keys are recursively sorted,
arrays retain their order, and `JSON.stringify` emits no insignificant whitespace. Signature bytes
use unpadded base64url and must be identical in `X-Oracle-Signature` and `signature.value`.

An applied event, its append-only audit entry, and its outbox message are committed atomically. The
gateway never publishes directly to NATS. `ORACLE_FRESHNESS_WINDOW_MS` configures freshness and
defaults to 24 hours.

The module uses `ajv` plus `ajv-formats` to enforce the OpenAPI 3.1 JSON Schema in strict mode,
`yaml` to load the source contract without maintaining a second schema, and `pg` so the accepted
event, audit row, and outbox row share one PostgreSQL transaction. Node's built-in crypto performs
Ed25519 verification, so no additional cryptography dependency is required.
