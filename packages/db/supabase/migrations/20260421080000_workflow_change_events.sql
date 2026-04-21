-- E-WORKFLOW-VIZ:S3 — workflow_change_events 발송 기록 테이블

CREATE TABLE IF NOT EXISTS public.workflow_change_events (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id               uuid        NOT NULL,
  project_id           uuid        NOT NULL,
  workflow_version_id  uuid        REFERENCES public.workflow_versions(id) ON DELETE SET NULL,
  notified_agent_ids   jsonb       NOT NULL DEFAULT '[]',
  memo_ids             jsonb       NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.workflow_change_events IS '워크플로우 변경 시 에이전트 알림 발송 기록';
COMMENT ON COLUMN public.workflow_change_events.notified_agent_ids IS '알림 수신 에이전트 team_member id 배열';
COMMENT ON COLUMN public.workflow_change_events.memo_ids IS '발송된 memo id 배열';

CREATE INDEX idx_workflow_change_events_project_id ON public.workflow_change_events(project_id, created_at DESC);
CREATE INDEX idx_workflow_change_events_org_id ON public.workflow_change_events(org_id);

ALTER TABLE public.workflow_change_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_change_events_select_org_member"
  ON public.workflow_change_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.org_id = workflow_change_events.org_id
        AND tm.user_id = auth.uid()
        AND tm.deleted_at IS NULL
    )
  );

CREATE POLICY "workflow_change_events_service_role_all"
  ON public.workflow_change_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
