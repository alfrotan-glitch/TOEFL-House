-- Class gender policy: female | male | mixed
ALTER TABLE classes ADD COLUMN gender_policy TEXT NOT NULL DEFAULT 'mixed'
  CHECK (gender_policy IN ('female','male','mixed'));

CREATE INDEX IF NOT EXISTS idx_classes_gender ON classes(branch_id, gender_policy, status);
