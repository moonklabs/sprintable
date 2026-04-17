CREATE OR REPLACE FUNCTION public.reorder_agent_routing_rules(
  _org_id uuid,
  _project_id uuid,
  _updates jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _update_count integer;
  _duplicate_count integer;
  _matched_count integer;
BEGIN
  IF _updates IS NULL OR jsonb_typeof(_updates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'routing_rule_reorder_items_required';
  END IF;

  IF jsonb_array_length(_updates) = 0 THEN
    RAISE EXCEPTION 'routing_rule_reorder_items_required';
  END IF;

  WITH updates AS (
    SELECT *
    FROM jsonb_to_recordset(_updates) AS payload(id uuid, priority integer)
  )
  SELECT COUNT(*), COUNT(*) - COUNT(DISTINCT id)
  INTO _update_count, _duplicate_count
  FROM updates;

  IF _duplicate_count > 0 THEN
    RAISE EXCEPTION 'routing_rule_reorder_duplicate_ids';
  END IF;

  WITH updates AS (
    SELECT *
    FROM jsonb_to_recordset(_updates) AS payload(id uuid, priority integer)
  )
  SELECT COUNT(*)
  INTO _matched_count
  FROM public.agent_routing_rules rules
  INNER JOIN updates ON updates.id = rules.id
  WHERE rules.org_id = _org_id
    AND rules.project_id = _project_id
    AND rules.deleted_at IS NULL;

  IF _matched_count <> _update_count THEN
    RAISE EXCEPTION 'routing_rule_reorder_scope_mismatch';
  END IF;

  WITH updates AS (
    SELECT *
    FROM jsonb_to_recordset(_updates) AS payload(id uuid, priority integer)
  )
  UPDATE public.agent_routing_rules AS rules
  SET priority = updates.priority
  FROM updates
  WHERE rules.id = updates.id
    AND rules.org_id = _org_id
    AND rules.project_id = _project_id
    AND rules.deleted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reorder_agent_routing_rules(uuid, uuid, jsonb) TO authenticated, service_role;
