-- migrate:up

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE instrument_legal_nature AS ENUM (
  'CLAIM_RIGHT',
  'OWNERSHIP',
  'INCOME_SHARE',
  'LICENSE',
  'ACCESS',
  'DIGITAL_GOOD',
  'INVESTMENT'
);

CREATE TYPE instrument_status AS ENUM (
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'COLLATERALIZED',
  'PRIMARY',
  'ACTIVE',
  'SUSPENDED',
  'REDEMPTION',
  'MATURED',
  'CLOSED',
  'DEFAULT'
);

CREATE TYPE asset_encumbrance_status AS ENUM (
  'FREE',
  'RESERVED',
  'PLEDGED',
  'LOCKED',
  'RELEASE_PENDING',
  'RELEASED',
  'UNKNOWN'
);

CREATE TYPE oracle_event_type AS ENUM (
  'COLLATERAL_RESERVED',
  'RECEIPT_LOCKED',
  'QUALITY_CONFIRMED',
  'STOCK_UPDATED',
  'GOODS_RELEASED',
  'REVENUE_RECEIVED'
);

CREATE TYPE order_side AS ENUM ('BUY', 'SELL');
CREATE TYPE order_type AS ENUM ('LIMIT', 'MARKET');

CREATE TYPE order_status AS ENUM (
  'NEW',
  'VALIDATING',
  'ACCEPTED',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'CANCEL_PENDING',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE settlement_finality_status AS ENUM (
  'CREATED',
  'FUNDED',
  'SUBMITTED',
  'TECHNICALLY_CONFIRMED',
  'LEGALLY_FINAL',
  'RECONCILED',
  'PENDING_RECONCILIATION',
  'FAILED_BEFORE_FINALITY',
  'MANUAL_REPAIR'
);

CREATE TYPE ledger_account_type AS ENUM ('CASH', 'TOKEN');
CREATE TYPE ledger_account_purpose AS ENUM ('AVAILABLE', 'RESERVED', 'FEE', 'RESIDUAL');
CREATE TYPE ledger_normal_side AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE ledger_entry_direction AS ENUM ('DEBIT', 'CREDIT');

-- migrate:down

DROP TYPE IF EXISTS ledger_entry_direction;
DROP TYPE IF EXISTS ledger_normal_side;
DROP TYPE IF EXISTS ledger_account_purpose;
DROP TYPE IF EXISTS ledger_account_type;
DROP TYPE IF EXISTS settlement_finality_status;
DROP TYPE IF EXISTS order_status;
DROP TYPE IF EXISTS order_type;
DROP TYPE IF EXISTS order_side;
DROP TYPE IF EXISTS oracle_event_type;
DROP TYPE IF EXISTS asset_encumbrance_status;
DROP TYPE IF EXISTS instrument_status;
DROP TYPE IF EXISTS instrument_legal_nature;
DROP EXTENSION IF EXISTS pgcrypto;
