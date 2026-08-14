-- migrate:up

ALTER TABLE settlements
  ADD COLUMN source_event_id uuid UNIQUE,
  ADD COLUMN source_event_nonce bigint,
  ADD COLUMN ledger_posting_id uuid UNIQUE REFERENCES ledger_postings (id),
  ADD COLUMN buyer_fee_amount numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN seller_fee_amount numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN rounding_residual numeric(38, 0) NOT NULL DEFAULT 0,
  ADD COLUMN funded_at timestamptz,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN technically_confirmed_at timestamptz,
  ADD COLUMN legally_final_at timestamptz,
  ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN failed_at timestamptz,
  ADD COLUMN failure_code varchar(64),
  ADD COLUMN failure_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT settlements_source_event_nonce_positive
    CHECK (source_event_nonce IS NULL OR source_event_nonce > 0),
  ADD CONSTRAINT settlements_buyer_fee_non_negative CHECK (buyer_fee_amount >= 0),
  ADD CONSTRAINT settlements_seller_fee_non_negative CHECK (seller_fee_amount >= 0),
  ADD CONSTRAINT settlements_rounding_residual_non_negative CHECK (rounding_residual >= 0),
  ADD CONSTRAINT settlements_failure_details_object CHECK (jsonb_typeof(failure_details) = 'object');

CREATE TABLE settlement_system_accounts (
  currency char(3) PRIMARY KEY,
  fee_account_id uuid NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  residual_account_id uuid NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  configured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_system_accounts_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT settlement_system_accounts_distinct CHECK (fee_account_id <> residual_account_id)
);

CREATE TABLE settlement_account_snapshots (
  settlement_id uuid PRIMARY KEY REFERENCES settlements (trade_id),
  cash_source_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  token_source_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  seller_cash_available_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  buyer_token_available_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  fee_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  residual_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_account_snapshots_cash_distinct
    CHECK (
      cash_source_account_id <> seller_cash_available_account_id
      AND cash_source_account_id <> fee_account_id
      AND cash_source_account_id <> residual_account_id
      AND seller_cash_available_account_id <> fee_account_id
      AND seller_cash_available_account_id <> residual_account_id
      AND fee_account_id <> residual_account_id
    ),
  CONSTRAINT settlement_account_snapshots_token_distinct
    CHECK (token_source_account_id <> buyer_token_available_account_id)
);

CREATE TABLE settlement_transitions (
  id bigserial PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements (trade_id),
  from_status settlement_finality_status NOT NULL,
  to_status settlement_finality_status NOT NULL,
  actor varchar(256) NOT NULL,
  reason text NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  nonce bigint NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_transitions_actual_change CHECK (from_status <> to_status),
  CONSTRAINT settlement_transitions_actor_not_blank CHECK (btrim(actor) <> ''),
  CONSTRAINT settlement_transitions_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT settlement_transitions_nonce_positive CHECK (nonce > 0)
);

CREATE INDEX settlement_transitions_settlement_idx
  ON settlement_transitions (settlement_id, id);
CREATE INDEX settlement_transitions_correlation_idx
  ON settlement_transitions (correlation_id, id);

ALTER TABLE settlement_fees
  ADD COLUMN charged_party_id uuid REFERENCES party (id),
  ADD COLUMN component varchar(16) NOT NULL DEFAULT 'FEE',
  ADD CONSTRAINT settlement_fees_component_valid CHECK (component IN ('FEE', 'RESIDUAL')),
  ADD CONSTRAINT settlement_fees_type_unique UNIQUE (settlement_id, fee_type);

CREATE OR REPLACE FUNCTION enforce_settlement_state_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.finality_status <> OLD.finality_status AND NOT (
    (OLD.finality_status = 'CREATED' AND NEW.finality_status IN ('FUNDED', 'FAILED_BEFORE_FINALITY'))
    OR (OLD.finality_status = 'FUNDED' AND NEW.finality_status IN ('SUBMITTED', 'FAILED_BEFORE_FINALITY'))
    OR (OLD.finality_status = 'SUBMITTED' AND NEW.finality_status IN ('TECHNICALLY_CONFIRMED', 'FAILED_BEFORE_FINALITY'))
    OR (OLD.finality_status = 'TECHNICALLY_CONFIRMED' AND NEW.finality_status = 'LEGALLY_FINAL')
    OR (OLD.finality_status = 'LEGALLY_FINAL' AND NEW.finality_status IN ('RECONCILED', 'PENDING_RECONCILIATION'))
    OR (OLD.finality_status = 'PENDING_RECONCILIATION' AND NEW.finality_status IN ('RECONCILED', 'MANUAL_REPAIR'))
    OR (OLD.finality_status = 'FAILED_BEFORE_FINALITY' AND NEW.finality_status = 'MANUAL_REPAIR')
  ) THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_TRANSITION: % -> %', OLD.finality_status, NEW.finality_status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.legally_final_at IS NOT NULL AND NEW.legally_final_at IS DISTINCT FROM OLD.legally_final_at THEN
    RAISE EXCEPTION 'LEGALLY_FINAL timestamp is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.ledger_posting_id IS NOT NULL
     AND NEW.ledger_posting_id IS DISTINCT FROM OLD.ledger_posting_id THEN
    RAISE EXCEPTION 'Settlement ledger posting is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.legally_final_at IS NOT NULL
     AND NEW.finality_status IN ('CREATED', 'FUNDED', 'SUBMITTED', 'TECHNICALLY_CONFIRMED', 'FAILED_BEFORE_FINALITY') THEN
    RAISE EXCEPTION 'LEGALLY_FINAL settlement cannot move backward' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER settlements_state_transition_guard
BEFORE UPDATE ON settlements
FOR EACH ROW
EXECUTE FUNCTION enforce_settlement_state_transition();

-- migrate:down

DROP TRIGGER IF EXISTS settlements_state_transition_guard ON settlements;
DROP FUNCTION IF EXISTS enforce_settlement_state_transition();

ALTER TABLE settlement_fees
  DROP CONSTRAINT IF EXISTS settlement_fees_type_unique,
  DROP CONSTRAINT IF EXISTS settlement_fees_component_valid,
  DROP COLUMN IF EXISTS component,
  DROP COLUMN IF EXISTS charged_party_id;

DROP TABLE IF EXISTS settlement_transitions;
DROP TABLE IF EXISTS settlement_account_snapshots;
DROP TABLE IF EXISTS settlement_system_accounts;

ALTER TABLE settlements
  DROP CONSTRAINT IF EXISTS settlements_failure_details_object,
  DROP CONSTRAINT IF EXISTS settlements_rounding_residual_non_negative,
  DROP CONSTRAINT IF EXISTS settlements_seller_fee_non_negative,
  DROP CONSTRAINT IF EXISTS settlements_buyer_fee_non_negative,
  DROP CONSTRAINT IF EXISTS settlements_source_event_nonce_positive,
  DROP COLUMN IF EXISTS failure_details,
  DROP COLUMN IF EXISTS failure_code,
  DROP COLUMN IF EXISTS failed_at,
  DROP COLUMN IF EXISTS reconciled_at,
  DROP COLUMN IF EXISTS legally_final_at,
  DROP COLUMN IF EXISTS technically_confirmed_at,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS funded_at,
  DROP COLUMN IF EXISTS rounding_residual,
  DROP COLUMN IF EXISTS seller_fee_amount,
  DROP COLUMN IF EXISTS buyer_fee_amount,
  DROP COLUMN IF EXISTS ledger_posting_id,
  DROP COLUMN IF EXISTS source_event_nonce,
  DROP COLUMN IF EXISTS source_event_id;
