-- migrate:up

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_party_id uuid NOT NULL REFERENCES party (id),
  wallet_account_id uuid REFERENCES wallet_account (id),
  account_type ledger_account_type NOT NULL,
  normal_side ledger_normal_side NOT NULL,
  currency char(3),
  instrument_id uuid REFERENCES instrument (id),
  purpose ledger_account_purpose NOT NULL,
  balance numeric(38, 0) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_denomination_valid
    CHECK (
      (
        account_type = 'CASH'
        AND currency IS NOT NULL
        AND instrument_id IS NULL
      )
      OR (
        account_type = 'TOKEN'
        AND currency IS NULL
        AND instrument_id IS NOT NULL
      )
    ),
  CONSTRAINT ledger_accounts_currency_format
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_accounts_balance_non_negative CHECK (balance >= 0)
);

CREATE UNIQUE INDEX ledger_cash_account_identity_idx
  ON ledger_accounts (owner_party_id, currency, purpose)
  WHERE account_type = 'CASH';

CREATE UNIQUE INDEX ledger_token_account_identity_idx
  ON ledger_accounts (owner_party_id, instrument_id, purpose)
  WHERE account_type = 'TOKEN';

CREATE INDEX ledger_accounts_owner_party_id_idx ON ledger_accounts (owner_party_id);
CREATE INDEX ledger_accounts_wallet_account_id_idx
  ON ledger_accounts (wallet_account_id)
  WHERE wallet_account_id IS NOT NULL;
CREATE INDEX ledger_accounts_instrument_id_idx
  ON ledger_accounts (instrument_id)
  WHERE instrument_id IS NOT NULL;

CREATE TABLE ledger_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(128) NOT NULL UNIQUE,
  request_hash bytea NOT NULL,
  reversal_of uuid UNIQUE REFERENCES ledger_postings (id),
  correlation_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_postings_idempotency_key_not_blank
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT ledger_postings_request_hash_sha256
    CHECK (octet_length(request_hash) = 32),
  CONSTRAINT ledger_postings_not_self_reversal
    CHECK (reversal_of IS NULL OR reversal_of <> id),
  CONSTRAINT ledger_postings_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX ledger_postings_created_at_idx ON ledger_postings (created_at, id);
CREATE INDEX ledger_postings_correlation_id_idx ON ledger_postings (correlation_id);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id uuid NOT NULL REFERENCES ledger_postings (id),
  leg_index smallint NOT NULL,
  account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  direction ledger_entry_direction NOT NULL,
  amount numeric(38, 0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_posting_leg_unique UNIQUE (posting_id, leg_index),
  CONSTRAINT ledger_entries_leg_index_non_negative CHECK (leg_index >= 0),
  CONSTRAINT ledger_entries_amount_positive CHECK (amount > 0)
);

CREATE INDEX ledger_entries_account_id_idx
  ON ledger_entries (account_id, created_at, id);

CREATE OR REPLACE FUNCTION ledger_reject_late_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM ledger_postings
      WHERE id = NEW.posting_id
        AND xmin::text = pg_current_xact_id()::text
  ) THEN
    RAISE EXCEPTION 'ledger posting % is immutable', NEW.posting_id
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_reject_late_insert
BEFORE INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION ledger_reject_late_entry();

CREATE OR REPLACE FUNCTION ledger_validate_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_posting_id uuid;
  leg_count integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_postings' THEN
    checked_posting_id := NEW.id;
  ELSE
    checked_posting_id := NEW.posting_id;
  END IF;

  SELECT count(*)
    INTO leg_count
    FROM ledger_entries
    WHERE posting_id = checked_posting_id;

  IF leg_count < 2 THEN
    RAISE EXCEPTION 'ledger posting % must contain at least two legs', checked_posting_id
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ledger_entries AS entry
      JOIN ledger_accounts AS account ON account.id = entry.account_id
      WHERE entry.posting_id = checked_posting_id
      GROUP BY account.account_type, account.currency, account.instrument_id
      HAVING sum(
        CASE entry.direction
          WHEN 'DEBIT' THEN entry.amount
          WHEN 'CREDIT' THEN -entry.amount
        END
      ) <> 0
  ) THEN
    RAISE EXCEPTION 'ledger posting % is not balanced by denomination', checked_posting_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_postings_validate_on_commit
AFTER INSERT ON ledger_postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ledger_validate_posting();

CREATE CONSTRAINT TRIGGER ledger_entries_validate_on_commit
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ledger_validate_posting();

CREATE TRIGGER ledger_postings_reject_mutation
BEFORE UPDATE OR DELETE ON ledger_postings
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER ledger_entries_reject_mutation
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();

REVOKE UPDATE, DELETE ON ledger_postings FROM PUBLIC;
REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;

-- migrate:down

DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS ledger_postings;
DROP TABLE IF EXISTS ledger_accounts;
DROP FUNCTION IF EXISTS ledger_validate_posting();
DROP FUNCTION IF EXISTS ledger_reject_late_entry();
