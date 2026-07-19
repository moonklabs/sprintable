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
 *
 * codex 리뷰(PR #2296) 반영: (1) 스캔이 실제로 파일을 훑었는지 자체 검증하는 sanity floor,
 * (2) `'/api/v2/' + 'mcp'` 같은 분할 문자열 손조립이 인접 리터럴 이음매(`' + '`)를 제거하는
 * 정규화 단계를 우회하지 않도록 스캔 전 정규화, (3) 정규식 자체의 양성/음성 fixture 테스트.
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
export const BARE_MCP_URL_RE = /\/api\/v2\/mcp(?![\w/-])/;

// 인접 문자열 리터럴 이음매(`' + '`/`" + "`/`` ` + ` ``)를 제거해 `'/api/v2/' + 'mcp'` 같은 분할
// 손조립을 `'/api/v2/mcp'`로 합친 뒤 스캔한다 — 그래야 연속 리터럴만 잡는 정규식이 split-handbuild도
// 잡는다. 따옴표 종류가 섞여도(예: `'/api/v2/' + "mcp"`) 매치되도록 각 side 독립적으로 매치.
export function normalizeConcatSeams(content: string): string {
  return content.replace(/["'`]\s*\+\s*["'`]/g, '');
}

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

describe('BARE_MCP_URL_RE + normalizeConcatSeams fixtures', () => {
  it('matches a bare template-literal-assembled MCP URL', () => {
    const src = 'const url = `${getAppOrigin()}/api/v2/mcp`;';
    expect(BARE_MCP_URL_RE.test(normalizeConcatSeams(src))).toBe(true);
  });

  it('normalizeConcatSeams joins split-string hand-builds into the bare form', () => {
    const src = "const url = '/api/v2/' + 'mcp';";
    expect(normalizeConcatSeams(src)).toBe("const url = '/api/v2/mcp';");
  });

  it('BARE_MCP_URL_RE matches the split-string form once normalized (the actual guard path)', () => {
    const src = "const url = '/api/v2/' + 'mcp';";
    expect(BARE_MCP_URL_RE.test(normalizeConcatSeams(src))).toBe(true);
  });

  it('does not match /api/v2/mcp/manifest', () => {
    expect(BARE_MCP_URL_RE.test(normalizeConcatSeams("'/api/v2/mcp/manifest'"))).toBe(false);
  });

  it('does not match /api/v2/mcp/toolset-catalog', () => {
    expect(BARE_MCP_URL_RE.test(normalizeConcatSeams("'/api/v2/mcp/toolset-catalog'"))).toBe(false);
  });

  it('does not match /api/v2/mcp/mockups', () => {
    expect(BARE_MCP_URL_RE.test(normalizeConcatSeams("'/api/v2/mcp/mockups'"))).toBe(false);
  });
});

describe('MCP URL hand-assembly guard (story #2015)', () => {
  it('apps/web/src contains zero hand-built bare `/api/v2/mcp` MCP-server URLs', () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);

    // Sanity floor — proves the walker actually traversed the tree instead of passing vacuously
    // (e.g. after an accidental path/extension change that makes `files` empty).
    expect(files.length).toBeGreaterThan(100);

    const violations: string[] = [];
    for (const abs of files) {
      const content = readFileSync(abs, 'utf8');
      if (BARE_MCP_URL_RE.test(normalizeConcatSeams(content))) {
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
