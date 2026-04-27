-- E-WORKFLOW-CONTRACT S1: workflow_contracts / workflow_instances / workflow_events

-- ─── workflow_contracts ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_contracts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  mode        TEXT NOT NULL DEFAULT 'evaluate' CHECK (mode IN ('evaluate', 'enforce')),
  definition  JSONB NOT NULL DEFAULT '{}',
  entity_type TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_contracts_org_active
  ON workflow_contracts (org_id, is_active, entity_type);

-- ─── workflow_instances ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_instances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   UUID NOT NULL REFERENCES workflow_contracts(id) ON DELETE CASCADE,
  entity_id     UUID NOT NULL,
  current_state TEXT NOT NULL,
  context       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_contract
  ON workflow_instances (contract_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_entity
  ON workflow_instances (entity_id, status);

-- ─── workflow_events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  actor_id    UUID,
  tool_name   TEXT,
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_instance
  ON workflow_events (instance_id, created_at DESC);

-- ─── updated_at triggers ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_workflow_contracts_updated_at'
  ) THEN
    CREATE TRIGGER trg_workflow_contracts_updated_at
      BEFORE UPDATE ON workflow_contracts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_workflow_instances_updated_at'
  ) THEN
    CREATE TRIGGER trg_workflow_instances_updated_at
      BEFORE UPDATE ON workflow_instances
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE workflow_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_events    ENABLE ROW LEVEL SECURITY;

-- workflow_contracts: org_id 기준
DROP POLICY IF EXISTS workflow_contracts_org ON workflow_contracts;
CREATE POLICY workflow_contracts_org ON workflow_contracts
  USING (
    org_id IN (
      SELECT org_id FROM organization_members
      WHERE user_id = auth.uid() AND deleted_at IS NULL
    )
  );

-- workflow_instances: contract의 org_id 기준
DROP POLICY IF EXISTS workflow_instances_org ON workflow_instances;
CREATE POLICY workflow_instances_org ON workflow_instances
  USING (
    contract_id IN (
      SELECT id FROM workflow_contracts WHERE org_id IN (
        SELECT org_id FROM organization_members
        WHERE user_id = auth.uid() AND deleted_at IS NULL
      )
    )
  );

-- workflow_events: instance를 통해 org_id 기준
DROP POLICY IF EXISTS workflow_events_org ON workflow_events;
CREATE POLICY workflow_events_org ON workflow_events
  USING (
    instance_id IN (
      SELECT wi.id FROM workflow_instances wi
      JOIN workflow_contracts wc ON wc.id = wi.contract_id
      WHERE wc.org_id IN (
        SELECT org_id FROM organization_members
        WHERE user_id = auth.uid() AND deleted_at IS NULL
      )
    )
  );
