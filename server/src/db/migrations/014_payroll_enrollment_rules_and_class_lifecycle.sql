-- Class lifecycle: activation date (Gregorian ISO date YYYY-MM-DD)
ALTER TABLE classes ADD COLUMN activation_date TEXT;

-- Payroll rules: enrollment-based salary multipliers (Rule Engine)
-- JSON uses doubled single-quotes for SQL string literals.

INSERT INTO rule_definitions (
  id, name, description, category, conditions, actions, priority, is_active,
  scope_branch_id, version, last_modified_by, last_modified_at, created_at
)
SELECT
  'rule_pay_full_12',
  'Class payroll full rate (>=12 enrolled)',
  'When a class has 12 or more active students, teacher pay for that class skills is paid at 100 percent.',
  'payroll',
  '[{"field":"enrolledCount","operator":"gte","value":12}]',
  '[{"type":"set_value","targetKey":"payrollMultiplier","value":1},{"type":"set_value","targetKey":"payrollTier","value":"full"}]',
  400,
  1,
  NULL,
  1,
  'system',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM rule_definitions WHERE name = 'Class payroll full rate (>=12 enrolled)'
);

INSERT INTO rule_definitions (
  id, name, description, category, conditions, actions, priority, is_active,
  scope_branch_id, version, last_modified_by, last_modified_at, created_at
)
SELECT
  'rule_pay_90_10',
  'Class payroll 90 percent (10-11 enrolled)',
  'When enrolled count is 10 or 11, teacher class or skill pay is multiplied by 0.9.',
  'payroll',
  '[{"field":"enrolledCount","operator":"between","value":null,"rangeValue":[10,11]}]',
  '[{"type":"set_value","targetKey":"payrollMultiplier","value":0.9},{"type":"set_value","targetKey":"payrollTier","value":"tier_90"}]',
  390,
  1,
  NULL,
  1,
  'system',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM rule_definitions WHERE name = 'Class payroll 90 percent (10-11 enrolled)'
);

INSERT INTO rule_definitions (
  id, name, description, category, conditions, actions, priority, is_active,
  scope_branch_id, version, last_modified_by, last_modified_at, created_at
)
SELECT
  'rule_pay_80_8',
  'Class payroll 80 percent (8-9 enrolled)',
  'When enrolled count is 8 or 9, teacher class or skill pay is multiplied by 0.8.',
  'payroll',
  '[{"field":"enrolledCount","operator":"between","value":null,"rangeValue":[8,9]}]',
  '[{"type":"set_value","targetKey":"payrollMultiplier","value":0.8},{"type":"set_value","targetKey":"payrollTier","value":"tier_80"}]',
  380,
  1,
  NULL,
  1,
  'system',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM rule_definitions WHERE name = 'Class payroll 80 percent (8-9 enrolled)'
);

INSERT INTO rule_definitions (
  id, name, description, category, conditions, actions, priority, is_active,
  scope_branch_id, version, last_modified_by, last_modified_at, created_at
)
SELECT
  'rule_pay_70_5',
  'Class payroll 70 percent (5-7 enrolled)',
  'When enrolled count is 5 to 7, teacher class or skill pay is multiplied by 0.7.',
  'payroll',
  '[{"field":"enrolledCount","operator":"between","value":null,"rangeValue":[5,7]}]',
  '[{"type":"set_value","targetKey":"payrollMultiplier","value":0.7},{"type":"set_value","targetKey":"payrollTier","value":"tier_70"}]',
  370,
  1,
  NULL,
  1,
  'system',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM rule_definitions WHERE name = 'Class payroll 70 percent (5-7 enrolled)'
);

INSERT INTO rule_definitions (
  id, name, description, category, conditions, actions, priority, is_active,
  scope_branch_id, version, last_modified_by, last_modified_at, created_at
)
SELECT
  'rule_pay_below_min',
  'Class payroll below minimum (under 5 enrolled)',
  'Below 5 enrolled students, class skill pay is reduced to 50 percent and a merge warning is issued.',
  'payroll',
  '[{"field":"enrolledCount","operator":"lt","value":5}]',
  '[{"type":"set_value","targetKey":"payrollMultiplier","value":0.5},{"type":"set_value","targetKey":"payrollTier","value":"below_min"},{"type":"warn","targetKey":"classSizeWarning","message":"Class is below 5 students. Prefer merge. Reduced payroll multiplier 0.5 applies."}]',
  360,
  1,
  NULL,
  1,
  'system',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM rule_definitions WHERE name = 'Class payroll below minimum (under 5 enrolled)'
);
