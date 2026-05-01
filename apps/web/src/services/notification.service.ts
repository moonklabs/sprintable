
import type { NotificationType } from '@/lib/notification-types';

export interface CreateNotificationInput {
  org_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
}

export class NotificationService {
  constructor(private readonly db: any) {}

  async create(input: CreateNotificationInput): Promise<void> {
    const { error } = await this.db.from('notifications').insert(input);
    if (error) throw error;
  }

  async createMany(inputs: CreateNotificationInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const { error } = await this.db.from('notifications').insert(inputs);
    if (error) throw error;
  }
}
