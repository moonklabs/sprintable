// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import type { InternalDogfoodActor } from '@/lib/internal-dogfood';
import { getInternalDogfoodAllowedTeamMemberIds } from '@/lib/internal-dogfood';

interface TeamMemberRow {
  id: string;
  org_id: string;
  project_id: string;
  name: string | null;
  type: string;
  is_active: boolean;
  projects: { name: string | null } | Array<{ name: string | null }> | null;
}

function pickProjectName(projects: TeamMemberRow['projects']) {
  if (Array.isArray(projects)) return projects.find(Boolean)?.name ?? null;
  return projects?.name ?? null;
}

function toActor(row: TeamMemberRow): InternalDogfoodActor {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    name: row.name?.trim() || 'Internal member',
    project_name: pickProjectName(row.projects) ?? 'Untitled Project',
  };
}

export async function listInternalDogfoodActors(supabase: SupabaseClient): Promise<InternalDogfoodActor[]> {
  const allowedIds = getInternalDogfoodAllowedTeamMemberIds();
  if (!allowedIds.length) return [];

  const { data, error } = await supabase
    .from('team_members')
    .select('id, org_id, project_id, name, type, is_active, projects(name)')
    .eq('is_active', true)
    .in('id', allowedIds)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => toActor(row as TeamMemberRow));
}

export async function resolveInternalDogfoodActor(
  supabase: SupabaseClient,
  teamMemberId: string,
): Promise<InternalDogfoodActor | null> {
  const allowedIds = getInternalDogfoodAllowedTeamMemberIds();
  if (!allowedIds.includes(teamMemberId)) return null;

  const { data, error } = await supabase
    .from('team_members')
    .select('id, org_id, project_id, name, type, is_active, projects(name)')
    .eq('id', teamMemberId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return toActor(data as TeamMemberRow);
}

export async function listProjectAssignableMembers(
  supabase: SupabaseClient,
  actor: InternalDogfoodActor,
) {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, type, is_active')
    .eq('org_id', actor.org_id)
    .eq('project_id', actor.project_id)
    .eq('is_active', true)
    .order('type', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map((member) => ({
    id: String((member as { id: string }).id),
    name: String((member as { name?: string | null }).name ?? 'Unknown'),
    type: String((member as { type: string }).type),
  }));
}
