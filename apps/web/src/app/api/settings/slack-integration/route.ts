import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import {
  buildSlackConnectUrl,
  isExpiredIsoTimestamp,
  loadSlackConnectionSnapshot,
  resolveMessagingBridgeSecretRef,
} from '@/services/slack-channel-mapping';

const saveMappingSchema = z.object({
  channel_id: z.string().trim().min(1),
  channel_name: z.string().trim().min(1).max(255),
  project_id: z.string().uuid(),
  force_remap: z.boolean().optional().default(false),
});

async function requireAdminContext() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ApiErrors.unauthorized() as Response };

  const me = await getMyTeamMember(supabase, user);
  if (!me) return { error: ApiErrors.forbidden('Team member not found') as Response };

  const { data: orgMember, error: orgMemberError } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', me.org_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (orgMemberError) throw orgMemberError;
  if (!orgMember || !['owner', 'admin'].includes(orgMember.role as string)) {
    return { error: ApiErrors.forbidden('Admin access required') as Response };
  }

  return { supabase, me };
}

function buildConnectUrl(orgId: string, projectId: string) {
  const clientId = process.env['SLACK_CLIENT_ID'];
  const redirectUri = process.env['SLACK_REDIRECT_URI'];
  if (!clientId || !redirectUri) return null;

  const state = Buffer.from(JSON.stringify({ orgId, projectId, source: 'slack-settings' })).toString('base64url');
  return buildSlackConnectUrl({ clientId, redirectUri, state });
}

export async function GET() {
  try {
    const ctx = await requireAdminContext();
    if ('error' in ctx) return ctx.error;

    const { supabase, me } = ctx;
    const connectUrl = buildConnectUrl(me.org_id, me.project_id);

    const [projectsResult, mappingsResult, authResult] = await Promise.all([
      supabase
        .from('projects')
        .select('id, name')
        .eq('org_id', me.org_id)
        .order('name'),
      supabase
        .from('messaging_bridge_channels')
        .select('id, project_id, channel_id, channel_name, config, projects(id, name)')
        .eq('org_id', me.org_id)
        .eq('platform', 'slack')
        .eq('is_active', true)
        .order('channel_name'),
      supabase
        .from('messaging_bridge_org_auths')
        .select('id, access_token_ref, expires_at')
        .eq('org_id', me.org_id)
        .eq('platform', 'slack')
        .maybeSingle(),
    ]);

    if (projectsResult.error) throw projectsResult.error;
    if (mappingsResult.error) throw mappingsResult.error;
    if (authResult.error) throw authResult.error;

    const projects = (projectsResult.data ?? []).map((project) => ({
      id: project.id as string,
      name: project.name as string,
    }));

    const mappings = (mappingsResult.data ?? []).map((mapping) => {
      const project = Array.isArray(mapping.projects) ? mapping.projects.find(Boolean) : mapping.projects;
      return {
        id: mapping.id as string,
        channel_id: mapping.channel_id as string,
        channel_name: (mapping.channel_name as string | null) ?? (mapping.channel_id as string),
        project_id: mapping.project_id as string,
        project_name: (project as { id: string; name: string } | null)?.name ?? 'Unknown project',
      };
    });

    const auth = authResult.data;
    const token = resolveMessagingBridgeSecretRef(auth?.access_token_ref as string | null | undefined);
    if (!auth || !token || isExpiredIsoTimestamp(auth.expires_at as string | null | undefined)) {
      return apiSuccess({
        status: 'disconnected',
        connect_url: connectUrl,
        workspace: null,
        channels: [],
        projects,
        mappings,
        error: null,
      });
    }

    const snapshot = await loadSlackConnectionSnapshot(token);

    return apiSuccess({
      status: snapshot.status,
      connect_url: connectUrl,
      workspace: {
        team_name: snapshot.workspace.teamName,
        team_id: snapshot.workspace.teamId,
        bot_user_id: snapshot.workspace.botUserId,
      },
      channels: snapshot.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        is_private: channel.isPrivate,
        is_member: channel.isMember,
        member_count: channel.memberCount,
      })),
      projects,
      mappings,
      error: snapshot.error,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireAdminContext();
    if ('error' in ctx) return ctx.error;

    const { supabase, me } = ctx;
    const body = saveMappingSchema.parse(await request.json());

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name')
      .eq('id', body.project_id)
      .eq('org_id', me.org_id)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project) return ApiErrors.badRequest('Invalid project_id');

    const { data: existing, error: existingError } = await supabase
      .from('messaging_bridge_channels')
      .select('id, org_id, project_id, channel_id, channel_name, config, projects(id, name)')
      .eq('platform', 'slack')
      .eq('channel_id', body.channel_id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing && existing.project_id !== body.project_id && !body.force_remap) {
      const mappedProject = Array.isArray(existing.projects) ? existing.projects.find(Boolean) : existing.projects;
      return NextResponse.json({
        data: {
          conflict: true,
          channel_id: body.channel_id,
          channel_name: (existing.channel_name as string | null) ?? body.channel_name,
          existing_project_id: existing.project_id as string,
          existing_project_name: (mappedProject as { id: string; name: string } | null)?.name ?? 'Unknown project',
        },
        error: {
          code: 'CHANNEL_ALREADY_MAPPED',
          message: 'Slack channel is already mapped to another project.',
        },
        meta: null,
      }, { status: 409 });
    }

    if (existing) {
      const { data, error } = await supabase
        .from('messaging_bridge_channels')
        .update({
          org_id: me.org_id,
          project_id: body.project_id,
          channel_name: body.channel_name,
          is_active: true,
        })
        .eq('id', existing.id)
        .select('id, project_id, channel_id, channel_name')
        .single();

      if (error) throw error;
      return apiSuccess({
        id: data.id,
        project_id: data.project_id,
        project_name: project.name,
        channel_id: data.channel_id,
        channel_name: data.channel_name,
      });
    }

    const { data, error } = await supabase
      .from('messaging_bridge_channels')
      .insert({
        org_id: me.org_id,
        project_id: body.project_id,
        platform: 'slack',
        channel_id: body.channel_id,
        channel_name: body.channel_name,
        config: {},
        is_active: true,
      })
      .select('id, project_id, channel_id, channel_name')
      .single();

    if (error) throw error;
    return apiSuccess({
      id: data.id,
      project_id: data.project_id,
      project_name: project.name,
      channel_id: data.channel_id,
      channel_name: data.channel_name,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return ApiErrors.validationFailed(error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    }
    return handleApiError(error);
  }
}
