import type { SupabaseClient } from '@supabase/supabase-js';

export class MockupService {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(projectId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const { data, error, count } = await this.supabase
      .from('mockup_pages')
      .select('id, slug, title, category, viewport, version, created_at', { count: 'exact' })
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { items: data ?? [], total: count ?? 0 };
  }

  async getById(id: string) {
    const { data: page, error } = await this.supabase
      .from('mockup_pages')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error) throw error;

    const { data: components } = await this.supabase
      .from('mockup_components')
      .select('*')
      .eq('page_id', id)
      .order('sort_order');

    // AC5: scenarios 조회
    const { data: scenarios } = await this.supabase
      .from('mockup_scenarios')
      .select('*')
      .eq('page_id', id)
      .order('sort_order');

    return { ...page, components: components ?? [], scenarios: (scenarios ?? []).map(s => ({ name: s.name, overrides: s.override_props ?? {}, is_default: s.is_default })) };
  }

  async create(input: {
    org_id: string; project_id: string; slug: string; title: string;
    category?: string; viewport?: string; created_by?: string;
  }) {
    const { data, error } = await this.supabase
      .from('mockup_pages')
      .insert(input)
      .select('id, slug, title, category, viewport, version, created_at')
      .single();

    if (error) throw error;

    // AC3: default 시나리오 자동 생성
    if (data) {
      await this.supabase.from('mockup_scenarios').insert({
        page_id: data.id, name: 'default', override_props: {}, is_default: true, sort_order: 0,
      });
    }

    return data;
  }

  async update(id: string, input: {
    title?: string; slug?: string; category?: string; viewport?: string;
    components?: Array<{
      id?: string; parent_id?: string | null; component_type: string;
      props?: Record<string, unknown>; spec_description?: string | null; sort_order?: number;
    }>;
  }) {
    const updates: Record<string, unknown> = {};
    if (input.title) updates.title = input.title;
    if (input.slug) updates.slug = input.slug;
    if (input.category !== undefined) updates.category = input.category;
    if (input.viewport) updates.viewport = input.viewport;

    if (Object.keys(updates).length > 0) {
      const { error } = await this.supabase.from('mockup_pages').update(updates).eq('id', id);
      if (error) throw error;
    }

    // version +1
    await this.supabase.rpc('increment_mockup_version', { _page_id: id });

    // 컴포넌트 트리 전체 교체 (2-pass: root → children)
    if (input.components) {
      await this.supabase.from('mockup_components').delete().eq('page_id', id);

      if (input.components.length > 0) {
        const clientToDbId: Record<string, string> = {};

        // 1-pass: root (parent_id 없는 것)
        const roots = input.components.filter(c => !c.parent_id);
        for (let i = 0; i < roots.length; i++) {
          const c = roots[i];
          const { data, error: err } = await this.supabase.from('mockup_components').insert({
            page_id: id, parent_id: null,
            component_type: c.component_type, props: c.props ?? {},
            spec_description: c.spec_description ?? null, sort_order: c.sort_order ?? i,
          }).select('id').single();
          if (err) throw err;
          if (c.id && data) clientToDbId[c.id] = data.id;
        }

        // 2-pass: children (parent_id 있는 것)
        const children = input.components.filter(c => !!c.parent_id);
        for (let i = 0; i < children.length; i++) {
          const c = children[i];
          const resolvedParent = c.parent_id ? (clientToDbId[c.parent_id] ?? c.parent_id) : null;
          const { data, error: err } = await this.supabase.from('mockup_components').insert({
            page_id: id, parent_id: resolvedParent,
            component_type: c.component_type, props: c.props ?? {},
            spec_description: c.spec_description ?? null, sort_order: c.sort_order ?? (roots.length + i),
          }).select('id').single();
          if (err) throw err;
          if (c.id && data) clientToDbId[c.id] = data.id;
        }
      }
    }

    const { data: page } = await this.supabase.from('mockup_pages').select('id, version').eq('id', id).single();

    // 버전 스냅샷 저장 (AC7) — components + title + scenarios
    if (page) {
      const { data: currentComps } = await this.supabase.from('mockup_components').select('*').eq('page_id', id);
      const { data: currentScenarios } = await this.supabase.from('mockup_scenarios').select('*').eq('page_id', id);
      await this.supabase.from('mockup_versions').insert({
        page_id: id,
        version: page.version,
        snapshot: { components: currentComps ?? [], title: input.title, scenarios: currentScenarios ?? [] },
      });
    }

    return page;
  }

  async delete(id: string) {
    const { error } = await this.supabase
      .from('mockup_pages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
  }
}
