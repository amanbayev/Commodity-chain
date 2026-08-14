-- migrate:up

CREATE TYPE oracle_event_status AS ENUM (
  'RECEIVED',
  'SCHEMA_VALIDATED',
  'SIGNATURE_VALIDATED',
  'POLICY_VALIDATED',
  'APPLIED',
  'DUPLICATE',
  'STALE',
  'QUARANTINED',
  'REJECTED'
);

CREATE TABLE trusted_sources (
  source_id varchar(128) NOT NULL,
  key_id varchar(128) NOT NULL,
  algorithm varchar(64) NOT NULL,
  public_key_pem text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (source_id, key_id),
  CONSTRAINT trusted_sources_source_id_format
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT trusted_sources_key_id_format
    CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT trusted_sources_algorithm_ed25519 CHECK (algorithm = 'Ed25519'),
  CONSTRAINT trusted_sources_public_key_not_blank CHECK (btrim(public_key_pem) <> ''),
  CONSTRAINT trusted_sources_revocation_order
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX trusted_sources_active_source_idx
  ON trusted_sources (source_id, key_id)
  WHERE revoked_at IS NULL;

ALTER TABLE oracle_events
  DROP CONSTRAINT oracle_events_instrument_id_fkey,
  DROP CONSTRAINT oracle_events_asset_id_fkey,
  ALTER COLUMN source_id DROP NOT NULL,
  ALTER COLUMN event_id DROP NOT NULL,
  ALTER COLUMN schema_version DROP NOT NULL,
  ALTER COLUMN instrument_id DROP NOT NULL,
  ALTER COLUMN asset_id DROP NOT NULL,
  ALTER COLUMN event_type DROP NOT NULL,
  ALTER COLUMN quantity DROP NOT NULL,
  ALTER COLUMN unit DROP NOT NULL,
  ALTER COLUMN observed_at DROP NOT NULL,
  ALTER COLUMN effective_at DROP NOT NULL,
  ALTER COLUMN evidence_hash DROP NOT NULL,
  ALTER COLUMN nonce DROP NOT NULL,
  ALTER COLUMN signature DROP NOT NULL,
  ADD COLUMN status oracle_event_status NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN idempotency_key varchar(128),
  ADD COLUMN request_hash bytea,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN http_status smallint,
  ADD COLUMN response_body jsonb,
  ADD COLUMN failure_code varchar(128),
  ADD COLUMN failure_details jsonb,
  ADD COLUMN status_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN applied_at timestamptz,
  ADD CONSTRAINT oracle_events_idempotency_key_format
    CHECK (
      idempotency_key IS NULL
      OR idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
  ADD CONSTRAINT oracle_events_request_hash_sha256
    CHECK (request_hash IS NULL OR octet_length(request_hash) = 32),
  ADD CONSTRAINT oracle_events_http_status_valid
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  ADD CONSTRAINT oracle_events_response_body_object
    CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
  ADD CONSTRAINT oracle_events_failure_details_array
    CHECK (failure_details IS NULL OR jsonb_typeof(failure_details) = 'array'),
  ADD CONSTRAINT oracle_events_applied_state_consistent
    CHECK (
      (status = 'APPLIED' AND applied_at IS NOT NULL)
      OR (status <> 'APPLIED' AND applied_at IS NULL)
    );

CREATE UNIQUE INDEX oracle_events_idempotency_key_unique
  ON oracle_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX oracle_events_applied_source_nonce_unique
  ON oracle_events (source_id, nonce)
  WHERE status = 'APPLIED';
CREATE INDEX oracle_events_status_updated_at_idx
  ON oracle_events (status, status_updated_at, id);

CREATE TABLE mock_ezr_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner varchar(128) NOT NULL,
  commodity varchar(64) NOT NULL,
  quantity numeric(38, 0) NOT NULL,
  unit varchar(32) NOT NULL,
  elevator_id varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'AVAILABLE',
  instrument_id uuid NOT NULL,
  redemption_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mock_ezr_receipts_owner_not_blank CHECK (btrim(owner) <> ''),
  CONSTRAINT mock_ezr_receipts_commodity_format
    CHECK (commodity ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT mock_ezr_receipts_quantity_positive CHECK (quantity > 0),
  CONSTRAINT mock_ezr_receipts_unit_format CHECK (unit ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT mock_ezr_receipts_elevator_id_not_blank CHECK (btrim(elevator_id) <> ''),
  CONSTRAINT mock_ezr_receipts_status_valid
    CHECK (status IN ('AVAILABLE', 'LOCKED', 'RELEASED')),
  CONSTRAINT mock_ezr_receipts_redemption_state
    CHECK (
      (status = 'RELEASED' AND redemption_id IS NOT NULL)
      OR (status <> 'RELEASED' AND redemption_id IS NULL)
    )
);

CREATE INDEX mock_ezr_receipts_owner_idx ON mock_ezr_receipts (owner, created_at);
CREATE INDEX mock_ezr_receipts_instrument_status_idx
  ON mock_ezr_receipts (instrument_id, status);

CREATE TABLE mock_ezr_source_counters (
  source_id varchar(128) PRIMARY KEY,
  last_nonce bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mock_ezr_source_counters_source_id_format
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT mock_ezr_source_counters_nonce_non_negative CHECK (last_nonce >= 0)
);

CREATE TABLE mock_ezr_http_outbox (
  event_id uuid PRIMARY KEY,
  source_id varchar(128) NOT NULL,
  receipt_id uuid NOT NULL REFERENCES mock_ezr_receipts (receipt_id),
  envelope jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  delivered_at timestamptz,
  http_status smallint,
  response_body jsonb,
  last_error text,
  CONSTRAINT mock_ezr_http_outbox_source_id_format
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT mock_ezr_http_outbox_envelope_object
    CHECK (jsonb_typeof(envelope) = 'object'),
  CONSTRAINT mock_ezr_http_outbox_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT mock_ezr_http_outbox_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT mock_ezr_http_outbox_http_status_valid
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT mock_ezr_http_outbox_response_body_object
    CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object')
);

CREATE INDEX mock_ezr_http_outbox_pending_idx
  ON mock_ezr_http_outbox (created_at, event_id)
  WHERE delivered_at IS NULL;

-- migrate:down

DROP TABLE IF EXISTS mock_ezr_http_outbox;
DROP TABLE IF EXISTS mock_ezr_source_counters;
DROP TABLE IF EXISTS mock_ezr_receipts;

DROP INDEX IF EXISTS oracle_events_status_updated_at_idx;
DROP INDEX IF EXISTS oracle_events_applied_source_nonce_unique;
DROP INDEX IF EXISTS oracle_events_idempotency_key_unique;

DELETE FROM oracle_events
WHERE instrument_id IS NULL
  OR source_id IS NULL
  OR event_id IS NULL
  OR schema_version IS NULL
  OR asset_id IS NULL
  OR event_type IS NULL
  OR quantity IS NULL
  OR unit IS NULL
  OR observed_at IS NULL
  OR effective_at IS NULL
  OR evidence_hash IS NULL
  OR nonce IS NULL
  OR signature IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM instrument WHERE instrument.id = oracle_events.instrument_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM asset WHERE asset.asset_id = oracle_events.asset_id
  );

ALTER TABLE oracle_events
  DROP CONSTRAINT oracle_events_applied_state_consistent,
  DROP CONSTRAINT oracle_events_failure_details_array,
  DROP CONSTRAINT oracle_events_response_body_object,
  DROP CONSTRAINT oracle_events_http_status_valid,
  DROP CONSTRAINT oracle_events_request_hash_sha256,
  DROP CONSTRAINT oracle_events_idempotency_key_format,
  DROP COLUMN applied_at,
  DROP COLUMN status_updated_at,
  DROP COLUMN failure_details,
  DROP COLUMN failure_code,
  DROP COLUMN response_body,
  DROP COLUMN http_status,
  DROP COLUMN raw_payload,
  DROP COLUMN correlation_id,
  DROP COLUMN request_hash,
  DROP COLUMN idempotency_key,
  DROP COLUMN status,
  ALTER COLUMN signature SET NOT NULL,
  ALTER COLUMN nonce SET NOT NULL,
  ALTER COLUMN evidence_hash SET NOT NULL,
  ALTER COLUMN effective_at SET NOT NULL,
  ALTER COLUMN observed_at SET NOT NULL,
  ALTER COLUMN unit SET NOT NULL,
  ALTER COLUMN quantity SET NOT NULL,
  ALTER COLUMN event_type SET NOT NULL,
  ALTER COLUMN asset_id SET NOT NULL,
  ALTER COLUMN instrument_id SET NOT NULL,
  ALTER COLUMN schema_version SET NOT NULL,
  ALTER COLUMN event_id SET NOT NULL,
  ALTER COLUMN source_id SET NOT NULL,
  ADD CONSTRAINT oracle_events_instrument_id_fkey
    FOREIGN KEY (instrument_id) REFERENCES instrument (id),
  ADD CONSTRAINT oracle_events_asset_id_fkey
    FOREIGN KEY (asset_id) REFERENCES asset (asset_id);

DROP TABLE IF EXISTS trusted_sources;
DROP TYPE IF EXISTS oracle_event_status;
