import { z } from 'zod/v4';

// Operator Cockpit Phase A — inbox_items + outbox schemas
// See .omc/plans/2026-04-26-01-operator-cockpit-redesign.md

// ─── origin_chain ────────────────────────────────────
// typed array of {type, id} — DB는 referential integrity 보장 안 함, 여기서 검증.
export const ORIGIN_NODE_TYPES = ['memo', 'story', 'run', 'initiative'] as const;

export const originNodeSchema = z.object({
  type: z.enum(ORIGIN_NODE_TYPES),
  id: z.string().trim().min(1),
});

export const originChainSchema = z.array(originNodeSchema);

// ─── options[] ────────────────────────────────────
// Each option carries its own stable id (uuid) so resolved_option_id stays valid
// even if label/kind changes.
export const OPTION_KINDS = ['approve', 'approve-alt', 'reassign', 'changes'] as const;

export const inboxOptionSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  kind: z.enum(OPTION_KINDS),
  consequence: z.string().min(1),
});

export const inboxOptionsSchema = z.array(inboxOptionSchema);

// ─── inbox_items ────────────────────────────────────
export const INBOX_KINDS = ['approval', 'decision', 'blocker', 'mention'] as const;
export const INBOX_PRIORITIES = ['high', 'normal'] as const;
export const INBOX_STATES = ['pending', 'resolved', 'dismissed'] as const;
export const INBOX_SOURCE_TYPES = ['agent_run', 'memo_mention', 'webhook', 'manual'] as const;

export const createInboxItemSchema = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  assignee_member_id: z.string().min(1),
  kind: z.enum(INBOX_KINDS),
  title: z.string().min(1).max(200),
  context: z.string().max(2000).optional().nullable(),
  agent_summary: z.string().max(2000).optional().nullable(),
  origin_chain: originChainSchema.default([]),
  options: inboxOptionsSchema.default([]),
  after_decision: z.string().max(500).optional().nullable(),
  from_agent_id: z.string().optional().nullable(),
  story_id: z.string().optional().nullable(),
  memo_id: z.string().optional().nullable(),
  priority: z.enum(INBOX_PRIORITIES).optional().default('normal'),
  source_type: z.enum(INBOX_SOURCE_TYPES),
  source_id: z.string().min(1),
});

export const resolveInboxItemSchema = z.object({
  choice: z.string().uuid(), // option.id
  note: z.string().max(1000).optional().nullable(),
});

export const dismissInboxItemSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
});

export const inboxListQuerySchema = z.object({
  kind: z.enum(INBOX_KINDS).optional(),
  state: z.enum(INBOX_STATES).optional().default('pending'),
  project_id: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

// ─── webhook incoming ────────────────────────────────
// External agents POST to /api/inbox/incoming with HMAC.
// Subset of createInboxItemSchema — agent doesn't need to specify org_id (HMAC keys are scoped).
export const incomingInboxItemSchema = z.object({
  project_id: z.string().min(1),
  assignee_member_id: z.string().min(1),
  kind: z.enum(INBOX_KINDS),
  title: z.string().min(1).max(200),
  context: z.string().max(2000).optional().nullable(),
  agent_summary: z.string().max(2000).optional().nullable(),
  origin_chain: originChainSchema.default([]),
  options: inboxOptionsSchema.default([]),
  after_decision: z.string().max(500).optional().nullable(),
  from_agent_id: z.string().optional().nullable(),
  story_id: z.string().optional().nullable(),
  memo_id: z.string().optional().nullable(),
  priority: z.enum(INBOX_PRIORITIES).optional().default('normal'),
  source_id: z.string().min(1), // external dedup key
});

// ─── outbox ────────────────────────────────────
export const OUTBOX_EVENT_TYPES = ['resolved', 'dismissed', 'reassigned'] as const;
export const OUTBOX_STATUSES = ['pending', 'in_flight', 'delivered', 'failed', 'dead'] as const;

// outbox payload shape — consumed by worker
export const outboxPayloadSchema = z.object({
  inbox_item_id: z.string().uuid(),
  event_type: z.enum(OUTBOX_EVENT_TYPES),
  inbox_item_snapshot: z.object({
    title: z.string(),
    kind: z.enum(INBOX_KINDS),
    project_id: z.string(),
    org_id: z.string(),
    options: inboxOptionsSchema,
    origin_chain: originChainSchema,
  }),
  resolved_choice: z.string().uuid().optional().nullable(),
  resolved_note: z.string().optional().nullable(),
  resolved_by: z.string().optional().nullable(),
  ts: z.string(), // ISO 8601
});

// Color hex regex (codex tactical fix #6 — stored CSS injection 방지)
export const colorHexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be 6-digit hex like #3385f8');

// agent_role enum (codex tactical fix #7)
export const AGENT_ROLES = ['backend', 'frontend', 'qa', 'design', 'pm', 'api'] as const;
export const agentRoleSchema = z.enum(AGENT_ROLES);

// Type exports for service / API consumers
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxState = (typeof INBOX_STATES)[number];
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];
export type InboxSourceType = (typeof INBOX_SOURCE_TYPES)[number];
export type OriginNode = z.infer<typeof originNodeSchema>;
export type OriginChain = z.infer<typeof originChainSchema>;
export type InboxOption = z.infer<typeof inboxOptionSchema>;
export type CreateInboxItemInput = z.infer<typeof createInboxItemSchema>;
export type ResolveInboxItemInput = z.infer<typeof resolveInboxItemSchema>;
export type IncomingInboxItemInput = z.infer<typeof incomingInboxItemSchema>;
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;
export type AgentRole = (typeof AGENT_ROLES)[number];
