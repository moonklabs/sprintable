/**
 * story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — 탭 · 메뉴 목적지 loading.tsx 전수 가드.
 *
 * 왜: loading.tsx가 없는 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지 화면이 안 바뀐다(«전체» · «일감» 탭→주소 536~1000ms ·
 * 있는 «결재» · «대화»는 44~193ms).
 *
 * 목적지: nav-config(`resolveNavGroups` · `resolveChatCenterItem` · `LEGACY_NAV_ITEMS`)와 탭 목적지(`resolveNavV3Destinations`)를 **v3 플래그
 * 전부 OFF · 전부 ON 두 판에서** 읽어 모은다(플래그를 켜면 «오늘» /today · «대화» /chat · «연결·규칙» /connect-rules · «일감» work-list로 바뀐다).
 * 모은 목록은 아래 EXPECTED와 **정확히 대조**한다 — 목적지가 늘거나 빠지면 RED(총량 하한만 보면 하나 빠져도 초록이었다 · 까디르 검수 P2).
 *
 * 단언:
 * 1. 모든 목적지 경로가 app/ 아래 실제 page.tsx로 풀린다(라우트 그룹 `(…)` 통과) — 못 풀리면 RED(조용히 버리지 않는다).
 * 2. 그 page.tsx를 덮는 loading.tsx가 있고, 그 loading은 화면 읽기 프로그램에 상태를 알린다 — loading 파일 자체나 그것이 import한
 *    `@/components/…` 스켈레톤 소스에 role="status"가 있다(이름이 아니라 실제 소스를 본다).
 * 3. 일감 프레임 여섯 경로(WorkspaceFrameTabs의 탭)는 **자기** loading.tsx가 탭 줄을 품는다(`<WorkspaceFrameLoading active="그 탭">`) —
 *    부모 `[ws]/[proj]/loading.tsx`(일반 스켈레톤)가 덮으면 형제 탭 이동 때 탭 줄이 사라졌다 돌아온다(유나 스트리밍 대조: 보드 → 목록 ~290ms).
 * 4. 스켈레톤이 도착 페이지와 같은 폭 · 여백(유나 판정) — page.tsx가 `mx-auto … max-w-*` 컨테이너를 직접 선언하면 그 목적지의 **자기**
 *    loading.tsx className에 같은 배치 토큰(mx-auto · w-full · max-w-* · p-* · lg:p-*)이 다 있다. 컨테이너를 클라이언트 컴포넌트에 넘기는
 *    페이지는 page.tsx에서 폭을 읽을 수 없어 이 단언의 대상이 아니다(못 잡는 것).
 * 5. 반대 방향 위험 — `next/navigation`의 redirect/permanentRedirect를 **import해서 부르는**(별칭 · 네임스페이스 import 포함) page.tsx ·
 *    layout.tsx는 어떤 loading.tsx 경계 아래에도 없다(스트리밍 경계 아래 redirect = React 오류 310 · story #3915). layout은 같은 폴더의
 *    loading.tsx보다 바깥이라 부모 폴더부터 본다.
 *
 * 못 잡는 것(선언): redirect를 다른 모듈에서 다시 내보내 부르는 경우(재수출 체인)는 못 본다 — 지금 app/ 안 0건.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_NAV_ITEMS, resolveChatCenterItem, resolveNavGroups } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { WORKSPACE_FRAME_TABS } from '@/components/workspace/workspace-frame-tabs';

const APP_ROOT = __dirname;
const ALL_ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

type Dest = { kind: string; path: string };

/** 두 판(플래그 OFF · ON)의 탭 + 메뉴 목적지. 키 = `resource:조각` 또는 정적 경로(쿼리 제외). */
function collectDestinations(): Map<string, Dest> {
  const out = new Map<string, Dest>();
  for (const flags of [DEFAULT_NAV_V3_FLAGS, ALL_ON]) {
    const dest = resolveNavV3Destinations(flags);
    const items: Dest[] = [
      dest.work, dest.approvals, dest.chats, dest.more,
      ...resolveNavGroups(flags).flatMap((g) => g.items),
      resolveChatCenterItem(flags),
      ...LEGACY_NAV_ITEMS,
    ];
    for (const item of items) {
      const path = item.path.split('?')[0]!;
      out.set(item.kind === 'resource' ? `resource:${path}` : path, { kind: item.kind, path });
    }
  }
  return out;
}

