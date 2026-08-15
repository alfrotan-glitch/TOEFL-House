-- One non-cancelled session per class at the same date + start time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_class_date_start_unique
  ON sessions (class_id, date, start_time)
  WHERE status IS NULL OR status != 'cancelled';
