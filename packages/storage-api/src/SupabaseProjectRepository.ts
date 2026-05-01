import type { IProjectRepository, Project, CreateProjectInput, UpdateProjectInput, ProjectListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class SupabaseProjectRepository implements IProjectRepository {
  constructor(private readonly accessToken: string = '') {}

  async list(_filters: ProjectListFilters): Promise<Project[]> {
    return fastapiCall<Project[]>('GET', '/api/v2/projects', this.accessToken);
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Project> {
    return fastapiCall<Project>('GET', `/api/v2/projects/${id}`, this.accessToken);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    return fastapiCall<Project>('POST', '/api/v2/projects', this.accessToken, { body: input, orgId: input.org_id });
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    return fastapiCall<Project>('PATCH', `/api/v2/projects/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/projects/${id}`, this.accessToken);
  }
}
