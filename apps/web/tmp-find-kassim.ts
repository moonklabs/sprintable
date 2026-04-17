import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  const { data } = await supabase
    .from('team_members')
    .select('id, name, type, role')
    .order('created_at', { ascending: false })
    .limit(30);

  for (const m of data ?? []) {
    console.log(`${m.id} | ${m.name} | ${m.type} | ${m.role}`);
  }
}

main().catch(console.error);
