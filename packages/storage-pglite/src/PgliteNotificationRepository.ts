import type { PGlite } from '@electric-sql/pglite';
import type {
  INotificationRepository,
  Notification,
  CreateNotificationInput,
  NotificationListFilters,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | boolean | null;

function toPos(query: string, params: SqlParam[]): [string, SqlParam[]] {
  let i = 0;
  return [query.replace(/\?/g, () => `$${++i}`), params];
}

interface NotificationRow extends Omit<Notification, 'is_read'> {
  is_read: number;
}

function hydrate(row: NotificationRow): Notification {
  return { ...row, is_read: Boolean(row.is_read) };
}

export class PgliteNotificationRepository implements INotificationRepository {
  constructor(private readonly db: PGlite) {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(...toPos(`
      INSERT INTO notifications (id, org_id, user_id, type, title, body, is_read, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [
      id, input.org_id, input.user_id, input.type ?? 'info', input.title,
      input.body ?? null, input.reference_type ?? null, input.reference_id ?? null, now,
    ]));
    const row = (await this.db.query(...toPos('SELECT * FROM notifications WHERE id = ?', [id]))).rows[0] as NotificationRow | undefined;
    if (!row) throw new NotFoundError('Notification not found after insert');
    return hydrate(row);
  }

  async list(filters: NotificationListFilters): Promise<Notification[]> {
    let query = 'SELECT * FROM notifications WHERE user_id = ?';
    const params: SqlParam[] = [filters.user_id];
    if (filters.is_read != null) { query += ' AND is_read = ?'; params.push(filters.is_read ? 1 : 0); }
    if (filters.cursor) { query += ' AND created_at < ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC';
    if (filters.limit != null) { query += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = (await this.db.query(...toPos(query, params))).rows as unknown as NotificationRow[];
    return rows.map(hydrate);
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    await this.db.query(...toPos('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]));
    const row = (await this.db.query(...toPos('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, userId]))).rows[0] as NotificationRow | undefined;
    if (!row) throw new NotFoundError('Notification not found');
    return hydrate(row);
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.db.query(...toPos('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]));
    return Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0);
  }
}