/** 폴더 안에서 URL 조각들을 따라 page.tsx가 있는 폴더를 찾는다. 라우트 그룹 `(…)`은 URL에 안 나타나 그대로 통과. */
function findRouteDir(base: string, segs: string[]): string | null {
  if (segs.length === 0) return existsSync(join(base, 'page.tsx')) ? base : null;
  for (const name of readdirSync(base)) {
    const full = join(base, name);
    if (!statSync(full).isDirectory()) continue;
    if (name === segs[0]) {
      const hit = findRouteDir(full, segs.slice(1));
      if (hit) return hit;
    } else if (/^\(.+\)$/.test(name)) {
      const hit = findRouteDir(full, segs);
      if (hit) return hit;
    }
  }
  return null;
}

function routeDirOf(d: Dest): string | null {
  if (d.kind === 'resource') {
    const dir = join(APP_ROOT, '(authenticated)', '[ws]', '[proj]', ...d.path.split('/'));
    return existsSync(join(dir, 'page.tsx')) ? dir : null;
  }
  return findRouteDir(APP_ROOT, d.path.replace(/^\//, '').split('/').filter(Boolean));
}

/** 이 폴더부터 app/까지 거슬러 올라가며 처음 만나는 loading.tsx. */
function coveringLoading(dir: string): string | null {
  for (let d = dir; d.startsWith(APP_ROOT); d = dirname(d)) {
    const f = join(d, 'loading.tsx');
    if (existsSync(f)) return f;
    if (d === APP_ROOT) break;
  }
  return null;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === 'page.tsx' || name === 'layout.tsx') out.push(full);
  }
  return out;
}

