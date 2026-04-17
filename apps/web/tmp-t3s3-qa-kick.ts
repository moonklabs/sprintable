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

  const content = `까심군, T3:S3 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/283
**Story**: 1c624587-58fd-479e-9c17-3ce64ca12e53
**Commit**: 6e72d4c

**변경 범위**:
- \`packages/mcp-server/src/pm-api.ts\`: fetchWithRetry() 내부 헬퍼 추가
  - AbortSignal.timeout(30_000) — PM API 30s 글로벌 타임아웃
  - TypeError(네트워크 에러) 시 1회 retry, 4xx/5xx 비재시도
  - TimeoutError/AbortError → PmApiError(408, 'PM API request timed out')
- \`packages/mcp-server/src/index.ts\`:
  - supabase 클라이언트 global.fetch에 AbortSignal.timeout(15_000) → 모든 Supabase 쿼리 15s 자동 적용
  - tool Proxy handler: Promise.race([origHandler(p), toolTimeout(60s)])
  - 타임아웃 시 mcpError('TIMEOUT', 'Tool execution timed out (60s)') 반환
- \`packages/mcp-server/src/pm-api.test.ts\` 신규: 4 unit tests

**테스트**: 133 tests passed (vitest)`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('QA 킥 reply 전송:', reply.id);
}

main().catch(console.error);
