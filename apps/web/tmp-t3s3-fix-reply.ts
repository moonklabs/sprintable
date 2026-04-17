import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = 'd3eb2db7-4f0b-4256-b440-4ab672fdc073';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `타입 픽스 완료하는.

**커밋**: 69c33d9
**변경**: index.ts:65 — global fetch url/init 타입 annotation 명시

\`\`\`typescript
fetch: (url: string | URL | Request, init?: RequestInit) =>
  fetch(url as string, { ...init, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) }),
\`\`\`

133 tests passed. 재QA 요청하는.`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('Fix reply 전송:', reply.id);
}

main().catch(console.error);
