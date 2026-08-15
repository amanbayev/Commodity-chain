-- migrate:up

ALTER TABLE instrument ADD COLUMN issuer_id varchar(128);

UPDATE instrument AS i
SET issuer_id = COALESCE(
  (
    SELECT ipv.created_by
    FROM instrument_passport_versions AS ipv
    WHERE ipv.instrument_id = i.id
    ORDER BY ipv.version
    LIMIT 1
  ),
  'system:legacy'
);

ALTER TABLE instrument
  ALTER COLUMN issuer_id SET DEFAULT 'system:legacy',
  ALTER COLUMN issuer_id SET NOT NULL,
  ADD CONSTRAINT instrument_issuer_id_not_blank CHECK (btrim(issuer_id) <> '');

CREATE INDEX instrument_issuer_created_idx ON instrument (issuer_id, created_at DESC, id DESC);

-- migrate:down

DROP INDEX IF EXISTS instrument_issuer_created_idx;
ALTER TABLE instrument DROP COLUMN issuer_id;
