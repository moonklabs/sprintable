-- S532 [E-032:S2] bridge inbound durable dedupe for webhook retries
CREATE UNIQUE INDEX IF NOT EXISTS idx_memos_bridge_source_event_unique
  ON public.memos (
    org_id,
    project_id,
    ((metadata ->> 'source')),
    ((metadata ->> 'event_id'))
  )
  WHERE metadata ? 'source' AND metadata ? 'event_id';
