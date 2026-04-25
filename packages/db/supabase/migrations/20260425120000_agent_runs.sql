-- E-PLATFORM-SECURE S7: agent_runs metadata 컬럼 추가
-- trigger 컬럼이 trigger_type 역할 수행 ('webhook'|'manual'|'cron')
-- AC1 요건: trigger_type은 기존 trigger 컬럼으로 충족, metadata 신규 추가

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
