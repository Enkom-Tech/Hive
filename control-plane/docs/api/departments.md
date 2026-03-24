---
title: Departments
summary: Department lifecycle and membership management
---

Departments are company-scoped organizational units used for assignment governance.

## List Departments

```
GET /api/companies/{companyId}/departments
```

Returns all departments for the company.

## Create Department

```
POST /api/companies/{companyId}/departments
{
  "name": "Engineering",
  "slug": "engineering"
}
```

Requires `departments:manage`.

## Update Department

```
PATCH /api/companies/{companyId}/departments/{departmentId}
{
  "name": "Product Engineering",
  "status": "active"
}
```

Requires `departments:manage`.

## Delete Department

```
DELETE /api/companies/{companyId}/departments/{departmentId}
```

Requires `departments:manage`. Membership rows for that department are removed first.

## List Department Memberships

```
GET /api/companies/{companyId}/departments/{departmentId}/memberships
GET /api/companies/{companyId}/departments/{departmentId}/memberships?principalType=agent&principalId=<id>
```

Returns membership rows (`principalType`, `principalId`, `isPrimary`, `status`).

## Upsert Department Membership

```
PUT /api/companies/{companyId}/departments/{departmentId}/memberships
{
  "principalType": "agent",
  "principalId": "agent-id",
  "isPrimary": false,
  "status": "active"
}
```

Requires `departments:assign_members`.

## Remove Department Membership

```
DELETE /api/companies/{companyId}/departments/{departmentId}/memberships?principalType=agent&principalId=<id>
```

Requires `departments:assign_members`.

## Issue Assignment Enforcement

When an issue has `departmentId` set:

- Assignment still requires `tasks:assign`
- Assignee must be an active member of that department
- `tasks:assign_scope` can bypass department matching
