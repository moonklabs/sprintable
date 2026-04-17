/**
 * Seed policy documents from markdown files into Supabase policy_documents.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... TARGET_ORG_ID=... TARGET_PROJECT_ID=... \
 *   npx tsx packages/scripts/seed-policy-documents.ts [--context-root ~/jangsawang/.context/sprints]
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const contextArgIndex = process.argv.indexOf('--context-root');
const contextRoot = contextArgIndex >= 0
  ? resolve(process.argv[contextArgIndex + 1])
  : resolve(process.env.HOME ?? '~', 'jangsawang', '.context', 'sprints');

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ORG_ID = process.env.TARGET_ORG_ID!;
const PROJECT_ID = process.env.TARGET_PROJECT_ID!;

if (!SUPABASE_URL || !SUPABASE_KEY || !ORG_ID || !PROJECT_ID) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TARGET_ORG_ID / TARGET_PROJECT_ID');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sprintKeyFromTitle(title: string): string | null {
  const match = title.match(/Sprint\s+(\d+)/i);
  return match ? `s${match[1]}`.toLowerCase() : null;
}

function epicKeyFromTitle(title: string): string | null {
  const match = title.match(/(E-\d+[A-Z]?)/i);
  return match ? match[1].toUpperCase() : null;
}

async function main() {
  const { data: sprints } = await supabase.from('sprints').select('id, title').eq('project_id', PROJECT_ID);
  const { data: epics } = await supabase.from('epics').select('id, title').eq('project_id', PROJECT_ID);

  const sprintByKey = new Map((sprints ?? []).map((s) => [sprintKeyFromTitle(s.title) ?? '', s]));
  const epicByKey = new Map((epics ?? []).map((e) => [epicKeyFromTitle(e.title) ?? '', e]));

  const sprintDirs = readdirSync(contextRoot).filter((name) => existsSync(resolve(contextRoot, name, 'epic-specs')));

  for (const sprintKey of sprintDirs) {
    const sprint = sprintByKey.get(sprintKey.toLowerCase());
    if (!sprint) continue;

    const epicDir = resolve(contextRoot, sprintKey, 'epic-specs');
    const files = readdirSync(epicDir).filter((name) => name.endsWith('.md') && name !== 'README.md');

    for (const file of files) {
      const content = readFileSync(resolve(epicDir, file), 'utf8');
      const legacyEpicKey = file.replace(/\.md$/i, '');
      const epic = epicByKey.get(legacyEpicKey.toUpperCase());
      if (!epic) continue;

      await supabase.from('policy_documents').upsert({
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        sprint_id: sprint.id,
        epic_id: epic.id,
        title: epic.title,
        content,
        legacy_sprint_key: sprintKey,
        legacy_epic_key: legacyEpicKey,
      }, { onConflict: 'project_id,sprint_id,epic_id' });

      console.log(`seeded ${sprintKey}/${legacyEpicKey}`);
    }
  }
}

void main();
