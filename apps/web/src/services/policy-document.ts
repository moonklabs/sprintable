// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;


export class PolicyDocumentService {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(filters: { project_id: string; sprint_id?: string; q?: string }) {
    let query = this.supabase
      .from('policy_documents')
      .select(`
        id,
        org_id,
        project_id,
        sprint_id,
        epic_id,
        title,
        content,
        updated_at,
        legacy_sprint_key,
        legacy_epic_key,
        sprint:sprints!policy_documents_sprint_id_fkey(id, title, status),
        epic:epics!policy_documents_epic_id_fkey(id, title, status)
      `)
      .eq('project_id', filters.project_id)
      .order('updated_at', { ascending: false });

    if (filters.sprint_id) query = query.eq('sprint_id', filters.sprint_id);
    if (filters.q?.trim()) {
      const q = filters.q.trim();
      query = query.or(`title.ilike.%${q}%,content.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
}
