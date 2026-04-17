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

  const content = `까심군, T3:S1 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/281
**Story**: c3d6b655-036f-4858-ba5b-5161b1a60ff0
**Commit**: 2692e24

**변경 범위**:
- \`packages/mcp-server/src/tools/error.ts\` 신규: McpErrorCode 타입 + mcpError() + mcpHandleError() + ok() 공유 모듈
- \`context.ts\`: resolveProjectContext() errorCode 필드 추가 (AUTH_FAILED/INVALID_INPUT/NOT_FOUND)
- \`comm.ts\` + \`index.ts\`: 로컬 err() → mcpError('CODE', msg) 교체
- 14개 pmApi 모듈: 로컬 err/ok/handleError 제거, 공유 모듈로 통일 (memos/notifications/epics/sprints/stories/tasks/docs/meetings/standups/retro/rewards/standup-retro/analytics/agent-runs)
- \`smoke.test.ts\`: parseResult() JSON 파싱 기반 업데이트, 20개 에러 assertion → toMatchObject 전환
- \`apps/web/src/app/llms.txt/route.ts\`: Error Codes 섹션 추가

**테스트**: 111 tests passed (vitest)`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('QA 킥 reply 전송:', reply.id);
}

main().catch(console.error);
