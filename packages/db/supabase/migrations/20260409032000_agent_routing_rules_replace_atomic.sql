CREATE OR REPLACE FUNCTION public.replace_agent_routing_rules(
  _org_id uuid,
  _project_id uuid,
  _actor_id uuid,
  _rules jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _provided_existing_count integer;
  _duplicate_count integer;
  _matched_existing_count integer;
BEGIN
  IF _rules IS NULL OR jsonb_typeof(_rules) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'routing_rule_replace_items_required';
  END IF;

  WITH incoming AS (
    SELECT *
    FROM jsonb_to_recordset(_rules) AS payload(
      id uuid,
      agent_id uuid,
      persona_id uuid,
      deployment_id uuid,
      name text,
      priority integer,
      match_type text,
      conditions jsonb,
      action jsonb,
      target_runtime text,
      target_model text,
      is_enabled boolean
    )
  )
  SELECT COUNT(id), COUNT(id) - COUNT(DISTINCT id)
  INTO _provided_existing_count, _duplicate_count
  FROM incoming
  WHERE id IS NOT NULL;

  IF _duplicate_count > 0 THEN
    RAISE EXCEPTION 'routing_rule_replace_duplicate_ids';
  END IF;

  WITH incoming AS (
    SELECT *
    FROM jsonb_to_recordset(_rules) AS payload(
      id uuid,
      agent_id uuid,
      persona_id uuid,
      deployment_id uuid,
      name text,
      priority integer,
      match_type text,
      conditions jsonb,
      action jsonb,
      target_runtime text,
      target_model text,
      is_enabled boolean
    )
  )
  SELECT COUNT(*)
  INTO _matched_existing_count
  FROM public.agent_routing_rules rules
  INNER JOIN incoming ON incoming.id = rules.id
  WHERE incoming.id IS NOT NULL
    AND rules.org_id = _org_id
    AND rules.project_id = _project_id
    AND rules.deleted_at IS NULL;

  IF _matched_existing_count <> _provided_existing_count THEN
    RAISE EXCEPTION 'routing_rule_replace_scope_mismatch';
  END IF;

  PERFORM 1
  FROM public.agent_routing_rules rules
  WHERE rules.org_id = _org_id
    AND rules.project_id = _project_id
    AND rules.deleted_at IS NULL
  FOR UPDATE;

  UPDATE public.agent_routing_rules AS rules
  SET deleted_at = now(),
      is_enabled = false
  WHERE rules.org_id = _org_id
    AND rules.project_id = _project_id
    AND rules.deleted_at IS NULL;

  INSERT INTO public.agent_routing_rules (
    org_id,
    project_id,
    agent_id,
    persona_id,
    deployment_id,
    name,
    priority,
    match_type,
    conditions,
    action,
    target_runtime,
    target_model,
    is_enabled,
    created_by
  )
  SELECT
    _org_id,
    _project_id,
    incoming.agent_id,
    incoming.persona_id,
    incoming.deployment_id,
    incoming.name,
    incoming.priority,
    incoming.match_type,
    COALESCE(incoming.conditions, '{}'::jsonb),
    COALESCE(incoming.action, '{}'::jsonb),
    COALESCE(NULLIF(incoming.target_runtime, ''), 'openclaw'),
    NULLIF(incoming.target_model, ''),
    COALESCE(incoming.is_enabled, true),
    _actor_id
  FROM jsonb_to_recordset(_rules) AS incoming(
    id uuid,
    agent_id uuid,
    persona_id uuid,
    deployment_id uuid,
    name text,
    priority integer,
    match_type text,
    conditions jsonb,
    action jsonb,
    target_runtime text,
    target_model text,
    is_enabled boolean
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_agent_routing_rules(uuid, uuid, uuid, jsonb) TO authenticated, service_role;
