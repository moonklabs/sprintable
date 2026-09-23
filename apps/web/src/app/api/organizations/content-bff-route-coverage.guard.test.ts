import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * story #3445 — FE가 fetchWithAuth로 부르는 `/api/organizations/...` 경로마다
 * 대응하는 BFF route.ts+메서드가 실제로 존재하는지 소스를 훑어 대조한다. 채널 포스트 상세
 * 단건 GET(drafts/[draftId])이 형제 5개(cancel-scheduled·publish·submit·unpublish·versions)
 * 만 있고 정작 이 라우트가 없어 상세 첫 로드가 항상 404였던 결함 — page.test는 fetchWithAuth를
 * 목킹해 이 클래스의 결함을 원천적으로 못 잡는다(project_built_but_nowhere_to_run_class).
 *
 * story #3953 CHANGES(페드루 PO 리뷰, 2026-09-23) — 예전엔 이름 붙인 폴더 목록
 * (CONTENT_DIRS)만 스캔해서, "목록 밖 새 화면이 목록 밖 라우트를 부르는" 바로 그
 * 결함 클래스가 가드 밖에 남아 있었다(사람이 목록에 추가하는 걸 잊으면 조용히
 * 통과). 지금은 `apps/web/src` 전체(테스트 파일 제외)를 스캔한다 — 새 화면·
 * 컴포넌트를 등재하는 사람 규율에 의존하지 않는다.
 *
 * ⛔이 가드가 못 잡는 것:
 * - fetchWithAuth 호출이 아닌 곳(별도 헬퍼로 감싼 호출, 서버 컴포넌트의 직접 fetch)
 * - 템플릿 리터럴이 아닌 동적 문자열 조립(`'/api/organizations/' + orgId + ...`)
 * - `/api/organizations/` 밖의 BFF 경로(예: `/api/gates`) — 스코프 밖
 * - fetchWithAuth 호출부터 200자 밖에 있는 `method:` 옵션(위양성 방지용 탐색 폭 제한 —
 *   해당 클래스는 지금까지 전부 같은 줄이거나 바로 다음 줄이라 실측상 미발생)
 *
 * **동적 세그먼트를 리터럴 형제 디렉터리가 전부 흡수하는 경우**(Next.js는 같은
 * 레벨에서 리터럴 이름이 `[bracket]` 동적보다 항상 우선)는 위양성을 낼 수 있다
 * (`[channel]`·`[operation]` 자리에 route.ts가 없어도, 실제 값의 우주가 전부
 * 자기 리터럴 route.ts를 가진 형제 폴더라면 라이브는 정상). 이 가드는 그 우주를
 * `KNOWN_LITERAL_FANOUTS`에 **명시적으로 선언한 자리에서만** 리터럴 형제로
 * 대체 검사한다 — 선언 없는 동적 세그먼트는 기본값 그대로 **RED**(닫힌 실패,
 * 새 호출이 이 구멍에 몰래 올라타는 것 방지). 실측 사례(2026-09-23, `apps/web/src`
 * 전체 스캔 91곳 중 2곳):
 *   - `channel-connections/${channel}` POST(pasted-secret-connect-card.tsx) →
 *     wordpress|ghost|stibee, 각자 자기 route.ts에 POST 有.
 *   - `ads-boosts/${gateId}/${operation}` POST(boost-execution-control.tsx) →
 *     start|pause|resume, 각자 자기 route.ts에 POST 有.
 */

const SRC_ROOT = join(__dirname, '../../..');
const API_ROOT = join(__dirname, '../../../app/api');

/** 키 = 'api' 제외, 변수명을 그대로 살린 세그먼트 경로(마지막 세그먼트가 그
 * 우주여야 함 — route.ts가 그 리터럴 폴더 바로 안에 있는 경우만 지원). */
