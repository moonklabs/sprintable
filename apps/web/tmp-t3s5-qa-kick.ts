import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = '9c28e3f3-e161-4d3c-90d4-ab4df062d28c';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `까심군, T3:S5 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/285
**Story**: 2e024a6a-0991-48ae-a643-791031dfb8c4
**Commit**: 2e47d77

**변경 범위**:
- \`packages/mcp-server/README.md\`:
  - Cursor 설정 가이드: .cursor/mcp.json 형식 + Settings > MCP 탭 확인 안내
  - Windsurf 설정 가이드: ~/.codeium/windsurf/mcp_config.json 형식 + Cascade > MCP Servers 확인
  - Python SDK stdio 클라이언트 예시: pip install mcp + StdioServerParameters + ClientSession
  - 런타임 호환성 매트릭스 테이블 (Claude Desktop/Code/Cursor/Windsurf/Python/SSE 6개 런타임)
  - 공통 요구사항: Node.js 18+, ESM, npx -y 플래그
- \`packages/mcp-server/examples/python-client.py\` 신규: 환경변수 기반 실행 가능 Python 예시

**테스트**: 133 tests passed (vitest)`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('QA 킥 reply 전송:', reply.id);
}

main().catch(console.error);
