-- E-DATA-INTEGRITY S8: pg_cron으로 nudge_standup_deadline() 일별 실행 등록
-- nudge_standup_deadline() 함수는 20260401021000_agent_webhook_nudge.sql에 정의됨

-- 1. pg_cron 확장 활성화 (Supabase Pro+에서 지원, cron 스키마 자동 생성)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 기존 동일 이름 잡 존재 시 안전 제거 (재실행 idempotent 보장)
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'nudge-standup-deadline';

-- 3. 매일 UTC 14:00 (KST 23:00) 실행 등록
SELECT cron.schedule(
  'nudge-standup-deadline',
  '0 14 * * *',
  'SELECT public.nudge_standup_deadline()'
);
