-- migrate:up

CREATE TABLE matching_books (
  instrument_id uuid PRIMARY KEY REFERENCES instrument (id),
  passport_version bigint NOT NULL,
  tick_size numeric(38, 0) NOT NULL,
  lot_size numeric(38, 0) NOT NULL,
  self_trade_policy varchar(32) NOT NULL DEFAULT 'CANCEL_NEWEST',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instrument_id, passport_version)
    REFERENCES instrument_passport_versions (instrument_id, version),
  CONSTRAINT matching_books_tick_size_positive CHECK (tick_size > 0),
  CONSTRAINT matching_books_lot_size_positive CHECK (lot_size > 0),
  CONSTRAINT matching_books_self_trade_policy_valid
    CHECK (self_trade_policy = 'CANCEL_NEWEST')
);

CREATE TABLE fee_schedules (
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  version bigint NOT NULL,
  currency char(3) NOT NULL,
  maker_rate_ppm bigint NOT NULL,
  taker_rate_ppm bigint NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, version),
  CONSTRAINT fee_schedules_version_positive CHECK (version > 0),
  CONSTRAINT fee_schedules_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fee_schedules_maker_rate_valid
    CHECK (maker_rate_ppm BETWEEN 0 AND 1000000),
  CONSTRAINT fee_schedules_taker_rate_valid
    CHECK (taker_rate_ppm BETWEEN 0 AND 1000000),
  CONSTRAINT fee_schedules_window_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX fee_schedules_one_open_version_idx
  ON fee_schedules (instrument_id)
  WHERE effective_to IS NULL;
CREATE INDEX fee_schedules_effective_idx
  ON fee_schedules (instrument_id, effective_from DESC, version DESC);

CREATE TABLE matching_events (
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  sequence bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  exchange_sequence_number bigint NOT NULL,
  event_index integer NOT NULL,
  event_count integer NOT NULL,
  command_id uuid NOT NULL,
  event_type varchar(32) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, sequence),
  CONSTRAINT matching_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT matching_events_exchange_sequence_positive
    CHECK (exchange_sequence_number > 0),
  CONSTRAINT matching_events_position_valid
    CHECK (event_count > 0 AND event_index >= 0 AND event_index < event_count),
  CONSTRAINT matching_events_type_valid CHECK (
    event_type IN (
      'OrderAccepted',
      'OrderRejected',
      'TradeExecuted',
      'OrderCancelled',
      'OrderExpired'
    )
  ),
  CONSTRAINT matching_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT matching_events_command_position_unique
    UNIQUE (instrument_id, exchange_sequence_number, event_index)
);

CREATE INDEX matching_events_command_idx
  ON matching_events (instrument_id, command_id, sequence);
CREATE INDEX matching_events_type_idx
  ON matching_events (instrument_id, event_type, sequence);

ALTER TABLE orders
  ADD COLUMN fee_schedule_version bigint,
  ADD COLUMN matching_command_id uuid UNIQUE,
  ADD COLUMN exchange_sequence_number bigint,
  ADD COLUMN reservation_amount numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN reserved_remaining numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN executed_notional numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN charged_fee numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN reserve_posting_id uuid UNIQUE REFERENCES ledger_postings (id),
  ADD COLUMN rejection_code varchar(64),
  ADD CONSTRAINT orders_fee_schedule_fk
    FOREIGN KEY (instrument_id, fee_schedule_version)
      REFERENCES fee_schedules (instrument_id, version),
  ADD CONSTRAINT orders_exchange_sequence_positive
    CHECK (exchange_sequence_number IS NULL OR exchange_sequence_number > 0),
  ADD CONSTRAINT orders_reservation_amount_non_negative CHECK (reservation_amount >= 0),
  ADD CONSTRAINT orders_reserved_remaining_valid
    CHECK (reserved_remaining >= 0 AND reserved_remaining <= reservation_amount),
  ADD CONSTRAINT orders_executed_notional_non_negative CHECK (executed_notional >= 0),
  ADD CONSTRAINT orders_charged_fee_non_negative CHECK (charged_fee >= 0),
  ADD CONSTRAINT orders_fee_schedule_required
    CHECK (status = 'NEW' OR fee_schedule_version IS NOT NULL) NOT VALID;

CREATE INDEX orders_matching_sequence_idx
  ON orders (instrument_id, exchange_sequence_number)
  WHERE exchange_sequence_number IS NOT NULL;
CREATE INDEX orders_active_reserve_idx
  ON orders (party_id, instrument_id, side, reserved_remaining)
  WHERE reserved_remaining > 0;

CREATE TABLE order_commands (
  idempotency_key varchar(128) PRIMARY KEY,
  request_hash bytea NOT NULL,
  participant_id uuid NOT NULL,
  order_id uuid REFERENCES orders (id),
  http_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_commands_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT order_commands_request_hash_sha256 CHECK (octet_length(request_hash) = 32),
  CONSTRAINT order_commands_http_status_valid CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT order_commands_response_object CHECK (jsonb_typeof(response_body) = 'object')
);

CREATE INDEX order_commands_participant_created_idx
  ON order_commands (participant_id, created_at);

CREATE TABLE oms_clearing_accounts (
  instrument_id uuid PRIMARY KEY REFERENCES instrument (id),
  cash_reserved_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  token_reserved_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oms_clearing_accounts_distinct
    CHECK (cash_reserved_account_id <> token_reserved_account_id)
);

ALTER TABLE trades
  ADD COLUMN matching_event_id uuid UNIQUE REFERENCES matching_events (event_id);

-- migrate:down

ALTER TABLE trades DROP COLUMN matching_event_id;

DROP TABLE IF EXISTS oms_clearing_accounts;
DROP TABLE IF EXISTS order_commands;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_fee_schedule_required,
  DROP CONSTRAINT IF EXISTS orders_charged_fee_non_negative,
  DROP CONSTRAINT IF EXISTS orders_executed_notional_non_negative,
  DROP CONSTRAINT IF EXISTS orders_reserved_remaining_valid,
  DROP CONSTRAINT IF EXISTS orders_reservation_amount_non_negative,
  DROP CONSTRAINT IF EXISTS orders_exchange_sequence_positive,
  DROP CONSTRAINT IF EXISTS orders_fee_schedule_fk,
  DROP COLUMN IF EXISTS rejection_code,
  DROP COLUMN IF EXISTS reserve_posting_id,
  DROP COLUMN IF EXISTS charged_fee,
  DROP COLUMN IF EXISTS executed_notional,
  DROP COLUMN IF EXISTS reserved_remaining,
  DROP COLUMN IF EXISTS reservation_amount,
  DROP COLUMN IF EXISTS exchange_sequence_number,
  DROP COLUMN IF EXISTS matching_command_id,
  DROP COLUMN IF EXISTS fee_schedule_version;

DROP TABLE IF EXISTS matching_events;
DROP TABLE IF EXISTS fee_schedules;
DROP TABLE IF EXISTS matching_books;
