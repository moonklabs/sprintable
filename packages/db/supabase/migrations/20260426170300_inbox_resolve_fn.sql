-- Operator Cockpit Phase A — atomic resolve/dismiss/reassign RPCs
-- inbox_items state change + outbox row insert in single transaction.
-- See packages/db/supabase/migrations/20260426170000_inbox_items.sql

-- ============================================================
-- resolve_inbox_item: state='resolved' + outbox 'resolved' row
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_inbox_item(
  p_id                  uuid,
  p_org_id              uuid,
  p_resolved_by         uuid,
  p_resolved_option_id  uuid,
  p_resolved_note       text DEFAULT NULL
)
RETURNS public.inbox_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row public.inbox_items;
  _option_exists boolean;
BEGIN
  SELECT * INTO _row FROM public.inbox_items WHERE id = p_id AND org_id = p_org_id FOR UPDATE;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'inbox_item not found' USING ERRCODE = 'P0002';
  END IF;
  IF _row.state != 'pending' THEN
    RAISE EXCEPTION 'inbox_item already %', _row.state USING ERRCODE = '23514';
  END IF;

  -- option_id must exist in options[].id
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(_row.options) AS opt
    WHERE (opt->>'id')::uuid = p_resolved_option_id
  ) INTO _option_exists;
  IF NOT _option_exists THEN
    RAISE EXCEPTION 'resolved_option_id not found in options[].id' USING ERRCODE = '22023';
  END IF;

  UPDATE public.inbox_items
  SET state = 'resolved',
      resolved_by = p_resolved_by,
      resolved_option_id = p_resolved_option_id,
      resolved_note = p_resolved_note,
      resolved_at = now()
  WHERE id = p_id AND org_id = p_org_id
  RETURNING * INTO _row;

  INSERT INTO public.inbox_outbox (
    org_id, inbox_item_id, event_type, payload, status, next_attempt_at
  ) VALUES (
    p_org_id, p_id, 'resolved',
    jsonb_build_object(
      'inbox_item_id', p_id,
      'event_type', 'resolved',
      'inbox_item_snapshot', jsonb_build_object(
        'title', _row.title,
        'kind', _row.kind,
        'project_id', _row.project_id,
        'org_id', _row.org_id,
        'options', _row.options,
        'origin_chain', _row.origin_chain
      ),
      'resolved_choice', p_resolved_option_id,
      'resolved_note', p_resolved_note,
      'resolved_by', p_resolved_by,
      'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'pending',
    now()
  );

  RETURN _row;
END;
$$;

-- ============================================================
-- dismiss_inbox_item: state='dismissed' + outbox 'dismissed'
-- ============================================================
CREATE OR REPLACE FUNCTION public.dismiss_inbox_item(
  p_id              uuid,
  p_org_id          uuid,
  p_resolved_by     uuid,
  p_resolved_note   text DEFAULT NULL
)
RETURNS public.inbox_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row public.inbox_items;
BEGIN
  SELECT * INTO _row FROM public.inbox_items WHERE id = p_id AND org_id = p_org_id FOR UPDATE;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'inbox_item not found' USING ERRCODE = 'P0002';
  END IF;
  IF _row.state != 'pending' THEN
    RAISE EXCEPTION 'inbox_item already %', _row.state USING ERRCODE = '23514';
  END IF;

  UPDATE public.inbox_items
  SET state = 'dismissed',
      resolved_by = p_resolved_by,
      resolved_note = p_resolved_note,
      resolved_at = now()
  WHERE id = p_id AND org_id = p_org_id
  RETURNING * INTO _row;

  INSERT INTO public.inbox_outbox (
    org_id, inbox_item_id, event_type, payload, status, next_attempt_at
  ) VALUES (
    p_org_id, p_id, 'dismissed',
    jsonb_build_object(
      'inbox_item_id', p_id,
      'event_type', 'dismissed',
      'inbox_item_snapshot', jsonb_build_object(
        'title', _row.title,
        'kind', _row.kind,
        'project_id', _row.project_id,
        'org_id', _row.org_id,
        'options', _row.options,
        'origin_chain', _row.origin_chain
      ),
      'resolved_note', p_resolved_note,
      'resolved_by', p_resolved_by,
      'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'pending',
    now()
  );

  RETURN _row;
END;
$$;

-- ============================================================
-- reassign_inbox_item: assignee_member_id 변경 + outbox 'reassigned'
-- ============================================================
CREATE OR REPLACE FUNCTION public.reassign_inbox_item(
  p_id                      uuid,
  p_org_id                  uuid,
  p_new_assignee_member_id  uuid,
  p_reassigned_by           uuid
)
RETURNS public.inbox_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row public.inbox_items;
BEGIN
  SELECT * INTO _row FROM public.inbox_items WHERE id = p_id AND org_id = p_org_id FOR UPDATE;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'inbox_item not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.inbox_items
  SET assignee_member_id = p_new_assignee_member_id
  WHERE id = p_id AND org_id = p_org_id
  RETURNING * INTO _row;

  INSERT INTO public.inbox_outbox (
    org_id, inbox_item_id, event_type, payload, status, next_attempt_at
  ) VALUES (
    p_org_id, p_id, 'reassigned',
    jsonb_build_object(
      'inbox_item_id', p_id,
      'event_type', 'reassigned',
      'inbox_item_snapshot', jsonb_build_object(
        'title', _row.title,
        'kind', _row.kind,
        'project_id', _row.project_id,
        'org_id', _row.org_id,
        'options', _row.options,
        'origin_chain', _row.origin_chain
      ),
      'new_assignee_member_id', p_new_assignee_member_id,
      'resolved_by', p_reassigned_by,
      'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'pending',
    now()
  );

  RETURN _row;
END;
$$;
