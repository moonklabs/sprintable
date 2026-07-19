/**
 * story #2015 회귀가드 — 2026-05-05부터 웹 UI가 `${origin}/api/v2/mcp`를 streamable-http MCP
 * 서버 URL로 손조립해 배포해 왔다. 이 경로는 backend에 root GET/POST가 없어 상시 404이며, 외부
 * 상주 MCP 클라이언트가 이 설정을 물고 무백오프 재접속 → CF Worker 100k/day 쿼터 소진 인시던트로
 * 이어졌다. 진짜 SSOT는 서버 `mcp_config`(POST /api/v2/agents/{id}/api-keys 응답)이며 FE는 이를
 * 그리기만 해야 한다(손조립 금지). 이 테스트는 그 손조립 패턴의 재유입을 봉쇄한다.
 *
 * 허용 예외: `app/api/mcp/mockups/route.ts`(및 `toolset-catalog/route.ts`)는 `/api/v2/mcp/<subpath>`
 * 형태의 정상 BE 프록시 라우트라 바닥(bare) 엔드포인트가 아니다 — 아래 정규식은 하위경로가 붙은
 * 형태는 매치하지 않으므로 자연히 제외된다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(SRC_ROOT, '../public');

const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

// 바닥(bare) `/api/v2/mcp` 엔드포인트 — 뒤에 word char/`/`/`-`가 오면(하위경로) 매치하지 않는다.
// 즉 `/api/v2/mcp/mockups`·`/api/v2/mcp/toolset-catalog`·`/api/v2/mcp/manifest`는 안전하게 제외.
const BARE_MCP_URL_RE = /\/api\/v2\/mcp(?![\w/-])/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

describe('MCP URL hand-assembly guard (story #2015)', () => {
  it('apps/web/src contains zero hand-built bare `/api/v2/mcp` MCP-server URLs', () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);

    const violations: string[] = [];
    for (const abs of files) {
      const content = readFileSync(abs, 'utf8');
      if (BARE_MCP_URL_RE.test(content)) {
        violations.push(path.relative(SRC_ROOT, abs));
      }
    }

    expect(
      violations,
      `Hand-built bare /api/v2/mcp MCP-server URL found (CF Worker 100k/day leak 재발) in:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('public docs (llms-full.txt, onboarding-guide.txt) never advertise app.sprintable.ai/api/v2/mcp', () => {
    const docs = ['llms-full.txt', 'onboarding-guide.txt'];
    const violations: string[] = [];

    for (const doc of docs) {
      const content = readFileSync(path.join(PUBLIC_ROOT, doc), 'utf8');
      if (content.includes('app.sprintable.ai/api/v2/mcp')) {
        violations.push(doc);
      }
    }

    expect(
      violations,
      `Public doc still advertises the dead app.sprintable.ai/api/v2/mcp endpoint: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});
