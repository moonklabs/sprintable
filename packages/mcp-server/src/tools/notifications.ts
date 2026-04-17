import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerNotificationsTools(server: McpServer) {
  server.tool('check_notifications', 'Check notifications for authenticated agent', {
    unread: z.boolean().optional().describe('Filter unread only'),
    type: z.string().optional().describe('Notification type filter'),
    limit: z.number().optional(),
  }, async ({ unread, type, limit }) => {
    try {
      const params = new URLSearchParams();
      if (unread) params.set('unread', 'true');
      if (type) params.set('type', type);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const data = await pmApi(`/api/notifications${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('mark_notification_read', 'Mark a notification as read', {
    notification_id: z.string(),
    is_read: z.boolean().optional().describe('Read state (default: true)'),
  }, async ({ notification_id, is_read }) => {
    try {
      const data = await pmApi('/api/notifications', {
        method: 'PATCH',
        body: JSON.stringify({ id: notification_id, is_read: is_read ?? true }),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('mark_all_notifications_read', 'Mark all notifications as read', {
    type: z.string().optional().describe('Optional notification type filter'),
  }, async ({ type }) => {
    try {
      const data = await pmApi('/api/notifications', {
        method: 'PATCH',
        body: JSON.stringify({ markAllRead: true, ...(type ? { type } : {}) }),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
