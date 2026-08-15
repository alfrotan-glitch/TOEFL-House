-- Class operational integrity: fast scoped lookups and duplicate-schedule protection.
CREATE INDEX IF NOT EXISTS idx_classes_branch_lifecycle_dates
  ON classes(branch_id, lifecycle_stage, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_classes_branch_teacher_dates
  ON classes(branch_id, teacher_id, time_slot_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_classes_branch_room_dates
  ON classes(branch_id, room_id, time_slot_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_enrollments_class_status_student
  ON enrollments(class_id, status, student_id);

-- A room/time-slot pair may host only one non-terminal class for overlapping dates.
-- We cannot encode interval overlap in a simple UNIQUE index, so application-level
-- conflict validation remains authoritative.
