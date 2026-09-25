/**
 * story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — 탭 · 메뉴 목적지 loading.tsx 전수 가드.
 *
 * 왜: loading.tsx가 없는 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지 화면이 안 바뀐다(«전체» · «일감» 탭→주소 536~1000ms ·
 * 있는 «결재» · «대화»는 44~193ms).
 *
 * 목적지: nav-config(`resolveNavGroups` · `resolveChatCenterItem` · `LEGACY_NAV_ITEMS`)와 탭 목적지(`resolveNavV3Destinations`)를 **v3 플래그
 * 전부 OFF · 전부 ON 두 판에서** 읽어 모은다(플래그를 켜면 «오늘» /today · «대화» /chat · «연결·규칙» /connect-rules · «일감» work-list로 바뀐다).
 * 모은 목록은 판마다 **따로** EXPECTED_OFF · EXPECTED_ON과 정확히 대조한다 — 늘거나 빠지거나 OFF/ON이 뒤바뀌면 RED(총량 하한 · 합집합 대조는
 * 하나 빠져도 · 방향이 바뀌어도 초록이었다 · 까디르 검수 P2).
 *
 * 단언:
 * 1. 모든 목적지 경로가 app/ 아래 실제 page.tsx로 풀린다(라우트 그룹 `(…)` 통과) — 못 풀리면 RED(조용히 버리지 않는다).
 * 2. 그 page.tsx를 덮는 loading.tsx가 있고, 그 loading은 화면 읽기 프로그램에 상태를 알린다 — loading 파일 자체나 그것이 import한
 *    `@/components/…` 스켈레톤 소스에 `role="status"` · `aria-busy="true"` · `sr-only` 라벨 셋 다(이름이 아니라 실제 소스를 본다).
 * 3. 일감 프레임 여섯 경로(WorkspaceFrameTabs의 탭)는 **자기** loading.tsx가 탭 줄을 품는다(`<WorkspaceFrameLoading active="그 탭">`) —
 *    부모 `[ws]/[proj]/loading.tsx`(일반 스켈레톤)가 덮으면 형제 탭 이동 때 탭 줄이 사라졌다 돌아온다(유나 스트리밍 대조: 보드 → 목록 ~290ms).
 * 4. 스켈레톤이 도착 페이지와 같은 폭 · 여백(유나 판정) — 목적지 전수를 EXPECTED_CONTAINERS(컨테이너 + 그 선언 파일) · NO_CONTAINER(이유)
 *    두 표로 덮고(합 = 목적지 · 겹침 0), 표의 컨테이너가 선언 파일에 그대로 있는지 + 그 목적지를 덮는 loading(조상 loader 포함)에 같은
 *    배치 토큰(mx-auto · w-full · max-w · p-* · lg:w/p-*)이 다 있는지 본다.
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

/** 한 판(플래그 조합 하나)의 탭 + 메뉴 목적지. 키 = `resource:조각` 또는 정적 경로(쿼리 제외). */
function collectDestinationsFor(flags: NavV3Flags): Map<string, Dest> {
  const out = new Map<string, Dest>();
  {
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

/** 두 판(OFF · ON) 합집합 — loading · 상태 알림 · 컨테이너 단언은 어느 판이든 목적지가 되는 곳 전부에 건다. */
function collectDestinations(): Map<string, Dest> {
  return new Map([...collectDestinationsFor(DEFAULT_NAV_V3_FLAGS), ...collectDestinationsFor(ALL_ON)]);
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

/** loading 파일 자체 또는 그것이 import한 `@/components/…` 파일 중 하나가 «불러오는 중»을 제대로 알리는지 — 같은 소스에 `role="status"` ·
 * `aria-busy="true"` · 화면 읽기 프로그램용 라벨(`sr-only`) 셋 다(까디르 검수 P3 · role만 보면 라벨 없는 상태도 통과했다). */
function announcesStatus(loadingFile: string): boolean {
  const hasStatus = (f: string) => {
    const src = codeOnly(readFileSync(f, 'utf8'));
    return /\srole="status"/.test(src) && /\saria-busy="true"/.test(src) && /className="[^"]*\bsr-only\b/.test(src);
  };
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

// 판마다 따로 대조한다(까디르 검수 P2 — 합집합 하나로 대조하면 OFF/ON이 뒤바뀌어도 통과했다). 늘거나 빠지면 여기 고치고 loading.tsx를 같이 확인.
const EXPECTED_OFF = [
  '/activity', '/chats', '/content', '/content/channel-posts', '/inbox', '/more', '/org-briefing',
  '/organization/channels', '/organization/content-rules', '/organization/events', '/organization/generation-connectors',
  '/organization/insights-board', '/organization/members', '/organization/roles', '/organization/trust', '/organization/workforce',
  '/settings', 'resource:artifacts', 'resource:docs', 'resource:flow', 'resource:goals', 'resource:loops', 'resource:storage',
].sort();
const EXPECTED_ON = [
  '/activity', '/chat', '/connect-rules', '/content', '/content/channel-posts', '/inbox', '/more',
  '/organization/channels', '/organization/content-rules', '/organization/events', '/organization/generation-connectors',
  '/organization/insights-board', '/organization/members', '/organization/roles', '/organization/trust', '/organization/workforce',
  '/settings', '/today', 'resource:artifacts', 'resource:docs', 'resource:goals', 'resource:loops', 'resource:storage', 'resource:work-list',
].sort();

// 목적지 전수의 «페이지 컨테이너» 표(유나 «스켈레톤 = 페이지 컨테이너» · 까디르 검수 P2 — 첫 className만 · 조상 loader 건너뜀 · 하한 8 대신 목록 대조).
// source = 그 컨테이너 className이 실제로 선언된 파일(app/ 기준 상대 · `../`는 src/). 표에 없는 목적지는 NO_CONTAINER에 이유와 함께.
const EXPECTED_CONTAINERS: Record<string, { source: string; container: string }> = {
  '/organization/members': { source: '(authenticated)/organization/members/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-3 p-6' },
  '/organization/roles': { source: '(authenticated)/organization/roles/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-3 p-6' },
  '/organization/trust': { source: '(authenticated)/organization/trust/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-3 p-6' },
  '/organization/events': { source: '(authenticated)/organization/events/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-6 p-6' },
  '/organization/channels': { source: '(authenticated)/organization/channels/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-6 p-6' },
  '/organization/content-rules': { source: '(authenticated)/organization/content-rules/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-6 p-6' },
  '/organization/generation-connectors': { source: '(authenticated)/organization/generation-connectors/page.tsx', container: 'mx-auto w-full max-w-3xl space-y-6 p-6' },
  '/organization/insights-board': { source: '(authenticated)/organization/insights-board/page.tsx', container: 'mx-auto w-full max-w-6xl space-y-6 p-6' },
  '/content': { source: '(authenticated)/content/page.tsx', container: 'mx-auto w-full max-w-5xl space-y-6 p-6' },
  '/content/channel-posts': { source: '(authenticated)/content/channel-posts/page.tsx', container: 'mx-auto w-full max-w-5xl space-y-6 p-6' },
  '/settings': { source: '(authenticated)/settings/page.tsx', container: 'w-full max-w-3xl mx-auto p-6' },
  '/org-briefing': { source: '../components/org-briefing/org-briefing-shell.tsx', container: 'mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6' },
  '/more': { source: '(authenticated)/more/page.tsx', container: 'flex flex-col p-4' },
  '/today': { source: '../components/today-v3/today-v3-screen.tsx', container: 'min-h-0 w-full shrink-0 overflow-auto border-r border-border p-5 lg:w-[392px]' },
  '/connect-rules': { source: '../components/connect-rules-v3/connect-rules-v3-screen.tsx', container: 'mx-auto max-w-[720px] space-y-8' },
  '/chat': { source: '../components/chat-v3/chat-v3-screen.tsx', container: 'flex flex-1 flex-col gap-3 p-5' },
};
// 폭 · 여백 컨테이너가 없는(전폭 · 자체 레이아웃) 목적지 — 기본 PageSkeleton(`space-y-6 p-6`) 또는 전용 스켈레톤.
const NO_CONTAINER: Record<string, string> = {
  '/activity': '활동 로그 뷰가 전폭 목록(컨테이너 없음)',
  '/chats': '대화 목록 전폭 · 전용 스켈레톤(chats/loading.tsx)',
  '/inbox': '결재함 전폭 목록',
  '/organization/workforce': '에이전트 화면 전폭',
  'resource:artifacts': '산출물 갤러리 전폭',
  'resource:docs': '문서 트리 · 편집기 전폭',
  'resource:flow': '일감 프레임 — 탭 줄 품은 WorkspaceFrameLoading(별 단언)',
  'resource:work-list': '일감 프레임 — 탭 줄 품은 WorkspaceFrameLoading(별 단언)',
  'resource:goals': '목표 전용 스켈레톤(EpicsSkeleton)',
  'resource:loops': '실행 목록 전폭',
  'resource:storage': '스토리지 2단(폰 1단) 전폭',
};

describe('story #4274 — 탭 · 메뉴 목적지 loading.tsx 전수(v3 플래그 OFF · ON)', () => {
  const destinations = collectDestinations();

  it('⭐목적지 목록이 판마다 정확히 같다 — 플래그 OFF · ON을 따로(뒤바뀌거나 늘거나 빠지면 RED)', () => {
    expect([...collectDestinationsFor(DEFAULT_NAV_V3_FLAGS).keys()].sort()).toEqual(EXPECTED_OFF);
    expect([...collectDestinationsFor(ALL_ON).keys()].sort()).toEqual(EXPECTED_ON);
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

  it('⭐컨테이너 표가 목적지 전수를 덮는다(표 ∪ 없음 목록 = 목적지 · 겹침 0)', () => {
    const covered = [...Object.keys(EXPECTED_CONTAINERS), ...Object.keys(NO_CONTAINER)].sort();
    expect(covered).toEqual([...destinations.keys()].sort());
    expect(Object.keys(EXPECTED_CONTAINERS).filter((k) => k in NO_CONTAINER)).toEqual([]);
  });

  it('⭐표의 컨테이너가 실제 소스에 있고, 그 목적지를 덮는 loading이 같은 폭 · 여백 토큰을 쓴다', () => {
    const LAYOUT_TOKEN = /^(mx-auto|w-full|max-w-\S+|p-\S+|px-\S+|py-\S+|(sm|md|lg):(p|w|max-w)-\S+)$/;
    const problems: string[] = [];
    for (const [k, { source, container }] of Object.entries(EXPECTED_CONTAINERS)) {
      const src = codeOnly(readFileSync(join(APP_ROOT, source), 'utf8'));
      if (!src.includes(`className="${container}"`)) { problems.push(`${k}: ${source}에 컨테이너 "${container}" 없음(화면이 바뀌면 표 갱신)`); continue; }
      const dir = routeDirOf(destinations.get(k)!);
      const loading = dir ? coveringLoading(dir) : null;
      if (!loading) { problems.push(`${k}: loading 없음`); continue; }
      const have = new Set((codeOnly(readFileSync(loading, 'utf8')).match(/className="([^"]*)"/g) ?? []).flatMap((m) => m.slice(11, -1).split(/\s+/)));
      const missing = container.split(/\s+/).filter((t) => LAYOUT_TOKEN.test(t) && !have.has(t));
      if (missing.length) problems.push(`${k}: ${relative(APP_ROOT, loading)}에 없는 배치 토큰 ${missing.join(' ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('⭐v3 목적지(/today · /chat · /connect-rules) loading은 v3 셸 뼈대(V3ShellLoading · v3-shell-root) 안에 그린다', () => {
    // 까디르 델타 — 표의 컨테이너 토큰만 보면 셸 감싸개(V3ShellLoading)를 빼도 초록이었다. 감싸개 사용 + 그 감싸개가 v3 셸 뿌리 클래스를 쓰는지.
    const shell = codeOnly(readFileSync(join(APP_ROOT, '../components/nav/v3-shell-loading.tsx'), 'utf8'));
    expect(shell).toMatch(/className="v3-shell-root\b/);
    // 유나 판정(4643) — v3 화면은 하단 탭바를 스스로 그린다 → 셸 loading에도(없으면 390에서 탭바가 사라졌다 돌아온다).
    expect(shell).toMatch(/<MobileTabBar\b/);
    const problems: string[] = [];
    for (const k of ['/today', '/chat', '/connect-rules']) {
      const dir = routeDirOf(destinations.get(k)!);
      const own = dir ? join(dir, 'loading.tsx') : null;
      if (!own || !existsSync(own)) { problems.push(`${k}: 자기 loading.tsx 없음`); continue; }
      if (!/<V3ShellLoading\b/.test(codeOnly(readFileSync(own, 'utf8')))) problems.push(`${k}: V3ShellLoading 감싸개 없음`);
    }
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
