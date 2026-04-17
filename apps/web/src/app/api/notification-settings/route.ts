import { parseBody, updateNotificationSettingsSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();
    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    const { data, error } = await supabase.from('notification_settings').select('*').eq('member_id', me.id);
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();
    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    const parsed = await parseBody(request, updateNotificationSettingsSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const { data, error } = await supabase.from('notification_settings').upsert({
      org_id: me.org_id, member_id: me.id,
      channel: body.channel, event_type: body.event_type, enabled: body.enabled,
    }, { onConflict: 'member_id,channel,event_type' }).select().single();
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
