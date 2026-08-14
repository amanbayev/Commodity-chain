-- migrate:up

ALTER TABLE instrument
  ADD COLUMN circulating_supply numeric(38, 0) NOT NULL DEFAULT 0,
  ADD CONSTRAINT instrument_circulating_supply_non_negative
    CHECK (circulating_supply >= 0),
  ADD CONSTRAINT instrument_circulating_supply_within_cap
    CHECK (circulating_supply <= supply_cap);

CREATE TABLE collateral_position_movements (
  id bigserial PRIMARY KEY,
  oracle_event_row_id bigint NOT NULL UNIQUE REFERENCES oracle_events (id),
  oracle_event_id uuid NOT NULL UNIQUE,
  movement_type varchar(16) NOT NULL,
  asset_id varchar(128) NOT NULL REFERENCES asset (asset_id),
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  quantity numeric(38, 0) NOT NULL,
  reserved_before numeric(38, 0) NOT NULL,
  reserved_after numeric(38, 0) NOT NULL,
  available_after numeric(38, 0) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collateral_position_movements_type_valid
    CHECK (movement_type IN ('RESERVE', 'RELEASE')),
  CONSTRAINT collateral_position_movements_quantity_positive CHECK (quantity > 0),
  CONSTRAINT collateral_position_movements_reserved_before_non_negative
    CHECK (reserved_before >= 0),
  CONSTRAINT collateral_position_movements_reserved_after_non_negative
    CHECK (reserved_after >= 0),
  CONSTRAINT collateral_position_movements_available_after_non_negative
    CHECK (available_after >= 0)
);

CREATE INDEX collateral_position_movements_position_idx
  ON collateral_position_movements (asset_id, instrument_id, id);
CREATE INDEX collateral_position_movements_instrument_idx
  ON collateral_position_movements (instrument_id, id);

CREATE TABLE instrument_token_accounts (
  instrument_id uuid PRIMARY KEY REFERENCES instrument (id),
  distribution_account_id uuid NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  issuance_account_id uuid NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instrument_token_accounts_distinct
    CHECK (distribution_account_id <> issuance_account_id)
);

CREATE TABLE mint_commands (
  idempotency_key varchar(128) PRIMARY KEY,
  request_hash bytea NOT NULL,
  instrument_id uuid NOT NULL,
  http_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  ledger_posting_id uuid UNIQUE REFERENCES ledger_postings (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mint_commands_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT mint_commands_request_hash_sha256 CHECK (octet_length(request_hash) = 32),
  CONSTRAINT mint_commands_http_status_valid CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT mint_commands_response_body_object CHECK (jsonb_typeof(response_body) = 'object')
);

CREATE INDEX mint_commands_instrument_created_at_idx
  ON mint_commands (instrument_id, created_at);

-- migrate:down

DROP TABLE IF EXISTS mint_commands;
DROP TABLE IF EXISTS instrument_token_accounts;
DROP TABLE IF EXISTS collateral_position_movements;

ALTER TABLE instrument
  DROP CONSTRAINT instrument_circulating_supply_within_cap,
  DROP CONSTRAINT instrument_circulating_supply_non_negative,
  DROP COLUMN circulating_supply;
