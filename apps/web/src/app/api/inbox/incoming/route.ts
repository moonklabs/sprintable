import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createInboxItemRepository } from '@/lib/storage/factory';
import { incomingInboxItemSchema } from '@sprintable/shared';
import { verifyIncomingHmac } from '@/services/inbox-item.service';

/**
 * POST /api/inbox/incoming
 *
 * External agents push HITL requests via this endpoint. v1: HMAC-SHA256 with
 * shared secret AGENT_INBOX_HMAC_SECRET. Phase B: per-agent rotation.
 *
 * Headers:
 *   - x-sprintable-signature: hex-encoded HMAC of raw body
 *   - x-sprintable-org-id: target org_id (since shared secret can't bind agent → org)
 *
 * Body: matches incomingInboxItemSchema (project_id, assignee_member_id, kind, ...).
 */
export async function POST(request: Request) {
  try {
    const orgIdHeader = request.headers.get('x-sprintable-org-id');
    if (!orgIdHeader) return ApiErrors.badRequest('x-sprintable-org-id header required');

    // Read raw body for HMAC, then parse JSON manually (parseBody consumes body)
    const rawBody = await request.text();
    const verified = await verifyIncomingHmac(request, rawBody);
    if (!verified) return ApiErrors.unauthorized();

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(rawBody);
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const result = incomingInboxItemSchema.safeParse(parsedRaw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return ApiErrors.validationFailed(issues);
    }

    const repo = await createInboxItemRepository();

    const item = await repo.create({
      org_id: orgIdHeader,
      project_id: result.data.project_id,
      assignee_member_id: result.data.assignee_member_id,
      kind: result.data.kind,
      title: result.data.title,
      context: result.data.context ?? null,
      agent_summary: result.data.agent_summary ?? null,
      origin_chain: result.data.origin_chain,
      options: result.data.options,
      after_decision: result.data.after_decision ?? null,
      from_agent_id: result.data.from_agent_id ?? null,
      story_id: result.data.story_id ?? null,
      memo_id: result.data.memo_id ?? null,
      priority: result.data.priority,
      source_type: 'webhook',
      source_id: result.data.source_id,
    });

    return apiSuccess(item, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
