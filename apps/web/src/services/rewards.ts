

export class RewardsService {
  constructor(private readonly db: any) {}

  async getBalance(projectId: string, memberId: string) {
    const { data, error } = await this.db
      .from('reward_ledger')
      .select('amount')
      .eq('project_id', projectId)
      .eq('member_id', memberId);
    if (error) throw error;
    const total = (data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
    return { member_id: memberId, balance: total };
  }

  async getLedger(projectId: string, memberId?: string) {
    let query = this.db
      .from('reward_ledger')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (memberId) query = query.eq('member_id', memberId);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async grant(input: { org_id: string; project_id: string; member_id: string; amount: number; reason: string; granted_by: string; reference_type?: string; reference_id?: string }) {
    // member_id가 같은 org/project 소속인지 검증
    const { data: member } = await this.db
      .from('team_members')
      .select('id')
      .eq('id', input.member_id)
      .eq('org_id', input.org_id)
      .eq('project_id', input.project_id)
      .single();
    if (!member) throw new Error('member_id must be a team member in the same project');

    const { data, error } = await this.db.from('reward_ledger').insert(input).select().single();
    if (error) throw error;
    return data;
  }

  async getLeaderboard(projectId: string) {
    const { data, error } = await this.db
      .from('reward_ledger')
      .select('member_id, amount')
      .eq('project_id', projectId);
    if (error) throw error;

    const totals: Record<string, number> = {};
    for (const r of data ?? []) {
      totals[r.member_id as string] = (totals[r.member_id as string] ?? 0) + Number(r.amount);
    }

    return Object.entries(totals)
      .map(([member_id, balance]) => ({ member_id, balance }))
      .sort((a, b) => b.balance - a.balance);
  }

  async getLeaderboardByPeriod(
    projectId: string,
    period: 'daily' | 'weekly' | 'monthly' | 'all',
    limit = 50,
    cursor?: string,
  ) {
    const periodMs: Record<string, number> = {
      daily: 86400_000,
      weekly: 7 * 86400_000,
      monthly: 30 * 86400_000,
    };

    // story 4912: the all-time board is the ledger's own sum too (the `reward_balances` view was defined only in a Supabase migration, never in alembic — see backend/app/repositories/reward.py);
    // a period board is the same sum over a time window. (Nothing imports this service today.)
    let q = this.db
      .from('reward_ledger')
      .select('member_id, amount')
      .eq('project_id', projectId);
    if (period !== 'all') q = q.gte('created_at', new Date(Date.now() - periodMs[period]).toISOString());
    if (cursor && period !== 'all') q = q.lt('created_at', cursor);
    const { data, error } = await q;
    if (error) throw error;

    const totals: Record<string, number> = {};
    for (const r of data ?? []) {
      totals[r.member_id as string] = (totals[r.member_id as string] ?? 0) + Number(r.amount);
    }
    return Object.entries(totals)
      .map(([member_id, balance]) => ({ member_id, balance }))
      .filter((e) => !(cursor && period === 'all') || e.balance < Number(cursor)) // the all-time cursor is a balance, a period cursor a time
      .sort((a, b) => b.balance - a.balance)
      .slice(0, limit);
  }
}
