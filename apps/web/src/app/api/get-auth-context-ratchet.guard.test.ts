/**
 * story #4346 — 톱니 가드: `/me` 전용 칸(id · project_name · scope)을 안 읽는 BFF 핸들러가 `getAuthContext`를 쓰면 RED.
 *
 * `getAuthContext`는 사람 세션이면 요청마다 `GET /api/v2/me`를 왕복한다(React `cache`는 요청 하나 안에서만 묶음). org · project ·
 * rate-limit만 필요하면 `getOrgProjectAuthContext`(story 7d6b770b · JWT claim이 있으면 `/me` 0)로 충분하다. 콜드 기동 목록 GET 셋이
 * 이 부류로 `/me`를 7번 더 불렀다(민 4299 재측).
 *
 * - 지금 남은 자리는 `BASELINE`에 묶는다(story #4347이 라우트별로 검토해 옮기며 줄인다) — **줄이기만**: 새 자리는 RED, 옮겨서 더 이상
 *   걸리지 않는 자리가 목록에 남아 있어도 RED(목록이 낡으면 새 자리가 그 이름 뒤에 숨는다).
 * - 판정은 보수적: 컨텍스트 변수를 통째로 넘기거나 펼치면(함수 인자 · `...me`) 그 안에서 전용 칸을 읽을 수 있다고 보고 걸지 않는다.
 * - 못 보는 것: `getAuthContext` 결과를 변수에 담지 않고 바로 쓰는 모양 · 핸들러 밖 도우미 함수 안의 호출(지금 0곳 — 필요해지면 넓힌다).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FULL_ONLY_FIELDS = new Set(['id', 'project_name', 'scope']);

export interface FlaggedHandler {
  method: string;
  fields: string[];
}

/** 파일 하나에서 `getAuthContext`를 쓰지만 `/me` 전용 칸이 필요 없는 핸들러들. */
export function scanRouteSource(source: string): FlaggedHandler[] {
  const parts = ('\n' + source).split(/\nexport (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/);
  const flagged: FlaggedHandler[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const method = parts[i];
    const body = parts[i + 1];
    const m = /const (\w+) = await getAuthContext\(/.exec(body);
    if (!m) continue;
    const v = m[1];
    const fields = new Set([...body.matchAll(new RegExp(`\\b${v}\\.([a-zA-Z_]+)`, 'g'))].map((x) => x[1]));
    const passedWhole = new RegExp(`[(,]\\s*${v}\\s*[,)]|\\.\\.\\.${v}\\b`).test(body);
    if (passedWhole || [...fields].some((f) => FULL_ONLY_FIELDS.has(f))) continue;
    flagged.push({ method, fields: [...fields].sort() });
  }
  return flagged;
}

const API_DIR = path.resolve(__dirname);

/** API_DIR 아래 모든 route.ts(상대 경로 · `/` 구분). */
function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'route.ts') out.push(path.relative(API_DIR, full).split(path.sep).join('/'));
    }
  };
  walk(API_DIR);
  return out.sort();
}

function scanRepo(): string[] {
  const out: string[] = [];
  for (const rel of routeFiles()) {
    const source = readFileSync(path.join(API_DIR, rel), 'utf8');
    if (!source.includes('getAuthContext(')) continue;
    for (const h of scanRouteSource(source)) out.push(`${rel} ${h.method}`);
  }
  return out;
}

