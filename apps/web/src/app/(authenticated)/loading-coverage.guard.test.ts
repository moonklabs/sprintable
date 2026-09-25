/**
 * story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — 탭 · 메뉴 목적지 loading.tsx 전수 가드.
 *
 * 왜: loading.tsx가 없는 목적지는 누른 뒤 서버 응답(RSC 450~670ms)을 다 받을 때까지 화면이 안 바뀐다(«전체» · «일감» 탭→주소 536~1000ms ·
 * 있는 «결재» · «대화»는 44~193ms). 목적지는 nav-config(NAV_GROUPS · LEGACY_NAV_ITEMS)와 탭 기본 목적지에서 **읽어** 모은다 — 새 메뉴를 붙이면
 * 자동으로 이 가드 대상이다.
 *
 * 함께 막는 것(반대 방향 위험): 서버 redirect()를 부르는 page.tsx가 loading.tsx 스트리밍 경계 **아래**에 들면 React 오류 310이 난다
 * (story #3915 근본원인). 그래서 «경계가 있어야 한다»와 «redirect 페이지는 경계 밖이어야 한다»를 같이 단언한다 — organization/ 전체에 한 파일로
 * 경계를 두면 organization/connectors(redirect)가 걸려 RED.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_NAV_ITEMS, NAV_GROUPS } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';

const AUTH_ROOT = join(__dirname);

/** nav 서술자 → (authenticated) 아래 앱 디렉토리. (authenticated) 밖(예: v3 /today)이면 null. */
function appDirOf(item: { kind: string; path: string }): string | null {
  if (item.kind === 'resource') return join(AUTH_ROOT, '[ws]', '[proj]', item.path.split('?')[0]!);
  const path = item.path.split('?')[0]!.replace(/^\//, '');
  const dir = join(AUTH_ROOT, ...path.split('/'));
  return existsSync(dir) ? dir : null;
}

/** 이 디렉토리부터 (authenticated)까지 거슬러 올라가며 처음 만나는 loading.tsx(없으면 null). */
function coveringLoading(dir: string): string | null {
  for (let d = dir; d.startsWith(AUTH_ROOT); d = dirname(d)) {
    const f = join(d, 'loading.tsx');
    if (existsSync(f)) return f;
    if (d === AUTH_ROOT) break;
  }
  return null;
}

function allPages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) allPages(full, out);
    else if (name === 'page.tsx') out.push(full);
  }
  return out;
}

describe('story #4274 — 탭 · 메뉴 목적지 loading.tsx 전수', () => {
  const dest = resolveNavV3Destinations(DEFAULT_NAV_V3_FLAGS);
  const tabItems = [dest.work, dest.approvals, dest.chats, dest.more];
  const menuItems = [...NAV_GROUPS.flatMap((g) => g.items), ...LEGACY_NAV_ITEMS];
  const destinations = [...tabItems, ...menuItems]
    .map((item) => ({ path: item.path, dir: appDirOf(item) }))
    .filter((d): d is { path: string; dir: string } => d.dir !== null);

  it('목적지를 실제로 모았다(빈 목록 = 거짓 PASS 방지)', () => {
    expect(destinations.length).toBeGreaterThanOrEqual(15);
  });

  it('⭐모든 목적지에 page.tsx와 그것을 덮는 loading.tsx가 있다', () => {
    const missing = destinations
      .filter((d) => !existsSync(join(d.dir, 'page.tsx')) || coveringLoading(d.dir) === null)
      .map((d) => `${d.path} (${relative(AUTH_ROOT, d.dir)})`);
    expect(missing, `loading.tsx가 없는 목적지: ${missing.join(', ')}`).toEqual([]);
  });

  it('⭐서버 redirect()를 부르는 page.tsx는 어떤 loading.tsx 경계 아래에도 없다(React 오류 310 · story #3915)', () => {
    const offenders = allPages(AUTH_ROOT)
      .filter((p) => {
        const src = readFileSync(p, 'utf8');
        return !/^['"]use client['"]/m.test(src) && /\b(redirect|permanentRedirect)\(/.test(src);
      })
      .filter((p) => coveringLoading(dirname(p)) !== null)
      .map((p) => `${relative(AUTH_ROOT, p)} ← ${relative(AUTH_ROOT, coveringLoading(dirname(p))!)}`);
    expect(offenders, `redirect 페이지가 스트리밍 경계 아래: ${offenders.join(', ')}`).toEqual([]);
  });
});
