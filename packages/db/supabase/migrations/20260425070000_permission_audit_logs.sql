-- E-PLATFORM-SECURE S2: permission_audit_logs 테이블 신설

CREATE TABLE IF NOT EXISTS public.permission_audit_logs (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id          uuid        NOT NULL,
  actor_id        uuid        NOT NULL,
  action          text        NOT NULL CHECK (action IN ('member_added', 'member_removed', 'role_changed')),
  target_user_id  uuid,
  old_role        text,
  new_role        text,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permission_audit_logs_org_id
  ON public.permission_audit_logs(org_id, created_at DESC);

ALTER TABLE public.permission_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "permission_audit_logs_select" ON public.permission_audit_logs FOR SELECT
  USING (org_id IN (
    SELECT DISTINCT org_id FROM public.team_members
    WHERE user_id = auth.uid() AND is_active = true
      AND role IN ('owner', 'admin')
  ));
