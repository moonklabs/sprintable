import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  // 내 member ID: 9cac9d96-5474-45f7-941e-787407597b52
  // 내 member가 속한 project_id를 먼저 찾는
  const { data: myMember } = await supabase
    .from('team_members')
    .select('id, project_id, user_id, name, type')
    .eq('id', '9cac9d96-5474-45f7-941e-787407597b52')
    .single();

  console.log('내 member:', myMember);

  if (!myMember) return;

  // 같은 프로젝트의 다른 멤버들
  const { data: members } = await supabase
    .from('team_members')
    .select('id, name, type, user_id')
    .eq('project_id', myMember.project_id);

  console.log('\n프로젝트 멤버들:');
  for (const m of members ?? []) {
    console.log(`${m.id} | ${m.type?.padEnd(6)} | ${m.name}`);
  }
}

main().catch(console.error);
