-- migrate:up

CREATE TYPE redemption_status AS ENUM (
  'CREATED',
  'TOKENS_LOCKED',
  'IN_DELIVERY',
  'COMPLETED',
  'CANCELLED',
  'EXCEPTION',
  'QUARANTINED'
);

ALTER TABLE oracle_events
  ADD COLUMN redemption_id varchar(128),
  ADD CONSTRAINT oracle_events_redemption_id_format
    CHECK (
      redemption_id IS NULL
      OR redemption_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    );

CREATE INDEX oracle_events_redemption_id_idx
  ON oracle_events (redemption_id, status, id)
  WHERE redemption_id IS NOT NULL;

CREATE TABLE redemption_orders (
  id uuid PRIMARY KEY,
  holder_party_id uuid NOT NULL REFERENCES party (id),
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  quantity numeric(38, 0) NOT NULL,
  method varchar(32) NOT NULL,
  status redemption_status NOT NULL DEFAULT 'CREATED',
  elevator_id varchar(128) NOT NULL,
  requested_date date NOT NULL,
  recipient varchar(256) NOT NULL,
  transport varchar(512) NOT NULL,
  proofs jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key varchar(128) NOT NULL UNIQUE,
  request_hash bytea NOT NULL,
  correlation_id uuid NOT NULL,
  available_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  reserved_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  reserve_posting_id uuid UNIQUE REFERENCES ledger_postings (id),
  burn_posting_id uuid UNIQUE REFERENCES ledger_postings (id),
  asset_id varchar(128) REFERENCES asset (asset_id),
  oracle_event_row_id bigint UNIQUE REFERENCES oracle_events (id),
  oracle_event_id uuid UNIQUE,
  delivery_deadline timestamptz NOT NULL,
  failure_code varchar(128),
  failure_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivery_started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  exception_at timestamptz,
  quarantined_at timestamptz,
  CONSTRAINT redemption_orders_quantity_positive CHECK (quantity > 0),
  CONSTRAINT redemption_orders_method_physical CHECK (method = 'PHYSICAL_DELIVERY'),
  CONSTRAINT redemption_orders_elevator_not_blank CHECK (btrim(elevator_id) <> ''),
  CONSTRAINT redemption_orders_recipient_not_blank CHECK (btrim(recipient) <> ''),
  CONSTRAINT redemption_orders_transport_not_blank CHECK (btrim(transport) <> ''),
  CONSTRAINT redemption_orders_proofs_array CHECK (jsonb_typeof(proofs) = 'array'),
  CONSTRAINT redemption_orders_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT redemption_orders_request_hash_sha256 CHECK (octet_length(request_hash) = 32),
  CONSTRAINT redemption_orders_failure_details_object
    CHECK (jsonb_typeof(failure_details) = 'object'),
  CONSTRAINT redemption_orders_accounts_distinct
    CHECK (available_account_id <> reserved_account_id),
  CONSTRAINT redemption_orders_oracle_provenance
    CHECK (
      (oracle_event_row_id IS NULL AND oracle_event_id IS NULL)
      OR (oracle_event_row_id IS NOT NULL AND oracle_event_id IS NOT NULL)
    )
);

CREATE INDEX redemption_orders_holder_created_idx
  ON redemption_orders (holder_party_id, created_at DESC, id);
CREATE INDEX redemption_orders_instrument_status_idx
  ON redemption_orders (instrument_id, status, created_at, id);
CREATE INDEX redemption_orders_timeout_idx
  ON redemption_orders (delivery_deadline, id)
  WHERE status IN ('TOKENS_LOCKED', 'IN_DELIVERY');

CREATE TABLE redemption_transitions (
  id bigserial PRIMARY KEY,
  redemption_id uuid NOT NULL REFERENCES redemption_orders (id),
  from_status redemption_status,
  to_status redemption_status NOT NULL,
  actor varchar(128) NOT NULL,
  reason text NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redemption_transitions_actor_not_blank CHECK (btrim(actor) <> ''),
  CONSTRAINT redemption_transitions_reason_not_blank CHECK (btrim(reason) <> '')
);

CREATE INDEX redemption_transitions_redemption_idx
  ON redemption_transitions (redemption_id, occurred_at, id);

CREATE OR REPLACE FUNCTION redemption_status_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'CREATED' AND NEW.status IN ('TOKENS_LOCKED', 'CANCELLED'))
    OR (OLD.status = 'TOKENS_LOCKED' AND NEW.status IN ('IN_DELIVERY', 'CANCELLED', 'EXCEPTION'))
    OR (OLD.status = 'IN_DELIVERY' AND NEW.status IN ('COMPLETED', 'EXCEPTION', 'QUARANTINED'))
  ) THEN
    RAISE EXCEPTION 'INVALID_REDEMPTION_TRANSITION: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER redemption_orders_status_guard
BEFORE UPDATE OF status ON redemption_orders
FOR EACH ROW EXECUTE FUNCTION redemption_status_transition_guard();

-- migrate:down

DROP TRIGGER IF EXISTS redemption_orders_status_guard ON redemption_orders;
DROP FUNCTION IF EXISTS redemption_status_transition_guard();
DROP TABLE IF EXISTS redemption_transitions;
DROP TABLE IF EXISTS redemption_orders;
DROP INDEX IF EXISTS oracle_events_redemption_id_idx;
ALTER TABLE oracle_events
  DROP CONSTRAINT IF EXISTS oracle_events_redemption_id_format,
  DROP COLUMN IF EXISTS redemption_id;
DROP TYPE IF EXISTS redemption_status;
