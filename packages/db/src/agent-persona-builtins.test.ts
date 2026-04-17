import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(dirname, '../supabase/migrations/20260406210000_agent_persona_builtins.sql');
const rollbackPath = path.resolve(dirname, '../supabase/rollbacks/20260406210000_agent_persona_builtins_down.sql');
const seedPath = path.resolve(dirname, '../supabase/seed.sql');

const migrationSql = fs.readFileSync(migrationPath, 'utf8');
const rollbackSql = fs.readFileSync(rollbackPath, 'utf8');
const seedSql = fs.readFileSync(seedPath, 'utf8');

describe('agent persona builtin migration', () => {
  it('protects builtin personas from update and delete through RLS', () => {
    expect(migrationSql).toMatch(/CREATE POLICY "agent_personas_update"[\s\S]*AND is_builtin = false[\s\S]*WITH CHECK[\s\S]*AND is_builtin = false/);
    expect(migrationSql).toMatch(/CREATE POLICY "agent_personas_delete"[\s\S]*AND is_builtin = false/);
  });

  it('defines the four builtin persona seeds', () => {
    expect(migrationSql).toContain("ARRAY['general', 'product-owner', 'developer', 'qa']");
    expect(seedSql).toContain("'general'");
    expect(seedSql).toContain("'product-owner'");
    expect(seedSql).toContain("'developer'");
    expect(seedSql).toContain("'qa'");
  });

  it('seeds builtins inside the team_members insert transaction boundary', () => {
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION public.seed_builtin_personas_for_new_agent_member()');
    expect(migrationSql).toContain('CREATE TRIGGER trg_team_members_seed_builtin_personas');
    expect(migrationSql).toContain('AFTER INSERT ON public.team_members');
    expect(migrationSql).toContain("WHEN (NEW.type = 'agent')");
  });

  it('ships a rollback that removes builtin-only schema changes', () => {
    expect(rollbackSql).toContain('DROP TRIGGER IF EXISTS trg_agent_personas_prevent_builtin_insert');
    expect(rollbackSql).toContain('DROP TRIGGER IF EXISTS trg_team_members_seed_builtin_personas ON public.team_members;');
    expect(rollbackSql).toContain('DROP FUNCTION IF EXISTS public.seed_builtin_personas_for_new_agent_member();');
    expect(rollbackSql).toContain('DROP FUNCTION IF EXISTS public.seed_builtin_personas(uuid, uuid, uuid);');
    expect(rollbackSql).toContain('DELETE FROM public.agent_personas WHERE is_builtin = true;');
    expect(rollbackSql).toContain('DROP COLUMN IF EXISTS is_builtin');
  });
});
