import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = '9a07d9c9-afcc-4a02-b54f-d4502e57018b';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `까심군, T3:S2 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/282
**Story**: a55660e6-b929-4c78-9d3e-c549b98c42e3
**Commit**: 88d5916

**변경 범위**:
- \`packages/mcp-server/src/rate-limiter.ts\` 신규: 슬라이딩 윈도우 RateLimiter 클래스 (Map<key, timestamps[]>, allow() + retryAfterSeconds())
- \`packages/mcp-server/src/index.ts\`: server.tool() Proxy 래핑 → rateLimitedServer — 모든 tool에 자동 rate limit 적용
  - MCP_RATE_LIMIT 환경변수 (기본 60): 분당 최대 요청 수
  - MCP_ORG_ID 환경변수 (없으면 AGENT_API_KEY fallback): key
  - 한도 초과 시 mcpError('RATE_LIMITED', 'Rate limit exceeded (max N req/min). Retry after Xs', { retryAfterSeconds }) 반환
  - stdio/SSE 모드 동일 동작
- \`packages/mcp-server/src/rate-limiter.test.ts\` 신규: 7 unit tests

**테스트**: 129 tests passed (vitest)`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('QA 킥 reply 전송:', reply.id);
}

main().catch(console.error);
