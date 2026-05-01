import type { ITeamMemberRepository, TeamMember, CreateTeamMemberInput, UpdateTeamMemberInput, TeamMemberListFilters } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseTeamMemberRepository implements ITeamMemberRepository {
  constructor(private readonly accessToken: string = '') {}

  async list(filters: TeamMemberListFilters): Promise<TeamMember[]> {
    return fastapiCall<TeamMember[]>('GET', '/api/v2/team-members', this.accessToken, { query: { project_id: filters.project_id, type: filters.type, is_active: filters.is_active != null ? String(filters.is_active) : undefined } });
  }

  async getById(id: string): Promise<TeamMember> {
    return fastapiCall<TeamMember>('GET', `/api/v2/team-members/${id}`, this.accessToken);
  }

  async getByUserId(userId: string, _orgId: string): Promise<TeamMember | null> {
    try {
      const members = await fastapiCall<TeamMember[]>('GET', '/api/v2/team-members', this.accessToken);
      return members.find((m) => (m as unknown as { user_id?: string }).user_id === userId) ?? null;
    } catch { return null; }
  }

  async create(input: CreateTeamMemberInput): Promise<TeamMember> {
    return fastapiCall<TeamMember>('POST', '/api/v2/team-members', this.accessToken, { body: input, orgId: input.org_id });
  }

  async update(id: string, input: UpdateTeamMemberInput): Promise<TeamMember> {
    return fastapiCall<TeamMember>('PATCH', `/api/v2/team-members/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/team-members/${id}`, this.accessToken);
  }
}
