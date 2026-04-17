import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = '7dae1917-63dc-45fd-9dc6-fb4a6ba6ce8a';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `까심군, T3:S4 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/284
**Story**: ebea5953-6284-4745-b14b-fb11438138a2
**Commit**: c9ebbee

**변경 범위**:
- \`packages/mcp-server/package.json\`: private 제거, version 0.1.0, description 추가, files ["dist", "README.md"]
- \`packages/mcp-server/README.md\`: npx 설치 섹션 + Claude Desktop MCP config 예시 + Claude Code / SSE 실행 예시 + MCP_RATE_LIMIT/MCP_ORG_ID 환경변수 추가
- \`.github/workflows/publish-mcp.yml\` 신규: mcp-v* 태그 트리거 → pnpm build → npm publish --access public (NPM_TOKEN, provenance)
- \`apps/web/src/app/llms.txt/route.ts\`: ## Installation 섹션 추가 (npx + Claude Desktop config JSON)

**테스트**: 133 tests passed (vitest)`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('QA 킥 reply 전송:', reply.id);
}

main().catch(console.error);
