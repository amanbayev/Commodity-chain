-- migrate:up

ALTER TABLE instrument
  ADD COLUMN passport_hash varchar(71),
  ADD COLUMN suspended_from_status instrument_status,
  ADD CONSTRAINT instrument_passport_hash_format
    CHECK (passport_hash IS NULL OR passport_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT instrument_suspension_origin_consistent
    CHECK (
      (status = 'SUSPENDED' AND suspended_from_status IS NOT NULL)
      OR (status <> 'SUSPENDED' AND suspended_from_status IS NULL)
    ),
  ADD CONSTRAINT instrument_suspension_origin_valid
    CHECK (suspended_from_status IS NULL OR suspended_from_status NOT IN ('SUSPENDED', 'DEFAULT'));

CREATE TABLE instrument_passport_versions (
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  version bigint NOT NULL,
  passport jsonb NOT NULL,
  review_state varchar(24) NOT NULL DEFAULT 'DRAFT',
  passport_hash varchar(71),
  submission_note varchar(2000),
  submitted_at timestamptz,
  published_at timestamptz,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, version),
  CONSTRAINT instrument_passport_version_positive CHECK (version > 0),
  CONSTRAINT instrument_passport_object CHECK (jsonb_typeof(passport) = 'object'),
  CONSTRAINT instrument_passport_review_state_valid CHECK (
    review_state IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED')
  ),
  CONSTRAINT instrument_passport_hash_format CHECK (
    passport_hash IS NULL OR passport_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT instrument_passport_submission_consistent CHECK (
    (review_state = 'DRAFT' AND passport_hash IS NULL AND submitted_at IS NULL)
    OR (review_state <> 'DRAFT' AND passport_hash IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  CONSTRAINT instrument_passport_created_by_not_blank CHECK (btrim(created_by) <> ''),
  CONSTRAINT instrument_passport_submission_note_length CHECK (
    submission_note IS NULL OR length(submission_note) <= 2000
  )
);

CREATE INDEX instrument_passport_versions_review_idx
  ON instrument_passport_versions (instrument_id, review_state, version DESC);
CREATE INDEX instrument_passport_versions_public_idx
  ON instrument_passport_versions (instrument_id, published_at DESC)
  WHERE published_at IS NOT NULL;

CREATE TABLE instrument_review_decisions (
  id bigserial PRIMARY KEY,
  instrument_id uuid NOT NULL,
  passport_version bigint NOT NULL,
  operator_id varchar(128) NOT NULL,
  decision varchar(24) NOT NULL,
  internal_comment varchar(4000) NOT NULL,
  correlation_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instrument_id, passport_version)
    REFERENCES instrument_passport_versions (instrument_id, version),
  CONSTRAINT instrument_review_operator_not_blank CHECK (btrim(operator_id) <> ''),
  CONSTRAINT instrument_review_decision_valid CHECK (
    decision IN ('APPROVE', 'REJECT', 'RETURN_FOR_REVISION')
  ),
  CONSTRAINT instrument_review_comment_not_blank CHECK (btrim(internal_comment) <> '')
);

CREATE UNIQUE INDEX instrument_review_unique_approval_idx
  ON instrument_review_decisions (instrument_id, passport_version, operator_id)
  WHERE decision = 'APPROVE';
CREATE INDEX instrument_review_version_idx
  ON instrument_review_decisions (instrument_id, passport_version, decided_at, id);

CREATE TABLE instrument_status_transitions (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  instrument_id uuid NOT NULL REFERENCES instrument (id),
  passport_version bigint,
  from_status instrument_status NOT NULL,
  to_status instrument_status NOT NULL,
  actor varchar(128) NOT NULL,
  reason varchar(2000) NOT NULL,
  correlation_id uuid NOT NULL,
  source_event_id uuid UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instrument_status_transition_actor_not_blank CHECK (btrim(actor) <> ''),
  CONSTRAINT instrument_status_transition_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT instrument_status_transition_changes_status CHECK (from_status <> to_status),
  CONSTRAINT instrument_status_transition_version_positive CHECK (
    passport_version IS NULL OR passport_version > 0
  )
);

CREATE INDEX instrument_status_transitions_instrument_idx
  ON instrument_status_transitions (instrument_id, id);

-- migrate:down

DROP TABLE IF EXISTS instrument_status_transitions;
DROP TABLE IF EXISTS instrument_review_decisions;
DROP TABLE IF EXISTS instrument_passport_versions;

ALTER TABLE instrument
  DROP CONSTRAINT instrument_suspension_origin_valid,
  DROP CONSTRAINT instrument_suspension_origin_consistent,
  DROP CONSTRAINT instrument_passport_hash_format,
  DROP COLUMN suspended_from_status,
  DROP COLUMN passport_hash;
