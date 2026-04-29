-- E-PERF-INFRA S3: 성능 인덱스 추가
-- subscriptions.org_id 필터 쿼리, team_members 복합 조건 쿼리 Index Scan 보장

CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id
  ON public.subscriptions (org_id);

CREATE INDEX IF NOT EXISTS idx_team_members_user_active
  ON public.team_members (user_id, type, is_active);
