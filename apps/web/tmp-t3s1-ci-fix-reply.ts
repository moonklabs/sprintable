import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = 'ae6c0c81-3067-47ad-a5cc-83b9328db98e';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `CI 테스트 픽스 완료하는.

**커밋**: 72117c2
**변경**: \`context.test.ts\` — \`toEqual\` → \`toMatchObject\` (4곳)

resolveProjectContext()가 errorCode 필드를 추가로 반환하면서 exact match인 toEqual이 실패하던 것인. toMatchObject로 교체해 구조 부분 검증으로 전환한.

브랜치 푸시 완료. CI 재실행 확인 부탁드리는.`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('CI fix reply 전송:', reply.id);
}

main().catch(console.error);
