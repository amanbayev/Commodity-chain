-- migrate:up

CREATE TABLE party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id varchar(128) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_external_id_not_blank CHECK (btrim(external_id) <> '')
);

CREATE TABLE wallet_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES party (id),
  external_reference varchar(128) NOT NULL,
  network varchar(64) NOT NULL,
  address varchar(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_account_external_reference_not_blank
    CHECK (btrim(external_reference) <> ''),
  CONSTRAINT wallet_account_network_not_blank CHECK (btrim(network) <> ''),
  CONSTRAINT wallet_account_address_not_blank CHECK (btrim(address) <> ''),
  CONSTRAINT wallet_account_party_external_reference_unique
    UNIQUE (party_id, external_reference)
);

CREATE INDEX wallet_account_party_id_idx ON wallet_account (party_id);

CREATE TABLE instrument (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(64) NOT NULL,
  legal_nature instrument_legal_nature NOT NULL,
  status instrument_status NOT NULL DEFAULT 'DRAFT',
  currency char(3) NOT NULL,
  unit varchar(32) NOT NULL,
  unit_per_token numeric(38, 0) NOT NULL,
  supply_cap numeric(38, 0) NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instrument_type_format CHECK (type ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT instrument_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT instrument_unit_format CHECK (unit ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT instrument_unit_per_token_positive CHECK (unit_per_token > 0),
  CONSTRAINT instrument_supply_cap_positive CHECK (supply_cap > 0),
  CONSTRAINT instrument_version_positive CHECK (version > 0),
  CONSTRAINT instrument_extensions_object CHECK (jsonb_typeof(extensions) = 'object')
);

CREATE INDEX instrument_status_idx ON instrument (status);

CREATE TABLE asset (
  asset_id varchar(128) PRIMARY KEY,
  class varchar(64) NOT NULL,
  owner_party_id uuid NOT NULL REFERENCES party (id),
  quantity numeric(38, 0) NOT NULL,
  unit varchar(32) NOT NULL,
  location varchar(512) NOT NULL,
  encumbrance_status asset_encumbrance_status NOT NULL DEFAULT 'UNKNOWN',
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_id_format CHECK (asset_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT asset_class_format CHECK (class ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT asset_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT asset_unit_format CHECK (unit ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT asset_location_not_blank CHECK (btrim(location) <> ''),
  CONSTRAINT asset_extensions_object CHECK (jsonb_typeof(extensions) = 'object')
);

CREATE INDEX asset_owner_party_id_idx ON asset (owner_party_id);
CREATE INDEX asset_encumbrance_status_idx ON asset (encumbrance_status);

CREATE TABLE collateral_position (
  asset_id varchar(128) NOT NULL REFERENCES asset (asset_id),
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  reserved numeric(38, 0) NOT NULL DEFAULT 0,
  available numeric(38, 0) NOT NULL DEFAULT 0,
  unit varchar(32) NOT NULL,
  verifier_proofs jsonb NOT NULL DEFAULT '[]'::jsonb,
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, instrument_id),
  CONSTRAINT collateral_position_reserved_non_negative CHECK (reserved >= 0),
  CONSTRAINT collateral_position_available_non_negative CHECK (available >= 0),
  CONSTRAINT collateral_position_unit_format CHECK (unit ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT collateral_position_verifier_proofs_array
    CHECK (jsonb_typeof(verifier_proofs) = 'array'),
  CONSTRAINT collateral_position_extensions_object
    CHECK (jsonb_typeof(extensions) = 'object')
);

CREATE INDEX collateral_position_instrument_id_idx
  ON collateral_position (instrument_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES party (id),
  client_order_id varchar(128) NOT NULL,
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  side order_side NOT NULL,
  type order_type NOT NULL,
  price numeric(38, 0),
  quantity numeric(38, 0) NOT NULL,
  open_quantity numeric(38, 0) NOT NULL,
  status order_status NOT NULL DEFAULT 'NEW',
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT orders_party_client_order_id_unique UNIQUE (party_id, client_order_id),
  CONSTRAINT orders_client_order_id_not_blank CHECK (btrim(client_order_id) <> ''),
  CONSTRAINT orders_price_positive CHECK (price IS NULL OR price > 0),
  CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
  CONSTRAINT orders_open_quantity_valid
    CHECK (open_quantity >= 0 AND open_quantity <= quantity),
  CONSTRAINT orders_price_matches_type
    CHECK (
      (type = 'LIMIT' AND price IS NOT NULL)
      OR (type = 'MARKET' AND price IS NULL)
    ),
  CONSTRAINT orders_extensions_object CHECK (jsonb_typeof(extensions) = 'object')
);

CREATE INDEX orders_party_id_idx ON orders (party_id);
CREATE INDEX orders_instrument_status_idx ON orders (instrument_id, status);
CREATE INDEX orders_orderbook_buy_idx
  ON orders (instrument_id, price DESC, created_at, id)
  WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED');
CREATE INDEX orders_orderbook_sell_idx
  ON orders (instrument_id, price ASC, created_at, id)
  WHERE side = 'SELL' AND status IN ('OPEN', 'PARTIALLY_FILLED');

CREATE TABLE trades (
  trade_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id uuid NOT NULL REFERENCES orders (id),
  sell_order_id uuid NOT NULL REFERENCES orders (id),
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  price numeric(38, 0) NOT NULL,
  quantity numeric(38, 0) NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trades_distinct_orders CHECK (buy_order_id <> sell_order_id),
  CONSTRAINT trades_price_positive CHECK (price > 0),
  CONSTRAINT trades_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX trades_buy_order_id_idx ON trades (buy_order_id);
CREATE INDEX trades_sell_order_id_idx ON trades (sell_order_id);
CREATE INDEX trades_instrument_executed_at_idx
  ON trades (instrument_id, executed_at, trade_id);

CREATE TABLE settlements (
  trade_id uuid PRIMARY KEY REFERENCES trades (trade_id),
  cash_currency char(3) NOT NULL,
  cash_amount numeric(38, 0) NOT NULL,
  cash_payer_party_id uuid NOT NULL REFERENCES party (id),
  cash_payee_party_id uuid NOT NULL REFERENCES party (id),
  token_instrument_id uuid NOT NULL REFERENCES instrument (id),
  token_quantity numeric(38, 0) NOT NULL,
  token_from_party_id uuid NOT NULL REFERENCES party (id),
  token_to_party_id uuid NOT NULL REFERENCES party (id),
  finality_status settlement_finality_status NOT NULL DEFAULT 'CREATED',
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_cash_currency_format CHECK (cash_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT settlements_cash_amount_non_negative CHECK (cash_amount >= 0),
  CONSTRAINT settlements_token_quantity_non_negative CHECK (token_quantity >= 0),
  CONSTRAINT settlements_cash_parties_distinct
    CHECK (cash_payer_party_id <> cash_payee_party_id),
  CONSTRAINT settlements_token_parties_distinct
    CHECK (token_from_party_id <> token_to_party_id),
  CONSTRAINT settlements_extensions_object CHECK (jsonb_typeof(extensions) = 'object')
);

CREATE INDEX settlements_cash_payer_party_id_idx ON settlements (cash_payer_party_id);
CREATE INDEX settlements_cash_payee_party_id_idx ON settlements (cash_payee_party_id);
CREATE INDEX settlements_token_instrument_id_idx ON settlements (token_instrument_id);
CREATE INDEX settlements_token_from_party_id_idx ON settlements (token_from_party_id);
CREATE INDEX settlements_token_to_party_id_idx ON settlements (token_to_party_id);
CREATE INDEX settlements_finality_status_idx ON settlements (finality_status, updated_at);

CREATE TABLE settlement_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES settlements (trade_id),
  fee_type varchar(64) NOT NULL,
  currency char(3) NOT NULL,
  amount numeric(38, 0) NOT NULL,
  recipient_party_id uuid REFERENCES party (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_fees_type_format CHECK (fee_type ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT settlement_fees_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT settlement_fees_amount_non_negative CHECK (amount >= 0)
);

CREATE INDEX settlement_fees_settlement_id_idx ON settlement_fees (settlement_id);
CREATE INDEX settlement_fees_recipient_party_id_idx
  ON settlement_fees (recipient_party_id);

CREATE TABLE oracle_events (
  id bigserial PRIMARY KEY,
  source_id varchar(128) NOT NULL,
  event_id uuid NOT NULL,
  schema_version varchar(32) NOT NULL,
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  asset_id varchar(128) NOT NULL REFERENCES asset (asset_id),
  event_type oracle_event_type NOT NULL,
  quantity numeric(38, 0) NOT NULL,
  unit varchar(32) NOT NULL,
  observed_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  evidence_hash varchar(256) NOT NULL,
  nonce bigint NOT NULL,
  signature jsonb NOT NULL,
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oracle_events_source_event_unique UNIQUE (source_id, event_id),
  CONSTRAINT oracle_events_source_id_format
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT oracle_events_schema_version_format
    CHECK (schema_version ~ '^[1-9][0-9]*$'),
  CONSTRAINT oracle_events_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT oracle_events_unit_format CHECK (unit ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT oracle_events_evidence_hash_not_blank CHECK (btrim(evidence_hash) <> ''),
  CONSTRAINT oracle_events_nonce_non_negative CHECK (nonce >= 0),
  CONSTRAINT oracle_events_signature_object CHECK (jsonb_typeof(signature) = 'object'),
  CONSTRAINT oracle_events_extensions_object CHECK (jsonb_typeof(extensions) = 'object')
);

CREATE INDEX oracle_events_instrument_effective_at_idx
  ON oracle_events (instrument_id, effective_at, id);
CREATE INDEX oracle_events_asset_effective_at_idx
  ON oracle_events (asset_id, effective_at, id);
CREATE INDEX oracle_events_source_nonce_idx ON oracle_events (source_id, nonce);

CREATE TABLE event_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor varchar(128) NOT NULL,
  event_type varchar(128) NOT NULL,
  aggregate_type varchar(64) NOT NULL,
  aggregate_id varchar(128) NOT NULL,
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  prev_hash bytea,
  this_hash bytea NOT NULL,
  CONSTRAINT event_log_actor_not_blank CHECK (btrim(actor) <> ''),
  CONSTRAINT event_log_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT event_log_aggregate_type_not_blank CHECK (btrim(aggregate_type) <> ''),
  CONSTRAINT event_log_aggregate_id_not_blank CHECK (btrim(aggregate_id) <> ''),
  CONSTRAINT event_log_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE OR REPLACE FUNCTION event_log_assign_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prior_hash bytea;
  canonical_record text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('commodity_chain.event_log.hash_chain', 0));

  SELECT this_hash
    INTO prior_hash
    FROM event_log
    ORDER BY id DESC
    LIMIT 1;

  NEW.prev_hash := prior_hash;
  canonical_record := concat_ws(
    '|',
    NEW.id::text,
    to_char(
      NEW.occurred_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    NEW.actor,
    NEW.event_type,
    NEW.aggregate_type,
    NEW.aggregate_id,
    NEW.correlation_id::text,
    NEW.payload::text,
    coalesce(encode(prior_hash, 'hex'), '')
  );
  NEW.this_hash := digest(convert_to(canonical_record, 'UTF8'), 'sha256');

  RETURN NEW;
END;
$$;

CREATE TRIGGER event_log_hash_chain
BEFORE INSERT ON event_log
FOR EACH ROW
EXECUTE FUNCTION event_log_assign_hash();

CREATE OR REPLACE FUNCTION reject_immutable_row_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER event_log_reject_mutation
BEFORE UPDATE OR DELETE ON event_log
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();

REVOKE UPDATE, DELETE ON event_log FROM PUBLIC;

CREATE INDEX event_log_occurred_at_idx ON event_log (occurred_at, id);
CREATE INDEX event_log_aggregate_idx
  ON event_log (aggregate_type, aggregate_id, id);
CREATE INDEX event_log_event_type_idx ON event_log (event_type, occurred_at, id);
CREATE INDEX event_log_correlation_id_idx ON event_log (correlation_id);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic varchar(256) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_topic_not_blank CHECK (btrim(topic) <> ''),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX outbox_unpublished_idx
  ON outbox (created_at, id)
  WHERE published_at IS NULL;

-- migrate:down

DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS event_log;
DROP FUNCTION IF EXISTS event_log_assign_hash();
DROP FUNCTION IF EXISTS reject_immutable_row_change();
DROP TABLE IF EXISTS oracle_events;
DROP TABLE IF EXISTS settlement_fees;
DROP TABLE IF EXISTS settlements;
DROP TABLE IF EXISTS trades;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS collateral_position;
DROP TABLE IF EXISTS asset;
DROP TABLE IF EXISTS instrument;
DROP TABLE IF EXISTS wallet_account;
DROP TABLE IF EXISTS party;
