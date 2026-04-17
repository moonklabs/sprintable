-- SID:351 — agent_runs UPDATE RLS policy + 재시도 상태 업데이트 권한

-- agent_runs UPDATE policy (원본 005에 누락)
-- admin(service_role)만 update 가능 — retry_count, next_retry_at, status 갱신
CREATE POLICY "agent_runs_update" ON public.agent_runs FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- 재시도 대기 중인 run 조회용 복합 인덱스 보강
CREATE INDEX IF NOT EXISTS idx_agent_runs_retry_pending
  ON public.agent_runs (org_id, next_retry_at)
  WHERE status = 'failed'
    AND next_retry_at IS NOT NULL
    AND retry_count < max_retries;
