# PostgreSQL EZR registry mock

The mock stores receipts in `mock_ezr_receipts`. Issue, lock and release transitions enqueue signed `STOCK_UPDATED`, `RECEIPT_LOCKED` and `GOODS_RELEASED` envelopes, respectively. Receipt rows, the per-source nonce increment and `mock_ezr_http_outbox` insertion commit atomically. Delivery is attempted immediately; failures remain pending for `drainOutbox()` to retry with the original `eventId`, nonce, correlation ID and idempotency key.

## Canonical JSON and Ed25519

The signed payload is the complete `OracleEventEnvelope` except its self-referential `signature` field. Object keys are sorted recursively by their UTF-8 byte sequence. Array order is preserved. JSON is UTF-8 encoded without insignificant whitespace. `undefined`, non-integer numbers, unsafe integers, `bigint`, functions and symbols are rejected. Commodity quantity is serialized as a decimal integer string in minor units; nonce remains a JSON safe integer as required by the current OpenAPI contract.

Ed25519 signs these canonical UTF-8 bytes. The envelope contains `{ algorithm: "Ed25519", keyId, value }`, where `value` is unpadded base64url. `X-Oracle-Signature` carries exactly the same base64url value.

The HTTP publisher also sends `Authorization: Bearer <token>`, `X-Correlation-Id`, and `Idempotency-Key` to `/v1/oracle-events`. The mock never discards an event because an HTTP attempt failed.

Generate development keys as documented in `ops/keys/README.md`. The public SPKI PEM is stored in `trusted_sources`; the private PKCS#8 PEM stays in the ignored `ops/keys/private/` directory.
