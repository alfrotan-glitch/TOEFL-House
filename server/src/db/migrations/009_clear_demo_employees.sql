-- Clear seeded demo employees so HR is real data only per branch.
UPDATE users SET linked_employee_id = NULL WHERE linked_employee_id IN ('emp1','emp2','emp3','emp4');
DELETE FROM employees WHERE id IN ('emp1','emp2','emp3','emp4');
