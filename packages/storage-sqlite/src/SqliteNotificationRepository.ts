import type { DatabaseSync } from 'node:sqlite';
import type {
  INotificationRepository,
  Notification,
  CreateNotificationInput,
  NotificationListFilters,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';
import { randomUUID } from 'node:crypto';

type SqlParam = string | number | bigint | null | Uint8Array;

interface NotificationRow extends Omit<Notification, 'is_read'> {
  is_read: number;
}

function hydrate(row: NotificationRow): Notification {
  return { ...row, is_read: Boolean(row.is_read) };
}

export class SqliteNotificationRepository implements INotificationRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notifications (id, org_id, user_id, type, title, body, is_read, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      id, input.org_id, input.user_id, input.type ?? 'info', input.title,
      input.body ?? null, input.reference_type ?? null, input.reference_id ?? null, now,
    );
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined;
    if (!row) throw new NotFoundError('Notification not found after insert');
    return hydrate(row);
  }

  async list(filters: NotificationListFilters): Promise<Notification[]> {
    let sql = 'SELECT * FROM notifications WHERE user_id = ?';
    const params: SqlParam[] = [filters.user_id];
    if (filters.is_read != null) { sql += ' AND is_read = ?'; params.push(filters.is_read ? 1 : 0); }
    if (filters.cursor) { sql += ' AND created_at < ?'; params.push(filters.cursor); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit != null) { sql += ' LIMIT ?'; params.push(filters.limit + 1); }
    const rows = this.db.prepare(sql).all(...params) as unknown as NotificationRow[];
    return rows.map(hydrate);
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    this.db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(id, userId) as NotificationRow | undefined;
    if (!row) throw new NotFoundError('Notification not found');
    return hydrate(row);
  }

  async markAllRead(userId: string): Promise<number> {
    const result = this.db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
    return Number(result.changes ?? 0);
  }
}