/** story #4347이 옮기며 줄이는 목록(«파일 메서드»). 늘리지 않는다. */
const BASELINE: readonly string[] = [
  'agents/[id]/recruit/route.ts POST',
  'auth/change-password/route.ts PATCH',
  'auth/oauth/unlink/route.ts POST',
  'auth/set-password/request/route.ts POST',
  'current-project/route.ts GET',
  'docs/[id]/updated-at/route.ts GET',
  'docs/route.ts GET',
  'evidence/[id]/route.ts GET',
  'evidence/route.ts GET',
  'evidence/route.ts POST',
  'goals/[id]/route.ts GET',
  'goals/[id]/route.ts PATCH',
  'goals/[id]/route.ts DELETE',
  'goals/bulk/route.ts PATCH',
  'goals/route.ts POST',
  'hypotheses/[id]/links/route.ts POST',
  'hypotheses/[id]/links/route.ts DELETE',
  'hypotheses/[id]/route.ts GET',
  'hypotheses/[id]/route.ts PATCH',
  'hypotheses/[id]/route.ts DELETE',
  'hypotheses/[id]/transition/route.ts POST',
  'hypotheses/draft/route.ts POST',
  'hypotheses/guided/route.ts POST',
  'hypotheses/route.ts GET',
  'hypotheses/route.ts POST',
  'meetings/route.ts GET',
  'meetings/route.ts POST',
  'notification-preferences/route.ts GET',
  'notification-preferences/route.ts PUT',
  'project-settings/route.ts GET',
  'project-settings/route.ts PATCH',
  'projects/[id]/route.ts GET',
  'projects/[id]/route.ts PATCH',
  'projects/[id]/route.ts DELETE',
  'projects/route.ts POST',
  'references/route.ts POST',
  'rewards/leaderboard/route.ts GET',
  'rewards/route.ts GET',
  'role-templates/route.ts GET',
  'runtime-capabilities/route.ts GET',
  'sprints/[id]/activate/route.ts POST',
  'sprints/[id]/burndown/route.ts GET',
  'sprints/[id]/kickoff/route.ts POST',
  'sprints/[id]/route.ts GET',
  'sprints/[id]/route.ts PATCH',
  'sprints/[id]/route.ts DELETE',
  'sprints/route.ts POST',
  'stories/[id]/route.ts GET',
  'stories/[id]/route.ts DELETE',
  'stories/route.ts POST',
  'tasks/[id]/route.ts GET',
  'tasks/[id]/route.ts PATCH',
  'tasks/[id]/route.ts DELETE',
  'tasks/route.ts GET',
  'tasks/route.ts POST',
  'visual-artifacts/[id]/backlinks/route.ts GET',
  'visual-artifacts/[id]/comments/[commentId]/resolve/route.ts POST',
  'visual-artifacts/[id]/comments/route.ts GET',
  'visual-artifacts/[id]/comments/route.ts POST',
  'visual-artifacts/[id]/edit/route.ts POST',
  'visual-artifacts/[id]/exports/route.ts GET',
  'visual-artifacts/[id]/pins/[pinId]/route.ts PATCH',
  'visual-artifacts/[id]/pins/[pinId]/route.ts DELETE',
  'visual-artifacts/[id]/pins/route.ts GET',
  'visual-artifacts/[id]/pins/route.ts POST',
  'visual-artifacts/[id]/route.ts GET',
  'visual-artifacts/[id]/versions/[versionNumber]/canonicalize/route.ts POST',
  'visual-artifacts/[id]/versions/[versionNumber]/export/html/route.ts POST',
  'visual-artifacts/[id]/versions/[versionNumber]/export/png/complete/route.ts POST',
  'visual-artifacts/[id]/versions/[versionNumber]/export/png/upload-url/route.ts POST',
  'visual-artifacts/[id]/versions/[versionNumber]/route.ts GET',
  'visual-artifacts/[id]/versions/route.ts GET',
  'visual-artifacts/import-image/route.ts POST',
  'visual-artifacts/route.ts GET',
  'visual-artifacts/route.ts POST',
];

describe('getAuthContext 톱니 가드(story #4346)', () => {
  it('판정 대조 — 전용 칸 없이 쓰면 걸리고, 전용 칸을 읽거나 통째로 넘기면 안 걸린다', () => {
    const light = `export async function GET(request: Request) {\n  const me = await getAuthContext(request);\n  return use(me.org_id);\n}`;
    const full = `export async function GET(request: Request) {\n  const me = await getAuthContext(request);\n  return use(me.id);\n}`;
    const passed = `export async function POST(request: Request) {\n  const ctx = await getAuthContext(request);\n  return helper(ctx, 1);\n}`;
    const spread = `export const PATCH = async (request: Request) => {\n  const me = await getAuthContext(request);\n  return use({ ...me });\n};`;
    expect(scanRouteSource(light)).toEqual([{ method: 'GET', fields: ['org_id'] }]);
    expect(scanRouteSource(full)).toEqual([]);
    expect(scanRouteSource(passed)).toEqual([]);
    expect(scanRouteSource(spread)).toEqual([]);
    expect(scanRouteSource(light + '\n' + full.replace('GET', 'POST'))).toEqual([{ method: 'GET', fields: ['org_id'] }]);
  });

  it('새 자리 0 — 목록 밖에서 /me 전용 칸 없이 getAuthContext를 쓰는 핸들러가 없다', () => {
    const extra = scanRepo().filter((k) => !BASELINE.includes(k));
    expect(extra, '이 핸들러는 getOrgProjectAuthContext로(`/me` 전용 칸이 필요하면 그 칸을 실제로 읽는 코드가 있어야 한다)').toEqual([]);
  });

  it('목록이 낡지 않았다 — 옮겨서 더 이상 걸리지 않는 자리는 목록에서 지운다(줄이기만)', () => {
    const found = new Set(scanRepo());
    expect(BASELINE.filter((k) => !found.has(k))).toEqual([]);
    expect(new Set(BASELINE).size).toBe(BASELINE.length);
  });

  it('스캐너가 실제 라우트를 읽는다(헛돌지 않음)', () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => readFileSync(path.join(API_DIR, f), 'utf8').includes('getAuthContext('))).toBe(true);
  });
});
