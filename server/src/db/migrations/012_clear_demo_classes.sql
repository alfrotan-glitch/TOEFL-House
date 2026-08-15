-- Remove leftover demo classes (hard-coded catalog leftovers)
DELETE FROM class_teacher_skills WHERE class_id IN (
  SELECT id FROM classes WHERE level IN (
    'Pre-TOEFL', 'TOEFL Preparation', 'IELTS', 'IELTS Preparation', 'General English',
    'Pre-TOEFL Level 1 & 2', 'TOEFL iBT Complete Prep', 'IELTS Masterclass', 'General English (DEL/CEL)'
  )
);
DELETE FROM sessions WHERE class_id IN (
  SELECT id FROM classes WHERE level IN (
    'Pre-TOEFL', 'TOEFL Preparation', 'IELTS', 'IELTS Preparation', 'General English',
    'Pre-TOEFL Level 1 & 2', 'TOEFL iBT Complete Prep', 'IELTS Masterclass', 'General English (DEL/CEL)'
  )
);
DELETE FROM classes WHERE level IN (
  'Pre-TOEFL', 'TOEFL Preparation', 'IELTS', 'IELTS Preparation', 'General English',
  'Pre-TOEFL Level 1 & 2', 'TOEFL iBT Complete Prep', 'IELTS Masterclass', 'General English (DEL/CEL)'
);
