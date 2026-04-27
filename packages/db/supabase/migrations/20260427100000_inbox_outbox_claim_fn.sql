-- Operator Cockpit Phase A — outbox worker RPCs
-- claim → POST → mark_delivered / mark_failed / mark_dead lifecycle.
-- See packages/db/supabase/migrations/20260426170200_inbox_outbox.sql

-- ============================================================
-- claim_pending_outbox — atomic batch claim with FOR UPDATE SKIP LOCKED
-- worker가 한 번에 N개 행을 status='in_flight'로 전환하며 잠금. attempt_count++.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_pending_outbox(p_batch_size int DEFAULT 50)
RETURNS SETOF public.inbox_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM public.inbox_outbox
    WHERE status = 'pending' AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    LIMIT GREATEST(p_batch_size, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.inbox_outbox o
  SET status = 'in_flight',
      last_attempt_at = now(),
      attempt_count = o.attempt_count + 1
  FROM claimed
  WHERE o.id = claimed.id
  RETURNING o.*;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_outbox(int) IS
  'Worker가 호출. status=pending AND next_attempt_at <= now() 행 N개를 in_flight로 잠그고 반환.';

-- ============================================================
-- mark_outbox_delivered — 2xx 응답 시 호출
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_outbox_delivered(p_id uuid)
RETURNS public.inbox_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row public.inbox_outbox;
BEGIN
  UPDATE public.inbox_outbox
  SET status = 'delivered',
      delivered_at = now(),
      last_error = NULL
  WHERE id = p_id
  RETURNING * INTO _row;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'outbox row not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN _row;
END;
$$;

-- ============================================================
-- mark_outbox_failed — 일시적 실패. 지수 백오프 재시도 또는 max 도달 시 dead.
-- backoff: attempt_count 1→30s, 2→5m, 3→30m, 4→3h, 5+→dead
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_outbox_failed(
  p_id uuid,
  p_error text
)
RETURNS public.inbox_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row public.inbox_outbox;
  _next_delay interval;
  _max_attempts int := 5;
BEGIN
  SELECT * INTO _row FROM public.inbox_outbox WHERE id = p_id FOR UPDATE;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'outbox row not found' USING ERRCODE = 'P0002';
  END IF;

  IF _row.attempt_count >= _max_attempts THEN
    UPDATE public.inbox_outbox
    SET status = 'dead', last_error = p_error
    WHERE id = p_id
    RETURNING * INTO _row;
  ELSE
    _next_delay := CASE _row.attempt_count
      WHEN 1 THEN interval '30 seconds'
      WHEN 2 THEN interval '5 minutes'
      WHEN 3 THEN interval '30 minutes'
      WHEN 4 THEN interval '3 hours'
      ELSE interval '12 hours'
    END;
    UPDATE public.inbox_outbox
    SET status = 'pending',
        next_attempt_at = now() + _next_delay,
        last_error = p_error
    WHERE id = p_id
    RETURNING * INTO _row;
  END IF;

  RETURN _row;
END;
$$;

-- ============================================================
-- mark_outbox_dead — 영구 실패 (재시도 안 함). webhook_url 미설정 등에 사용.
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_outbox_dead(
  p_id uuid,
  p_error text
)
RETURNS public.inbox_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row public.inbox_outbox;
BEGIN
  UPDATE public.inbox_outbox
  SET status = 'dead', last_error = p_error
  WHERE id = p_id
  RETURNING * INTO _row;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'outbox row not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN _row;
END;
$$;
