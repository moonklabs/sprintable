// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import type {
  InboxItem,
  CreateInboxItemInput,
  ResolveInboxItemInput,
  DismissInboxItemInput,
  ReassignInboxItemInput,
  InboxKind,
  OriginNode,
  InboxOption,
} from '@sprintable/core-storage';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isOssMode, createInboxItemRepository } from '@/lib/storage/factory';
import { createInboxItemSchema, originChainSchema, inboxOptionsSchema } from '@sprintable/shared';

// Operator Cockpit Phase A — high-level service for producers
// Producers: agent_runs lifecycle hook, memo @mention emit, /api/inbox/incoming webhook.
// Each producer constructs CreateInboxItemInput and calls InboxItemService.create().

export interface ProduceApprovalArgs {
  org_id: string;
  project_id: string;
  assignee_member_id: string;
  title: string;
  context?: string | null;
  agent_summary?: string | null;
  origin_chain?: OriginNode[];
  options?: InboxOption[];
  after_decision?: string | null;
  from_agent_id?: string | null;
  story_id?: string | null;
  memo_id?: string | null;
  source_id: string;
  priority?: 'high' | 'normal';
}

export class InboxItemService {
  constructor(private readonly supabase?: SupabaseClient) {}

  /**
   * Create new inbox_item. Idempotent on (org_id, source_type, source_id, kind).
   * Validates origin_chain + options via Zod before insert.
   */
  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    // Validate at single boundary point (codex tactical fix #10 — Zod at write time)
    const validated = createInboxItemSchema.parse(input);
    const repo = await createInboxItemRepository(this.supabase ?? createSupabaseAdminClient());
    return repo.create(validated);
  }

  /**
   * Convenience producer: agent_run completion → approval inbox item.
   * Used by agent_runs lifecycle hook in apps/web/src/services/agent-runs.ts.
   */
  async produceApprovalFromAgentRun(args: ProduceApprovalArgs & { run_id: string }): Promise<InboxItem> {
    return this.create({
      ...args,
      kind: 'approval',
      source_type: 'agent_run',
      source_id: args.run_id,
      origin_chain: args.origin_chain ?? [{ type: 'run', id: args.run_id }],
      priority: args.priority ?? 'normal',
    });
  }

  /**
   * Convenience producer: memo @mention → mention inbox item.
   */
  async produceMentionFromMemo(args: ProduceApprovalArgs & { memo_id: string }): Promise<InboxItem> {
    return this.create({
      ...args,
      kind: 'mention',
      source_type: 'memo_mention',
      source_id: `${args.memo_id}:${args.assignee_member_id}`,
      memo_id: args.memo_id,
      origin_chain: args.origin_chain ?? [{ type: 'memo', id: args.memo_id }],
      priority: args.priority ?? 'normal',
    });
  }

  private async getRepo() {
    return createInboxItemRepository(isOssMode() ? undefined : this.supabase);
  }

  /**
   * resolve — assignee 본인 또는 admin이 호출. RLS가 권한 검증.
   * @throws NotFoundError, error with code 23514 if already resolved.
   */
  async resolve(id: string, orgId: string, input: ResolveInboxItemInput): Promise<InboxItem> {
    const repo = await this.getRepo();
    return repo.resolve(id, orgId, input);
  }

  async dismiss(id: string, orgId: string, input: DismissInboxItemInput): Promise<InboxItem> {
    const repo = await this.getRepo();
    return repo.dismiss(id, orgId, input);
  }

  async reassign(id: string, orgId: string, input: ReassignInboxItemInput): Promise<InboxItem> {
    const repo = await this.getRepo();
    return repo.reassign(id, orgId, input);
  }
}

/**
 * HMAC verification for /api/inbox/incoming webhook.
 * Phase A v1: shared secret via AGENT_INBOX_HMAC_SECRET env. Phase B: per-agent rotation.
 */
export async function verifyIncomingHmac(request: Request, rawBody: string): Promise<boolean> {
  const secret = process.env['AGENT_INBOX_HMAC_SECRET'];
  if (!secret) return false; // 안전한 기본 — secret 미설정 시 모두 거부

  const signature = request.headers.get('x-sprintable-signature');
  if (!signature) return false;

  const { createHmac, timingSafeEqual } = await import('crypto');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Re-export Zod schemas for convenience at API route layer.
 */
export { originChainSchema, inboxOptionsSchema };

/** Type alias for callers. */
export type { InboxKind, OriginNode, InboxOption };
