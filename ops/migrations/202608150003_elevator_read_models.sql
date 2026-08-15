-- migrate:up

CREATE INDEX mock_ezr_receipts_elevator_status_updated_idx
  ON mock_ezr_receipts (elevator_id, status, updated_at DESC, receipt_id DESC);

CREATE INDEX redemption_orders_elevator_status_requested_idx
  ON redemption_orders (elevator_id, status, requested_date, id);

CREATE INDEX oracle_events_source_received_idx
  ON oracle_events (source_id, created_at DESC, id DESC);

-- migrate:down

DROP INDEX IF EXISTS oracle_events_source_received_idx;
DROP INDEX IF EXISTS redemption_orders_elevator_status_requested_idx;
DROP INDEX IF EXISTS mock_ezr_receipts_elevator_status_updated_idx;
