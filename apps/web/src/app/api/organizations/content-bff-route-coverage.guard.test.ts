import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * story #3445 — content 화면이 fetchWithAuth로 부르는 `/api/organizations/...` 경로마다
 * 대응하는 BFF route.ts+메서드가 실제로 존재하는지 소스를 훑어 대조한다. 채널 포스트 상세
 * 단건 GET(drafts/[draftId])이 형제 5개(cancel-scheduled·publish·submit·unpublish·versions)
 * 만 있고 정작 이 라우트가 없어 상세 첫 로드가 항상 404였던 결함 — page.test는 fetchWithAuth를
 * 목킹해 이 클래스의 결함을 원천적으로 못 잡는다(project_built_but_nowhere_to_run_class).
 *
 * ⛔이 가드가 못 잡는 것:
 * - fetchWithAuth 호출이 아닌 곳(별도 헬퍼로 감싼 호출, 서버 컴포넌트의 직접 fetch)
 * - 템플릿 리터럴이 아닌 동적 문자열 조립(`'/api/organizations/' + orgId + ...`)
 * - `/api/organizations/` 밖의 BFF 경로(예: `/api/gates`) — 스코프 밖
 * - fetchWithAuth 호출부터 200자 밖에 있는 `method:` 옵션(위양성 방지용 탐색 폭 제한 —
 *   해당 클래스는 지금까지 전부 같은 줄이거나 바로 다음 줄이라 실측상 미발생)
 * - **동적 세그먼트를 리터럴 형제 디렉터리가 전부 흡수하는 경우**(Next.js는 같은
 *   레벨에서 리터럴 이름이 `[bracket]` 동적보다 항상 우선) — `resolveRouteDir`는
 *   이 우선순위를 모델링하지 않아 위양성(RED인데 실은 라이브 정상)을 낸다. 실측
 *   사례: `pasted-secret-connect-card.tsx`의 `channel-connections/${channel}`
 *   POST는 실제로 `channel`이 항상 wordpress|ghost|stibee 중 하나(각각 자기 리터럴
 *   route.ts에 POST 有)라 `[channel]/route.ts` 부재가 라이브 결함이 아니다(2026-09-23
 *   확認, story #3953 CHANGES 작업 중 발견) — 그래서 `components/channel-connect`
 *   디렉터리 전체가 아니라 실제 결함이 있던 파일 하나만 스캔 대상에 추가한다(아래).
 */

const CONTENT_DIRS = [
  join(__dirname, '../../../app/(authenticated)/content'),
  join(__dirname, '../../../components/content'),
  // story #3503(성과 보드 화면, PO 브리프 명시) — 이 화면은 content 밖(organization/
  // insights-board)에 살지만 같은 클래스(`/api/organizations/...` fetchWithAuth 호출)를
  // 부른다. 이 배열에 안 넣으면 이 스토리가 새로 만든 BFF 호출부(GET insights-board·
  // POST publications/{id}/follow-ups)가 이 가드의 스캔 대상에서 그냥 빠진다(가드가
  // 조용히 통과하지만 실은 아무것도 검사 안 한 것 — 이 파일 상단 스캔 대상 0건 방지
  // 테스트가 있는 이유와 같은 함정).
  join(__dirname, '../../../app/(authenticated)/organization/insights-board'),
  join(__dirname, '../../../components/insights-board'),
  // story #3953 CHANGES(페드루 PO 실측, 2026-09-23) — `/organization/channels`의
  // `ExternalPublishPauseCard`(components/channel-connect)가 부르는 BFF 라우트가
  // 이 배열 밖이라 이 가드가 못 잡고 놓쳤던 결함(GET 404 → catch가 삼켜 카드가
  // 조용히 안 뜸). 위 insights-board 주석과 같은 함정 — 새 org 화면/컴포넌트
  // 디렉터리는 반드시 이 배열에 추가한다.
  join(__dirname, '../../../app/(authenticated)/organization/channels'),
  join(__dirname, '../../../components/channel-connect/external-publish-pause-card.tsx'),
];
const API_ROOT = join(__dirname, '../../../app/api');

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

/** CONTENT_DIRS 항목은 디렉터리(재귀 스캔)이거나 단일 파일(위 ⛔ 항목처럼 형제
 * 파일의 기지 위양성을 피하려 파일 하나만 콕 집어야 할 때)일 수 있다. */
function listSourceEntry(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return /\.tsx?$/.test(path) && !path.includes('.test.') ? [path] : [];
  return listSourceFiles(path);
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

/** `${orgId}` 등 인터폴레이션을 dynamic 마커로, 나머지는 리터럴 세그먼트로 쪼갠다. */
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

function exportsMethod(routeTsPath: string, method: string): boolean {
  const src = readFileSync(routeTsPath, 'utf8');
  return new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(src)
    || new RegExp(`export\\s+function\\s+${method}\\b`).test(src);
}

describe('content BFF 경로 커버리지 가드(story #3445)', () => {
  const files = CONTENT_DIRS.flatMap((d) => listSourceEntry(d));
  const calls = extractCalls(files);

  it('스캔 대상이 비어있지 않다(가드 자체가 죽은 채 항상 통과하는 것 방지)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  const seen = new Set<string>();
  for (const call of calls) {
    const segments = templateSegments(call.template);
    const key = `${segments.map((s) => (s.dynamic ? '*' : s.value)).join('/')} ${call.method}`;
    if (seen.has(key)) continue;
    seen.add(key);

    it(`${call.template} [${call.method}] → route.ts 존재 + 메서드 export (${call.file.split('/src/')[1]})`, () => {
      const dir = resolveRouteDir(segments);
      expect(dir, `${call.template} 에 대응하는 BFF 디렉터리를 찾지 못함`).not.toBeNull();
      const routeTs = join(dir as string, 'route.ts');
      let exists = true;
      try {
        statSync(routeTs);
      } catch {
        exists = false;
      }
      expect(exists, `route.ts 없음: ${routeTs}`).toBe(true);
      expect(exportsMethod(routeTs, call.method), `${routeTs} 가 ${call.method} export 안 함`).toBe(true);
    });
  }
});
