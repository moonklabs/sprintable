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
 * - 세 모양을 본다(story #4347 AC5): 변수에 담기(`const me = await getAuthContext(...)`) · 구조분해(`const { org_id } = ...` — `...rest`면
 *   통째로 넘긴 것으로 보고 걸지 않는다) · 인라인(`(await getAuthContext(req)).org_id`).
 * - 못 보는 것: 핸들러 밖 도우미 함수 안의 호출(지금 0곳 — 필요해지면 넓힌다) · `let` 뒤 재할당 같은 드문 모양.
 *
 * 예외 부류(story #4347 · 까디르 P1): BE를 거치지 않고 **스토리지에 직접 쓰는** 핸들러(`putObject(`)는 BE 재인가가 없어 인가가 `/me`(멤버 행
 * 실조회)뿐이다 — claim만 보는 `getOrgProjectAuthContext`면 접근이 취소돼도 JWT 만료 전까지 옛 org/프로젝트 경로에 올리기가 된다. 그래서
 * 이 핸들러는 톱니에서 빼고(`getAuthContext` 유지), 거꾸로 `getOrgProjectAuthContext`를 쓰면 RED다.
 * 못 보는 것: `putObject` 말고 다른 이름으로 쓰는 경로 · 도우미 함수 안의 쓰기(지금 BFF 직접 쓰기는 전부 `putObject(`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FULL_ONLY_FIELDS = new Set(['id', 'project_name', 'scope']);

/** BE 재인가 없이 스토리지에 직접 쓰는 핸들러 표식(story #4347). */
const DIRECT_STORAGE_WRITE = /\bputObject\(/;

/** 핸들러 본문들(«메서드» → 본문). */
function handlerBodies(source: string): Array<[string, string]> {
  const parts = ('\n' + source).split(/\nexport (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/);
  const out: Array<[string, string]> = [];
  for (let i = 1; i < parts.length; i += 2) out.push([parts[i], parts[i + 1]]);
  return out;
}

/** 스토리지에 직접 쓰면서 claim만 보는 인증을 쓰는 핸들러(메서드들) — 있으면 안 된다. */
export function scanDirectStorageClaimOnly(source: string): string[] {
  return handlerBodies(source)
    .filter(([, body]) => DIRECT_STORAGE_WRITE.test(body) && body.includes('getOrgProjectAuthContext('))
    .map(([method]) => method);
}

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
    if (!body.includes('getAuthContext(')) continue;
    if (DIRECT_STORAGE_WRITE.test(body)) continue;  // 직접 스토리지 쓰기 — `/me` 재인가가 필요하다(위 예외 부류)
    const fields = new Set<string>();
    let needsFull = false;
    let seen = false;
    // ① 변수에 담기
    for (const m of body.matchAll(/const (\w+) = await getAuthContext\(/g)) {
      seen = true;
      const v = m[1];
      for (const x of body.matchAll(new RegExp(`\\b${v}\\??\\.([a-zA-Z_]+)`, 'g'))) fields.add(x[1]);
      if (new RegExp(`[(,]\\s*${v}\\s*[,)]|\\.\\.\\.${v}\\b`).test(body)) needsFull = true;
    }
    // ② 구조분해 — `a: b`는 a가 읽는 칸 · `...rest`는 통째로
    for (const m of body.matchAll(/const \{([^}]*)\} = await getAuthContext\(/g)) {
      seen = true;
      for (const raw of m[1].split(',')) {
        const part = raw.trim();
        if (!part) continue;
        if (part.startsWith('...')) { needsFull = true; continue; }
        fields.add(part.split(':')[0].split('=')[0].trim());
      }
    }
    // ③ 인라인 — `(await getAuthContext(req)).x` / `?.x`
    for (const m of body.matchAll(/\(await getAuthContext\([^)]*\)\)\??\.([a-zA-Z_]+)/g)) {
      seen = true;
      fields.add(m[1]);
    }
    if (!seen || needsFull || [...fields].some((f) => FULL_ONLY_FIELDS.has(f))) continue;
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

/** story #4347 — 75곳을 다 옮겨 빈 목록으로 고정한다(BE `/me`의 project_id · org_id는 JWT claim 그대로라 light 경로와 같은 값). 늘리지 않는다. */
const BASELINE: readonly string[] = [];

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

  it('판정 대조(story #4347 AC5) — 구조분해 · 인라인 사용도 잡는다', () => {
    const wrap = (line: string) => `export async function GET(request: Request) {\n  ${line}\n}`;
    // 양성: /me 전용 칸 없이 구조분해 · 인라인으로 쓰면 걸린다
    expect(scanRouteSource(wrap('const { org_id } = await getAuthContext(request);\n  return use(org_id);')))
      .toEqual([{ method: 'GET', fields: ['org_id'] }]);
    expect(scanRouteSource(wrap('const { org_id: orgId, project_id } = await getAuthContext(request);')))
      .toEqual([{ method: 'GET', fields: ['org_id', 'project_id'] }]);
    expect(scanRouteSource(wrap('return use((await getAuthContext(request))?.org_id);')))
      .toEqual([{ method: 'GET', fields: ['org_id'] }]);
    // 음성: 전용 칸을 구조분해 · 인라인으로 읽거나, 나머지를 통째로 받으면 안 걸린다
    expect(scanRouteSource(wrap('const { id, org_id } = await getAuthContext(request);'))).toEqual([]);
    expect(scanRouteSource(wrap('return use((await getAuthContext(request)).project_name);'))).toEqual([]);
    expect(scanRouteSource(wrap('const { org_id, ...rest } = await getAuthContext(request);\n  return helper(rest);'))).toEqual([]);
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

  it('판정 대조(story #4347) — 스토리지에 직접 쓰는 핸들러는 톱니에서 빠지고, claim만 보는 인증이면 걸린다', () => {
    const wrap = (auth: string) =>
      `export async function POST(request: Request) {\n  const me = await ${auth}(request);\n  await storage.putObject(B, \`org/\${me.org_id}\`, body, t);\n}`;
    expect(scanRouteSource(wrap('getAuthContext'))).toEqual([]);
    expect(scanDirectStorageClaimOnly(wrap('getAuthContext'))).toEqual([]);
    expect(scanDirectStorageClaimOnly(wrap('getOrgProjectAuthContext'))).toEqual(['POST']);
    // 쓰지 않는 핸들러는 이 규칙과 무관
    expect(scanDirectStorageClaimOnly(`export async function GET(request: Request) {\n  const me = await getOrgProjectAuthContext(request);\n}`)).toEqual([]);
  });

  it('스토리지에 직접 쓰는 핸들러는 claim만 보는 인증을 쓰지 않는다(BE 재인가 없음 → /me로 재인가)', () => {
    const offenders: string[] = [];
    const writers: string[] = [];
    for (const rel of routeFiles()) {
      const source = readFileSync(path.join(API_DIR, rel), 'utf8');
      for (const [method, body] of handlerBodies(source)) if (DIRECT_STORAGE_WRITE.test(body)) writers.push(`${rel} ${method}`);
      for (const method of scanDirectStorageClaimOnly(source)) offenders.push(`${rel} ${method}`);
    }
    expect(offenders, '이 핸들러는 getAuthContext로(스토리지 직접 쓰기 전 멤버 행 재인가)').toEqual([]);
    // 대조 — 스캐너가 실제 직접 쓰기 자리를 본다(import-image · 대화 · 문서 · 스토리 첨부 · storage/local).
    expect(writers).toContain('visual-artifacts/import-image/route.ts POST');
    expect(writers.length).toBeGreaterThanOrEqual(5);
  });

  it('스캐너가 실제 라우트를 읽는다(헛돌지 않음)', () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => readFileSync(path.join(API_DIR, f), 'utf8').includes('getAuthContext('))).toBe(true);
  });
});
