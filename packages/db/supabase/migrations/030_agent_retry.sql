-- SID:351 — 자동 재시도 로직

-- agent_runs에 재시도 관련 컬럼 추가
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS max_retries integer NOT NULL DEFAULT 3;
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES public.agent_runs(id);
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS error_message text;

-- 재시도 대기 중인 run 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_agent_runs_next_retry ON public.agent_runs(next_retry_at)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL AND retry_count < max_retries;
