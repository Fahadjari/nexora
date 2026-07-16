/**
 * The permission catalogue.
 *
 * Permissions are strings shaped `resource:action`. Roles hold an array of
 * them, so an owner can compose any role they like without a schema change —
 * "Warehouse Supervisor who can also see invoices" is a checkbox, not a
 * migration.
 *
 * Adding a module means adding its permissions here and nowhere else: the
 * seeded roles, the settings UI and the guard all read from this file.
 */
export const PERMISSIONS = {
  // --- Workspace ---
  TENANT_READ: 'tenant:read',
  TENANT_UPDATE: 'tenant:update',
  TENANT_BILLING: 'tenant:billing',

  // --- People & access ---
  MEMBER_READ: 'member:read',
  MEMBER_INVITE: 'member:invite',
  MEMBER_UPDATE: 'member:update',
  MEMBER_REMOVE: 'member:remove',
  ROLE_READ: 'role:read',
  ROLE_MANAGE: 'role:manage',

  // --- Audit ---
  AUDIT_READ: 'audit:read',

  // --- CRM ---
  LEAD_READ: 'crm.lead:read',
  LEAD_CREATE: 'crm.lead:create',
  LEAD_UPDATE: 'crm.lead:update',
  LEAD_DELETE: 'crm.lead:delete',
  LEAD_ASSIGN: 'crm.lead:assign',

  CUSTOMER_READ: 'crm.customer:read',
  CUSTOMER_CREATE: 'crm.customer:create',
  CUSTOMER_UPDATE: 'crm.customer:update',
  CUSTOMER_DELETE: 'crm.customer:delete',

  CONTACT_READ: 'crm.contact:read',
  CONTACT_CREATE: 'crm.contact:create',
  CONTACT_UPDATE: 'crm.contact:update',
  CONTACT_DELETE: 'crm.contact:delete',

  DEAL_READ: 'crm.deal:read',
  DEAL_CREATE: 'crm.deal:create',
  DEAL_UPDATE: 'crm.deal:update',
  DEAL_DELETE: 'crm.deal:delete',

  PIPELINE_READ: 'crm.pipeline:read',
  PIPELINE_MANAGE: 'crm.pipeline:manage',

  ACTIVITY_READ: 'crm.activity:read',
  ACTIVITY_CREATE: 'crm.activity:create',
  ACTIVITY_UPDATE: 'crm.activity:update',
  ACTIVITY_DELETE: 'crm.activity:delete',

  // --- AI ---
  AI_CHAT: 'ai:chat',
  AI_INSIGHTS: 'ai:insights',
  /** Lets a user trigger scoring/agent runs by hand, which costs tokens. */
  AI_RUN_AGENT: 'ai:run_agent',

  // --- Reporting ---
  REPORT_READ: 'report:read',
  REPORT_EXPORT: 'report:export',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Grants everything. Held by owners; never assign it to a custom role by hand. */
export const WILDCARD_PERMISSION = '*';

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * Convenience bundles used when seeding a workspace's default roles. A tenant
 * can edit any of these afterwards — they are a starting point, not a schema.
 */
const CRM_READ_ONLY: Permission[] = [
  PERMISSIONS.LEAD_READ,
  PERMISSIONS.CUSTOMER_READ,
  PERMISSIONS.CONTACT_READ,
  PERMISSIONS.DEAL_READ,
  PERMISSIONS.PIPELINE_READ,
  PERMISSIONS.ACTIVITY_READ,
];

const CRM_FULL: Permission[] = [
  ...CRM_READ_ONLY,
  PERMISSIONS.LEAD_CREATE,
  PERMISSIONS.LEAD_UPDATE,
  PERMISSIONS.LEAD_DELETE,
  PERMISSIONS.LEAD_ASSIGN,
  PERMISSIONS.CUSTOMER_CREATE,
  PERMISSIONS.CUSTOMER_UPDATE,
  PERMISSIONS.CUSTOMER_DELETE,
  PERMISSIONS.CONTACT_CREATE,
  PERMISSIONS.CONTACT_UPDATE,
  PERMISSIONS.CONTACT_DELETE,
  PERMISSIONS.DEAL_CREATE,
  PERMISSIONS.DEAL_UPDATE,
  PERMISSIONS.DEAL_DELETE,
  PERMISSIONS.ACTIVITY_CREATE,
  PERMISSIONS.ACTIVITY_UPDATE,
  PERMISSIONS.ACTIVITY_DELETE,
];

export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}

/**
 * The roles every new workspace starts with. Seeded per tenant and marked
 * `isSystem`, so they can be copied but not deleted out from under a user who
 * still holds one.
 */
export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control of the workspace, including billing and deletion.',
    permissions: [WILDCARD_PERMISSION],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Everything an owner can do except billing and workspace deletion.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.TENANT_BILLING),
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs a team: full CRM access, plus reporting and audit visibility.',
    permissions: [
      ...CRM_FULL,
      PERMISSIONS.PIPELINE_MANAGE,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.AI_CHAT,
      PERMISSIONS.AI_INSIGHTS,
      PERMISSIONS.AI_RUN_AGENT,
    ],
  },
  {
    key: 'sales_executive',
    name: 'Sales Executive',
    description: 'Works leads and deals. Cannot delete records or manage the pipeline.',
    permissions: [
      ...CRM_READ_ONLY,
      PERMISSIONS.LEAD_CREATE,
      PERMISSIONS.LEAD_UPDATE,
      PERMISSIONS.CUSTOMER_CREATE,
      PERMISSIONS.CUSTOMER_UPDATE,
      PERMISSIONS.CONTACT_CREATE,
      PERMISSIONS.CONTACT_UPDATE,
      PERMISSIONS.DEAL_CREATE,
      PERMISSIONS.DEAL_UPDATE,
      PERMISSIONS.ACTIVITY_CREATE,
      PERMISSIONS.ACTIVITY_UPDATE,
      PERMISSIONS.AI_CHAT,
      PERMISSIONS.AI_INSIGHTS,
    ],
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Read-only view of the CRM. The safe default for a new hire.',
    permissions: [...CRM_READ_ONLY, PERMISSIONS.AI_CHAT],
  },
];