/** `next/navigation`에서 import한 redirect/permanentRedirect를 부르는지 — 별칭(`redirect as go`) · 네임스페이스(`* as nav` → `nav.redirect(`) 포함. */
function callsNavigationRedirect(src: string): boolean {
  const locals: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]next\/navigation['"]/g)) {
    for (const spec of m[1]!.split(',')) {
      const [imported, local] = spec.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (imported === 'redirect' || imported === 'permanentRedirect') locals.push(local || imported);
    }
  }
  for (const m of src.matchAll(/import\s*\*\s*as\s+(\w+)\s+from\s*['"]next\/navigation['"]/g)) {
    locals.push(`${m[1]}.redirect`, `${m[1]}.permanentRedirect`);
  }
  const body = src.replace(/import[^;]*from\s*['"][^'"]+['"];?/g, '');
  return locals.some((name) => new RegExp(`(^|[^\\w.])${name.replace('.', '\\s*\\.\\s*')}\\s*\\(`).test(body));
}

/** 주석을 걷은 코드(주석 속 `role="status"` 설명 문구가 판정에 섞이지 않게). */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** loading 파일 자체 또는 그것이 import한 `@/components/…` 파일 중 하나의 JSX에 role="status"가 있는지. */
function announcesStatus(loadingFile: string): boolean {
  const hasStatus = (f: string) => /\srole="status"/.test(codeOnly(readFileSync(f, 'utf8')));
  if (hasStatus(loadingFile)) return true;
  const SRC_ROOT = join(APP_ROOT, '..');
  for (const m of readFileSync(loadingFile, 'utf8').matchAll(/from\s*['"]@\/(components\/[^'"]+)['"]/g)) {
    for (const ext of ['.tsx', '.ts']) {
      const f = join(SRC_ROOT, m[1]! + ext);
      if (existsSync(f) && hasStatus(f)) return true;
    }
  }
  return false;
}

// 두 판(OFF · ON)의 목적지 전수. 늘거나 빠지면 여기 고치고 loading.tsx를 같이 확인한다.
const EXPECTED = [
  '/activity', '/chat', '/chats', '/connect-rules', '/content', '/content/channel-posts', '/inbox', '/more',
  '/org-briefing', '/organization/channels', '/organization/content-rules', '/organization/events',
  '/organization/generation-connectors', '/organization/insights-board', '/organization/members', '/organization/roles',
  '/organization/trust', '/organization/workforce', '/settings', '/today',
  'resource:artifacts', 'resource:docs', 'resource:flow', 'resource:goals', 'resource:loops', 'resource:storage', 'resource:work-list',
].sort();

describe('story #4274 — 탭 · 메뉴 목적지 loading.tsx 전수(v3 플래그 OFF · ON)', () => {
  const destinations = collectDestinations();

  it('⭐목적지 목록이 EXPECTED와 정확히 같다(늘거나 빠지면 RED)', () => {
    expect([...destinations.keys()].sort()).toEqual(EXPECTED);
  });

  it('⭐모든 목적지가 app/ 아래 실제 page.tsx로 풀린다(못 풀리면 RED · 조용히 버리지 않는다)', () => {
    const unresolved = [...destinations].filter(([, d]) => routeDirOf(d) === null).map(([k]) => k);
    expect(unresolved, `page.tsx로 안 풀리는 목적지: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('⭐모든 목적지를 loading.tsx가 덮고, 그 loading은 상태를 알린다(자기 · import한 스켈레톤 소스에 role="status")', () => {
    const problems: string[] = [];
    for (const [k, d] of destinations) {
      const dir = routeDirOf(d);
      if (!dir) continue; // 위 단언이 잡는다
      const loading = coveringLoading(dir);
      if (!loading) { problems.push(`${k}: loading.tsx 없음`); continue; }
      if (!announcesStatus(loading)) problems.push(`${k}: ${relative(APP_ROOT, loading)} 상태 알림 없음`);
    }
    expect(problems).toEqual([]);
  });

  it('⭐일감 프레임 여섯 경로는 자기 loading.tsx가 탭 줄을 품는다(해당 탭 켜짐)', () => {
    expect(WORKSPACE_FRAME_TABS.length).toBeGreaterThanOrEqual(6);
    const problems: string[] = [];
    for (const tab of WORKSPACE_FRAME_TABS) {
      const own = join(APP_ROOT, '(authenticated)', '[ws]', '[proj]', tab.path, 'loading.tsx');
      if (!existsSync(own)) { problems.push(`${tab.path}: 자기 loading.tsx 없음(부모 일반 스켈레톤이 탭 줄을 지운다)`); continue; }
      if (!new RegExp(`<WorkspaceFrameLoading\\b[^>]*\\bactive="${tab.key}"`).test(codeOnly(readFileSync(own, 'utf8')))) {
        problems.push(`${tab.path}: WorkspaceFrameLoading active="${tab.key}" 아님`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('⭐page.tsx가 폭 컨테이너를 선언한 목적지는 loading이 같은 폭 · 여백 안에 스켈레톤을 그린다', () => {
    const LAYOUT_TOKEN = /^(mx-auto|w-full|max-w-\S+|p-\S+|px-\S+|py-\S+|(sm|md|lg):p-\S+)$/;
    const problems: string[] = [];
    let checked = 0;
    for (const [k, d] of destinations) {
      const dir = routeDirOf(d);
      if (!dir || !existsSync(join(dir, 'loading.tsx'))) continue;
      const container = codeOnly(readFileSync(join(dir, 'page.tsx'), 'utf8')).match(/className="([^"]*\bmx-auto\b[^"]*\bmax-w-[^"]*|[^"]*\bmax-w-[^"]*\bmx-auto\b[^"]*)"/);
      if (!container) continue;
      checked++;
      const want = container[1]!.split(/\s+/).filter((t) => LAYOUT_TOKEN.test(t));
      const loading = codeOnly(readFileSync(join(dir, 'loading.tsx'), 'utf8'));
      const have = new Set((loading.match(/className="([^"]*)"/g) ?? []).flatMap((m) => m.slice(11, -1).split(/\s+/)));
      const missing = want.filter((t) => !have.has(t));
      if (missing.length) problems.push(`${k}: loading에 없는 배치 토큰 ${missing.join(' ')}`);
    }
    expect(checked, '폭 컨테이너를 선언한 목적지를 실제로 쟀다').toBeGreaterThanOrEqual(8);
    expect(problems).toEqual([]);
  });

  it('⭐redirect를 import해 부르는 page · layout은 어떤 loading.tsx 경계 아래에도 없다(React 오류 310 · story #3915)', () => {
    const offenders = routeFiles(APP_ROOT)
      .filter((f) => callsNavigationRedirect(readFileSync(f, 'utf8')))
      .map((f) => ({ f, loading: coveringLoading(f.endsWith('layout.tsx') ? dirname(dirname(f)) : dirname(f)) }))
      .filter((x) => x.loading !== null)
      .map((x) => `${relative(APP_ROOT, x.f)} ← ${relative(APP_ROOT, x.loading!)}`);
    expect(offenders, `redirect가 스트리밍 경계 아래: ${offenders.join(', ')}`).toEqual([]);
  });

  it('redirect 검출기 — 별칭 · 네임스페이스 · 공백 변형을 잡고, import만 하고 안 부르면 안 잡는다', () => {
    expect(callsNavigationRedirect(`import { redirect } from 'next/navigation';\nexport default function P() { redirect('/x'); }`)).toBe(true);
    expect(callsNavigationRedirect(`import { notFound, redirect as go } from "next/navigation";\nexport default function P() { go ('/x'); }`)).toBe(true);
    expect(callsNavigationRedirect(`import * as nav from 'next/navigation';\nexport default function P() { nav . permanentRedirect('/x'); }`)).toBe(true);
    expect(callsNavigationRedirect(`import { redirect } from 'next/navigation';\nexport default function P() { return null; }`)).toBe(false);
    expect(callsNavigationRedirect(`import { notFound } from 'next/navigation';\nfunction redirect() {}\nexport default function P() { notFound(); }`)).toBe(false);
  });
});
