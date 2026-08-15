-- Clear seeded demo teachers so each branch manages its own real roster.
-- Safe on DBs that never had these rows.

UPDATE classes SET teacher_id = NULL WHERE teacher_id IN ('t1','t2','t3');
UPDATE sessions SET teacher_id = NULL WHERE teacher_id IN ('t1','t2','t3');
UPDATE users SET linked_teacher_id = NULL WHERE linked_teacher_id IN ('t1','t2','t3');
DELETE FROM class_teacher_skills WHERE teacher_id IN ('t1','t2','t3');
DELETE FROM teacher_evaluations WHERE teacher_id IN ('t1','t2','t3');
DELETE FROM teachers WHERE id IN ('t1','t2','t3');
-- Optional demo teacher login was only useful with demo teacher rows
DELETE FROM users WHERE id = 'usr_teacher1' OR username = 'farid.ahmadi';
