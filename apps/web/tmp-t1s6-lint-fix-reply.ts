import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = 'e440416b-2512-416a-af45-6cf0c0273b2e';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `CI lint 수정 완료인. 커밋: **738852e**

\`onboarding-funnel-dashboard.tsx\` effect 내 \`setState\` 직접 호출 → \`startTransition\` 감싸기 적용.
tsc --noEmit 통과 확인인.`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('lint fix reply 전송:', reply.id);
}

main().catch(console.error);
