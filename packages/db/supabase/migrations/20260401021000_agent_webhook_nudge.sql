-- SID:346 — 에이전트 웹훅 넛지
-- notifications INSERT 시 대상이 에이전트(type=agent)이고 webhook_url 설정되어 있으면 호출

-- pg_net 확장 활성화 (Supabase에서 HTTP 호출 가능)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 1. 에이전트 웹훅 발송 함수
CREATE OR REPLACE FUNCTION public.notify_agent_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _member record;
  _payload jsonb;
  _settings_event text;
BEGIN
  -- 대상 team_member 조회
  SELECT tm.type, tm.webhook_url, tm.name
  INTO _member
  FROM public.team_members tm
  WHERE tm.id = NEW.user_id;

  -- 에이전트가 아니면 스킵
  IF _member IS NULL OR _member.type != 'agent' THEN
    RETURN NEW;
  END IF;

  -- notification reference에서 project_id 도출 → webhook_configs 분기
  DECLARE _webhook_url text;
  DECLARE _project_id uuid;
  BEGIN
    -- reference_type에서 project_id 도출
    IF NEW.reference_type = 'story' AND NEW.reference_id IS NOT NULL THEN
      SELECT project_id INTO _project_id FROM public.stories WHERE id = NEW.reference_id;
    ELSIF NEW.reference_type = 'memo' AND NEW.reference_id IS NOT NULL THEN
      SELECT project_id INTO _project_id FROM public.memos WHERE id = NEW.reference_id;
    ELSIF NEW.reference_type = 'task' AND NEW.reference_id IS NOT NULL THEN
      SELECT s.project_id INTO _project_id FROM public.tasks t JOIN public.stories s ON s.id = t.story_id WHERE t.id = NEW.reference_id;
    END IF;

    -- 1. project_id 기반 웹훅
    IF _project_id IS NOT NULL THEN
      SELECT wc.url INTO _webhook_url
      FROM public.webhook_configs wc
      WHERE wc.member_id = NEW.user_id AND wc.is_active = true AND wc.project_id = _project_id
      LIMIT 1;
    END IF;

    -- 2. 없으면 default 웹훅 (project_id IS NULL)
    IF _webhook_url IS NULL THEN
      SELECT wc.url INTO _webhook_url
      FROM public.webhook_configs wc
      WHERE wc.member_id = NEW.user_id AND wc.is_active = true AND wc.project_id IS NULL
      LIMIT 1;
    END IF;

    -- 3. 없으면 team_members.webhook_url 폴백
    IF _webhook_url IS NULL THEN
      _webhook_url := _member.webhook_url;
    END IF;
  END;

  IF _webhook_url IS NULL OR _webhook_url = '' THEN
    RETURN NEW;
  END IF;

  -- Quiet Hours 체크: notifications.type → notification_settings.event_type 매핑
  _settings_event := CASE NEW.type
    WHEN 'story' THEN 'story_assigned'
    WHEN 'task' THEN 'story_assigned'
    WHEN 'memo' THEN 'memo_received'
    WHEN 'reward' THEN 'reward_granted'
    WHEN 'standup_reminder' THEN 'story_status_changed'
    ELSE 'story_status_changed'
  END;

  IF EXISTS (
    SELECT 1 FROM public.notification_settings ns
    WHERE ns.member_id = NEW.user_id
      AND ns.event_type = _settings_event
      AND ns.enabled = false
  ) THEN
    RETURN NEW;
  END IF;

  -- 웹훅 payload 구성
  _payload := jsonb_build_object(
    'event_type', NEW.type,
    'title', NEW.title,
    'body', COALESCE(NEW.body, ''),
    'reference_type', NEW.reference_type,
    'reference_id', NEW.reference_id,
    'timestamp', NEW.created_at,
    'agent_name', _member.name
  );

  -- pg_net으로 HTTP POST 발송 (비동기, 실패해도 트리거 안 멈춤)
  PERFORM extensions.http_post(
    url := _webhook_url,
    body := _payload::text,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- 발송 실패 시 로그만 기록 (재시도는 Phase 2)
    RAISE WARNING 'Agent webhook failed for member %: %', NEW.user_id, SQLERRM;
    RETURN NEW;
END;
$$;

-- 2. notifications INSERT 트리거
CREATE TRIGGER trg_notify_agent_webhook
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notify_agent_webhook();

-- 3. 스탠드업 마감 넛지 함수 (cron에서 호출)
-- cron 호출 시점 = 마감 시점으로 간주 (프로젝트별 deadline 설정은 Phase 2)
CREATE OR REPLACE FUNCTION public.nudge_standup_deadline()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _project record;
  _member record;
  _today date;
BEGIN
  _today := (now() AT TIME ZONE 'Asia/Seoul')::date;

  -- 모든 active 프로젝트 순회
  FOR _project IN
    SELECT p.id AS project_id, p.org_id, p.name
    FROM public.projects p
    WHERE p.deleted_at IS NULL
  LOOP
    -- 해당 프로젝트의 active 팀 멤버 중 오늘 스탠드업 미작성자
    FOR _member IN
      SELECT tm.id, tm.name
      FROM public.team_members tm
      WHERE tm.project_id = _project.project_id
        AND tm.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM public.standup_entries se
          WHERE se.author_id = tm.id
            AND se.project_id = _project.project_id
            AND se.date = _today
        )
    LOOP
      -- 알림 생성 (중복 방지: 같은 날 같은 멤버에 이미 넛지 있으면 스킵)
      INSERT INTO public.notifications (org_id, user_id, type, title, body)
      SELECT _project.org_id, _member.id, 'standup_reminder',
             'Standup reminder', 'Daily standup for ' || _project.name || ' is due'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = _member.id
          AND n.type = 'standup_reminder'
          AND n.created_at::date = _today
      );
    END LOOP;
  END LOOP;
END;
$$;