const KNOWN_LITERAL_FANOUTS: Record<string, string[]> = {
  'organizations/${orgId}/channel-connections/${channel}': ['wordpress', 'ghost', 'stibee'],
  'organizations/${orgId}/ads-boosts/${gateId}/${operation}': ['start', 'pause', 'resume'],
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

interface CallSite {
  file: string;
  template: string;
  method: string;
}

function extractCalls(files: string[]): CallSite[] {
  const calls: CallSite[] = [];
  const callRe = /fetchWithAuth\(\s*`(\/api\/organizations\/[^`]*)`/g;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src))) {
      const template = m[1];
      const window = src.slice(m.index, m.index + 200);
      const methodMatch = window.match(/method:\s*['"]([A-Z]+)['"]/);
      calls.push({ file, template, method: methodMatch ? methodMatch[1] : 'GET' });
    }
  }
  return calls;
}

/** `${orgId}` 등 인터폴레이션을 dynamic 마커로, 나머지는 리터럴 세그먼트로 쪼갠다.
 * dynamic 세그먼트는 `value`에 원문(`${orgId}` 등 변수명 포함)을 그대로 보존한다 —
 * KNOWN_LITERAL_FANOUTS 조회 키가 이 원문에 의존한다. */
function templateSegments(template: string): { value: string; dynamic: boolean }[] {
  const withoutQuery = template.split('?')[0];
  return withoutQuery
    .split('/')
    .filter(Boolean)
    .map((seg) => (/^\$\{.*\}$/.test(seg) ? { value: seg, dynamic: true } : { value: seg, dynamic: false }));
}

/** 세그먼트를 apps/web/src/app/api 트리에서 순서대로 내려가며 route.ts 디렉터리를 찾는다. */
function resolveRouteDir(segments: { value: string; dynamic: boolean }[]): string | null {
  // 첫 세그먼트 'api'는 API_ROOT가 이미 흡수했다.
  let dir = API_ROOT;
  const rest = segments.slice(1);
  for (const seg of rest) {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const literalMatch = !seg.dynamic && entries.find((e) => e.name === seg.value);
    const dynamicMatch = seg.dynamic && entries.find((e) => /^\[.+\]$/.test(e.name));
    const next = literalMatch || dynamicMatch;
    if (!next) return null;
    dir = join(dir, next.name);
  }
  return dir;
}

/** 마지막 세그먼트가 KNOWN_LITERAL_FANOUTS에 선언된 동적 우주라면, 그 우주의
 * 리터럴 형제 디렉터리들을 반환한다(선언 없으면 null — 닫힌 실패로 떨어진다). */
function resolveFanoutDirs(segments: { value: string; dynamic: boolean }[]): string[] | null {
  const key = segments.slice(1).map((s) => s.value).join('/');
  const literals = KNOWN_LITERAL_FANOUTS[key];
  if (!literals) return null;
  const parentDir = resolveRouteDir(segments.slice(0, -1));
  if (!parentDir) return null;
  return literals.map((lit) => join(parentDir, lit));
}

function exportsMethod(routeTsPath: string, method: string): boolean {
  const src = readFileSync(routeTsPath, 'utf8');
  return new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(src)
    || new RegExp(`export\\s+function\\s+${method}\\b`).test(src);
}

function routeTsExistsAndExports(dir: string, method: string): { exists: boolean; exportsIt: boolean; routeTs: string } {
  const routeTs = join(dir, 'route.ts');
  let exists = true;
  try {
    statSync(routeTs);
  } catch {
    exists = false;
  }
  return { exists, exportsIt: exists && exportsMethod(routeTs, method), routeTs };
}

type Segment = { value: string; dynamic: boolean };

/** 한 호출의 판정 — 통과면 null, 실패면 사유 문자열. */
function checkCall(segments: Segment[], method: string): string | null {
  const dir = resolveRouteDir(segments);
  if (dir) {
    const direct = routeTsExistsAndExports(dir, method);
    if (direct.exists) return direct.exportsIt ? null : `${direct.routeTs} 가 ${method} export 안 함`;
  }
  // 일반 경로에 route.ts가 없으면(디렉터리 자체 미해소 포함), 선언된 리터럴 우주로만
  // 구제한다 — 선언 없으면 닫힌 실패.
  const fanoutDirs = resolveFanoutDirs(segments);
  if (!fanoutDirs) return 'BFF 디렉터리를 찾지 못함(리터럴 우주 선언도 없음)';
  for (const fdir of fanoutDirs) {
    const { exists, exportsIt, routeTs } = routeTsExistsAndExports(fdir, method);
    if (!exists) return `route.ts 없음: ${routeTs}`;
    if (!exportsIt) return `${routeTs} 가 ${method} export 안 함`;
  }
  return null;
}

/** 같은 호출을 한 번만 검사한다. 키는 변수명을 살린 원문 템플릿 — 동적 세그먼트를 `*`로
 * 뭉개면 미선언 `${unknownChannel}` 호출이 선언된 `${channel}`과 같은 키가 돼, 파일 순서상
 * 뒤에 오면 검사 없이 빠진다(까디르 QA 재현, PR #4539). KNOWN_LITERAL_FANOUTS 조회도
 * 같은 원문 키를 쓰므로 두 축이 같은 단위로 맞물린다. */
function dedupeCalls(calls: CallSite[]): { call: CallSite; segments: Segment[] }[] {
  const seen = new Set<string>();
  const out: { call: CallSite; segments: Segment[] }[] = [];
  for (const call of calls) {
    const segments = templateSegments(call.template);
    const key = `${segments.map((s) => s.value).join('/')} ${call.method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ call, segments });
  }
  return out;
}

describe('org BFF 경로 커버리지 가드(story #3445, story #3953 CHANGES — apps/web/src 전체)', () => {
  const files = listSourceFiles(SRC_ROOT);
  const calls = extractCalls(files);

  it('스캔 대상이 비어있지 않다(가드 자체가 죽은 채 항상 통과하는 것 방지)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  for (const { call, segments } of dedupeCalls(calls)) {
    it(`${call.template} [${call.method}] → route.ts 존재 + 메서드 export (${call.file.split('/src/')[1]})`, () => {
      expect(checkCall(segments, call.method), call.template).toBeNull();
    });
  }
});

describe('중복제거가 미선언 동형 호출을 삼키지 않는다(PR #4539 까디르 QA)', () => {
  const declared: CallSite = { file: 'aa.tsx', template: '/api/organizations/${orgId}/channel-connections/${channel}', method: 'POST' };
  const undeclared: CallSite = { file: 'zz.tsx', template: '/api/organizations/${orgId}/channel-connections/${unknownChannel}', method: 'POST' };

  for (const [label, order] of [['선언 → 미선언', [declared, undeclared]], ['미선언 → 선언', [undeclared, declared]]] as const) {
    it(`파일 순서 ${label}: 미선언 \${unknownChannel} 호출이 검사되고 RED다`, () => {
      const verdicts = dedupeCalls([...order]).map(({ call, segments }) => ({ template: call.template, reason: checkCall(segments, call.method) }));
      const undeclaredVerdict = verdicts.find((v) => v.template === undeclared.template);
      expect(undeclaredVerdict, '미선언 호출이 중복제거로 사라짐').toBeDefined();
      expect(undeclaredVerdict?.reason).not.toBeNull();
      expect(verdicts.find((v) => v.template === declared.template)?.reason).toBeNull();
    });
  }
});
