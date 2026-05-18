import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerMemosTools(server: McpServer) {
  server.tool('list_memos', 'List memos', {
    project_id: z.string().optional().describe('Project ID'),
    assigned_to: z.string().optional().describe('Filter by assigned team member ID'),
    status: z.string().optional().describe('Filter by status (open/resolved)'),
    q: z.string().optional().describe('Search query'),
    include_archived: z.boolean().optional().describe('Include archived memos (default: false)'),
  }, async ({ project_id, assigned_to, status, q, include_archived }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (assigned_to) params.set('assigned_to', assigned_to);
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      if (include_archived) params.set('include_archived', 'true');
      const qs = params.toString();
      const data = await pmApi(`/api/v2/memos${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('create_memo', 'Create memo', {
    project_id: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    memo_type: z.string().optional(),
    assigned_to: z.string().optional().describe('Team member ID to assign'),
    story_id: z.string().optional(),
  }, async (body) => {
    try {
      const data = await pmApi('/api/v2/memos', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  // [DEPRECATED] send_memo — /api/v2/memos POST로 라우팅 (웹훅 발송 경로 복원, S-B2 버그 수정).
  // 기존 에이전트 호환성 유지. 스프린터블 운영이 send_memo 없이 검증된 후 제거 예정.
  server.tool('send_memo', '[DEPRECATED] Send a memo. Routes to /api/v2/memos which fires webhooks to assigned members. Will be removed after memo-free sprint operation is validated.', {
    project_id: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    memo_type: z.string().optional(),
    assigned_to: z.string().optional().describe('Single team member ID (legacy, use assigned_to_ids for multiple)'),
    assigned_to_ids: z.array(z.string()).optional().describe('Team member IDs to assign (supports multiple assignees)'),
    trigger_type: z.string().optional().describe('Workflow stage (kickoff, qa_request, review, merge_request)'),
  }, async ({ assigned_to, assigned_to_ids, project_id, content, title, memo_type, trigger_type }) => {
    try {
      const body: Record<string, unknown> = {
        content,
        title: title ?? '(memo)',
        project_id: project_id ?? '',
        assigned_to,
        assigned_to_ids,
        memo_type,
      };
      if (trigger_type) {
        body.memo_metadata = { trigger_type };
      }
      const data = await pmApi('/api/v2/memos', { method: 'POST', body: JSON.stringify(body) }) as Record<string, unknown>;
      return ok({ ...data, deprecated: true, trigger_type });
    } catch (e) { return handleError(e); }
  });

  server.tool('list_my_memos', 'List memos assigned to or created by a member', {
    assigned_to: z.string().optional().describe('Filter by assigned team member ID'),
    created_by: z.string().optional().describe('Filter by creator team member ID'),
    project_id: z.string().optional(),
    status: z.string().optional(),
  }, async ({ assigned_to, created_by, project_id, status }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (assigned_to) params.set('assigned_to', assigned_to);
      if (created_by) params.set('created_by', created_by);
      if (status) params.set('status', status);
      const qs = params.toString();
      const data = await pmApi(`/api/v2/memos${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  // AC6: read_memo — conversation 우선, 없으면 memos fallback
  server.tool('read_memo', 'Read memo with replies (reads from conversation if migrated)', {
    memo_id: z.string().describe('Memo ID (also accepts conversation ID)'),
  }, async ({ memo_id }) => {
    try {
      // conversation 존재 여부 확인
      try {
        const msgs = await pmApi(`/api/v2/conversations/${encodeURIComponent(memo_id)}/messages`) as Record<string, unknown>;
        const convData = { id: memo_id, conversation_id: memo_id, replies: msgs };
        return ok(convData);
      } catch {
        // fallback to memos API
      }
      const data = await pmApi(`/api/v2/memos/${encodeURIComponent(memo_id)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  // [DEPRECATED] reply_memo — 내부적으로 conversation thread reply로 라우팅됨 (S-B2).
  server.tool('reply_memo', '[DEPRECATED] Reply to a memo. Internally routes to conversation thread reply. Will be removed after memo-free sprint operation is validated.', {
    memo_id: z.string(),
    content: z.string(),
    assigned_to: z.string().optional().describe('Single team member ID to explicitly notify via webhook (legacy, use assigned_to_ids for multiple)'),
    assigned_to_ids: z.array(z.string()).optional().describe('Team member IDs to explicitly notify via webhook on this reply'),
  }, async ({ memo_id, content, assigned_to, assigned_to_ids }) => {
    try {
      // AC4: memo_id = conversation_id (S-B1 패턴). top-level root message 조회 → thread reply 생성
      let rootMsgId: string | undefined;
      try {
        // pmApi already unwraps {data: [...]} → returns array directly
        const msgs = await pmApi(`/api/v2/conversations/${encodeURIComponent(memo_id)}/messages?limit=1`) as Array<Record<string, unknown>>;
        rootMsgId = msgs[0]?.id as string | undefined;
      } catch {
        // conversation 없음 → 기존 memos API fallback
      }

      if (rootMsgId) {
        // conversation thread reply
        const resolvedIds = assigned_to_ids ?? (assigned_to ? [assigned_to] : undefined);
        const msgPayload: Record<string, unknown> = { content, thread_id: rootMsgId };
        if (resolvedIds) msgPayload.mentioned_ids = resolvedIds;
        const msg = await pmApi(`/api/v2/conversations/${encodeURIComponent(memo_id)}/messages`, {
          method: 'POST', body: JSON.stringify(msgPayload),
        }) as Record<string, unknown>;
        const msgData = (msg.data ?? msg) as Record<string, unknown>;
        return ok({ memo_id, conversation_id: memo_id, message_id: msgData.id, deprecated: true });
      }

      // fallback: 기존 memos reply API
      const resolvedIds = assigned_to_ids ?? (assigned_to ? [assigned_to] : undefined);
      const payload: Record<string, unknown> = { content };
      if (resolvedIds) payload.assigned_to_ids = resolvedIds;
      const data = await pmApi(`/api/v2/memos/${encodeURIComponent(memo_id)}/replies`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('resolve_memo', 'Resolve a memo', {
    memo_id: z.string(),
  }, async ({ memo_id }) => {
    try {
      const data = await pmApi(`/api/v2/memos/${encodeURIComponent(memo_id)}/resolve`, {
        method: 'PATCH',
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  // AC7: send_chat_message — optional thread_id(reply), message_type, review_type, metadata 추가
  server.tool('send_chat_message', 'Send a chat message to a thread (conversation). Triggers real-time SSE delivery to all participants.', {
    thread_id: z.string().describe('Conversation/Thread ID (memo ID = conversation ID)'),
    content: z.string().describe('Message content'),
    reply_thread_id: z.string().optional().describe('Optional: message ID to reply to within the thread (creates sub-thread)'),
    message_type: z.string().optional().describe('Optional: message type hint (e.g. kickoff, qa, review)'),
    review_type: z.string().optional().describe('Optional: review type (approve, request_changes, comment)'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional: extra metadata attached to the message'),
  }, async ({ thread_id, content, reply_thread_id, message_type, review_type, metadata }) => {
    try {
      const payload: Record<string, unknown> = { content };
      if (reply_thread_id) payload.thread_id = reply_thread_id;
      if (message_type || review_type || metadata) {
        payload.metadata = { ...(metadata ?? {}), ...(message_type ? { message_type } : {}), ...(review_type ? { review_type } : {}) };
      }
      const data = await pmApi(`/api/v2/conversations/${encodeURIComponent(thread_id)}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  // CB-S11: create_conversation — memo 우회 없이 직접 대화 스레드 생성
  server.tool('create_conversation', 'Create a new conversation thread. Returns conversation_id for use with send_chat_message / list_chat_messages.', {
    participant_ids: z.array(z.string()).describe('Team member IDs to include in the conversation'),
    title: z.string().optional().describe('Optional conversation title'),
    project_id: z.string().optional().describe('Project ID (required by backend; use current project if omitted)'),
  }, async ({ participant_ids, title, project_id }) => {
    try {
      const payload: Record<string, unknown> = {
        type: 'group',
        participant_ids,
        project_id: project_id ?? '',
      };
      if (title) payload.title = title;
      const conv = await pmApi('/api/v2/conversations', { method: 'POST', body: JSON.stringify(payload) }) as Record<string, unknown>;
      return ok({ conversation_id: conv.id as string, ...conv });
    } catch (e) { return handleError(e); }
  });

  // S41: conversations API로 라우팅 전환
  server.tool('list_chat_messages', 'List chat messages in a thread (conversation, chronological order)', {
    thread_id: z.string().describe('Thread ID (memo ID = conversation ID)'),
    limit: z.number().optional().describe('Max messages (default: 30)'),
    before: z.string().optional().describe('Cursor: ISO timestamp, fetch messages before this time'),
  }, async ({ thread_id, limit, before }) => {
    try {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (before !== undefined) params.set('before', before);
      const data = await pmApi(`/api/v2/conversations/${encodeURIComponent(thread_id)}/messages?${params.toString()}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
