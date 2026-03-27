-- Normalize company membership roles to viewer | operator | admin (SPEC §5.2.1).
UPDATE company_memberships SET membership_role = 'admin' WHERE membership_role = 'owner';
UPDATE company_memberships SET membership_role = 'operator' WHERE membership_role = 'member' OR membership_role IS NULL;
UPDATE company_memberships SET membership_role = 'operator' WHERE membership_role NOT IN ('viewer', 'operator', 'admin');

ALTER TABLE company_memberships
  ALTER COLUMN membership_role SET DEFAULT 'operator',
  ALTER COLUMN membership_role SET NOT NULL;

ALTER TABLE company_memberships ADD CONSTRAINT company_memberships_membership_role_chk
  CHECK (membership_role IN ('viewer', 'operator', 'admin'));

-- Ensure each agent has a company membership so board REST + permission checks stay consistent.
INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role, created_at, updated_at)
SELECT a.company_id, 'agent', a.id, 'active', 'operator', now(), now()
FROM agents a
WHERE NOT EXISTS (
  SELECT 1 FROM company_memberships m
  WHERE m.company_id = a.company_id AND m.principal_type = 'agent' AND m.principal_id = a.id
);
