import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const projectId = 'f3e6ed64-447d-4b1c-ad78-a00cfba715a7';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';
  const kassimId = '685f3f72-c85c-4a32-898f-3d3320ba39ad';

  // Get org_id from project
  const { data: project } = await supabase
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .single();
  const orgId = project?.org_id;
  console.log('org_id:', orgId);

  const content = `까심군, T3:S6 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/286
**Story**: 5bd2f879-0976-477d-af67-47f015d455b8
**Commit**: 0b993ba

**변경 범위**:
- \`packages/mcp-server/src/catalog.ts\` 신규: stub McpServer 인스턴스로 등록된 도구 전체 추출 (\`getMcpToolCatalog()\`) — 환경변수 없이 실행 가능
- \`apps/web/src/lib/mcp-tool-catalog.ts\` 신규: 13카테고리 90+ 도구 TOOL_CATALOG + \`generateToolReferenceMd()\` 자동 마크다운 생성
- \`apps/web/src/app/llms-full.txt/route.ts\` 수정: 하드코딩 784줄 제거 → \`generateToolReferenceMd()\` 자동생성, AC3 카테고리별 사용 예제 5종 (stories/memos/board/docs/workflows), AC4 에이전트 시스템 프롬프트 권장 템플릿 추가
- \`apps/web/src/app/docs/mcp-tools/page.tsx\` 신규: 공개 MCP 도구 레퍼런스 페이지 — Server Component, ToC + 카테고리별 도구 카드, /llms-full.txt · /llms.txt 링크

**AC 체크**:
- [x] AC1: /llms-full.txt 도구 목록 자동생성 (하드코딩 금지)
- [x] AC2: /docs/mcp-tools 공개 페이지
- [x] AC3: 카테고리별 사용 예제 5종
- [x] AC4: 에이전트 시스템 프롬프트 권장 템플릿

**참고**: T3:S6 킥오프는 웹훅 메시지로만 전달되어 킥오프 메모가 없어 별도 QA 메모로 발송하는.`;

  const memo = await service.create({
    project_id: projectId,
    org_id: orgId!,
    title: '[QA 요청] T3:S6 MCP 도구 공개 문서',
    content,
    memo_type: 'qa',
    assigned_to_ids: [kassimId],
    created_by: myId,
  });

  console.log('QA 메모 생성:', memo.id);
}

main().catch(console.error);
