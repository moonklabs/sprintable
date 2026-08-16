import { describe, expect, it } from 'vitest';
import { AlertCircle } from 'lucide-react';
import { findBrokenNavEntries, fsRouteChecker, type RouteChecker } from './verify-nav-config-routes';
import { NAV_GROUPS } from '../src/lib/nav-config';

describe('verify-nav-config-routes — story #2681 AC3', () => {
  it('실 NAV_GROUPS 전 항목이 실 라우트와 정합한다(회귀 0)', () => {
    expect(findBrokenNavEntries(NAV_GROUPS, fsRouteChecker)).toEqual([]);
  });

  // AC3 「RED 실증」 — 진짜 파일시스템을 건드리지 않고(fsRouteChecker를 가짜 checker로
  // 교체) 죽은 링크·미등재 목적지를 이 가드가 정확히 잡아내는지 확인한다.
  it('죽은 static 링크를 정확히 잡아낸다(RED 실증)', () => {
    const fakeGroups = [
      { id: 'g1', labelKey: 'x', items: [{ id: 'dead', labelKey: 'x', icon: AlertCircle, kind: 'static' as const, path: '/no/such/route' }] },
    ];
    const alwaysMissing: RouteChecker = { staticExists: () => false, resourceExists: () => false };
    expect(findBrokenNavEntries(fakeGroups, alwaysMissing)).toEqual([
      { groupId: 'g1', itemId: 'dead', kind: 'static', path: '/no/such/route' },
    ]);
  });

  it('미등재 resource 목적지를 정확히 잡아낸다(RED 실증)', () => {
    const fakeGroups = [
      { id: 'g1', items: [{ id: 'ghost', labelKey: 'x', icon: AlertCircle, kind: 'resource' as const, path: 'no_such_resource' }] },
    ];
    const alwaysMissing: RouteChecker = { staticExists: () => false, resourceExists: () => false };
    expect(findBrokenNavEntries(fakeGroups, alwaysMissing)).toEqual([
      { groupId: 'g1', itemId: 'ghost', kind: 'resource', path: 'no_such_resource' },
    ]);
  });

  it('전부 정합하면 빈 배열을 낸다(양성대조)', () => {
    const fakeGroups = [
      { id: 'g1', items: [{ id: 'ok', labelKey: 'x', icon: AlertCircle, kind: 'static' as const, path: '/anything' }] },
    ];
    const alwaysPresent: RouteChecker = { staticExists: () => true, resourceExists: () => true };
    expect(findBrokenNavEntries(fakeGroups, alwaysPresent)).toEqual([]);
  });

  it('fsRouteChecker.staticExists — 존재하는 (authenticated) 라우트는 true', () => {
    expect(fsRouteChecker.staticExists('/organization/members')).toBe(true);
  });

  it('fsRouteChecker.staticExists — 존재하지 않는 경로는 false', () => {
    expect(fsRouteChecker.staticExists('/no/such/page/at/all')).toBe(false);
  });

  it('fsRouteChecker.resourceExists — [ws]/[proj] 하위 실제 리소스는 true', () => {
    expect(fsRouteChecker.resourceExists('flow')).toBe(true);
  });

  it('fsRouteChecker.resourceExists — 없는 리소스명은 false', () => {
    expect(fsRouteChecker.resourceExists('no_such_resource_xyz')).toBe(false);
  });
});
