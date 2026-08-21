// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TAB_PROJECT_STORAGE_KEY,
  resolveEffectiveOrgId,
  resolveEffectiveProjectId,
  installProjectHeaderInterceptor,
  setEffectiveProjectId,
  setEffectiveOrgId,
} from './project-context-client';

describe('resolveEffectiveProjectId (hydrated 게이팅 — SSR/첫 CSR 렌더 divergence 방지, 2026-07-11 라이브 재현)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('prefers a valid urlProjectId regardless of hydrated state', () => {
    const accessible = new Set(['p1']);
    expect(resolveEffectiveProjectId('p1', 'server-id', accessible, false)).toBe('p1');
    expect(resolveEffectiveProjectId('p1', 'server-id', accessible, true)).toBe('p1');
  });

  it('ignores sessionStorage when hydrated=false, even if a valid stored value exists (SSR-consistent first render)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, false)).toBe('server-id');
  });

  it('uses sessionStorage once hydrated=true (backstop restored after the settle tick)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true)).toBe('stored-id');
  });

  it('defaults hydrated to true when the 4th arg is omitted (backward compatible call sites)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible)).toBe('stored-id');
  });

  it('falls back to serverProjectId when neither URL nor an accessible stored value exists', () => {
    const accessible = new Set(['server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true)).toBe('server-id');
  });

  // story #2490 — fire #2486 재현(PO 퍼펫티어, 2026-08-06)에서 발견: serverProjectId(=me.
  // project_id, 쿠키/JWT 유래)만 accessibleIds 체크가 빠져있어, stale해 비멤버 프로젝트를
  // 가리켜도 무검증 채택됐다. 다른 멤버 프로젝트로 조용히 점프하지 않고 undefined(미선택)로
  // 떨어뜨린다 — 호출부 대부분이 이미 `!projectId` 가드로 graceful 폴백을 갖고 있다.
  it('양성대조 — serverProjectId가 비멤버 프로젝트를 가리키면 undefined로 떨어진다(다른 프로젝트로 조용히 점프하지 않는다)', () => {
    const accessible = new Set(['some-other-member-project']);
    expect(resolveEffectiveProjectId(null, 'non-member-project', accessible, true)).toBeUndefined();
  });

  it('sessionStorage에 남은 비멤버 stale 값도 undefined로 떨어진다(자기강화 루프의 시작점 차단)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'non-member-project');
    const accessible = new Set(['some-other-member-project']);
    expect(resolveEffectiveProjectId(null, 'non-member-project', accessible, true)).toBeUndefined();
  });

  it('rejects an inaccessible stored value even when hydrated', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'not-a-member-project');
    const accessible = new Set(['server-id']);
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true)).toBe('server-id');
  });
});

describe('resolveEffectiveProjectId — pathProjectId 최우선 (story #2093, 직접 URL 진입 시 top-bar 칩이 계정 상태의 다른 프로젝트를 그리던 회귀)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('직접 URL 진입(?p= 없음) — pathProjectId가 계정 상태(serverProjectId)보다 우선한다', () => {
    const accessible = new Set(['server-id']); // 계정 멤버십엔 path-project가 없을 수 있다(cross-org)
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, true, 'path-id')).toBe('path-id');
  });

  it('pathProjectId는 accessibleIds 체크를 받지 않는다(proxy.ts가 이미 서버측에서 resolve로 검증한 값)', () => {
    const accessible = new Set(['server-id']); // path-id가 이 집합에 없어도(cross-org) 채택돼야 한다
    expect(resolveEffectiveProjectId(null, 'server-id', accessible, false, 'path-id')).toBe('path-id');
  });

  it('pathProjectId가 ?p=/sessionStorage보다도 우선한다(경로가 유일한 정본)', () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'stored-id');
    const accessible = new Set(['stored-id', 'url-id', 'path-id']);
    expect(resolveEffectiveProjectId('url-id', 'server-id', accessible, true, 'path-id')).toBe('path-id');
  });

  it('pathProjectId가 없는(flat 라우트) 경우엔 기존 ?p= 우선순위 체인이 그대로 동작한다', () => {
    const accessible = new Set(['url-id', 'server-id']);
    expect(resolveEffectiveProjectId('url-id', 'server-id', accessible, true, undefined)).toBe('url-id');
  });
});

// story #2497 — fire #2486 근본원인(라이브 실증): 인터셉터가 X-Project-Id만 보내고 X-Org-Id는
// 안 보내, 멀티-org 유저의 stale JWT org가 backend get_verified_org_id의 org_id 스코프로
// 새 has_project_access가 엉뚱한 org로 검증돼 정당한 프로젝트도 403 났다. 이 describe는
// «하나만 실으면 RED»가 되는 회귀가드다 — window.fetch를 한 번만 패치(모듈 싱글턴)하고
// 매 테스트는 ref 값만 바꿔 검증한다.
describe('installProjectHeaderInterceptor — X-Project-Id 옆에 X-Org-Id가 항상 함께 실린다 (story #2497)', () => {
  const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));

  beforeAll(() => {
    window.fetch = baseFetch as unknown as typeof window.fetch;
    installProjectHeaderInterceptor();
  });

  beforeEach(() => {
    baseFetch.mockClear();
    setEffectiveProjectId(undefined);
    setEffectiveOrgId(undefined);
  });

  it('핵심 회귀가드 — X-Project-Id와 X-Org-Id를 함께 주입한다', async () => {
    setEffectiveProjectId('proj-1');
    setEffectiveOrgId('org-1');
    await window.fetch('/api/projects');

    expect(baseFetch).toHaveBeenCalledTimes(1);
    const [, init] = baseFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('X-Project-Id')).toBe('proj-1');
    expect(headers.get('X-Org-Id')).toBe('org-1');
  });

  it('effective org가 아직 없으면(초기 렌더 등) X-Org-Id 없이 X-Project-Id만 실린다(회귀 없음)', async () => {
    setEffectiveProjectId('proj-1');
    await window.fetch('/api/projects');

    const [, init] = baseFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('X-Project-Id')).toBe('proj-1');
    expect(headers.has('X-Org-Id')).toBe(false);
  });

  it('요청이 이미 X-Project-Id/X-Org-Id를 명시하면 인터셉터가 덮지 않는다(switcher cross-org 로드 회귀 없음)', async () => {
    setEffectiveProjectId('proj-1');
    setEffectiveOrgId('org-1');
    await window.fetch('/api/projects', { headers: { 'X-Project-Id': 'explicit-proj', 'X-Org-Id': 'explicit-org' } });

    const [, init] = baseFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Project-Id')).toBe('explicit-proj');
    expect(headers.get('X-Org-Id')).toBe('explicit-org');
  });

  it('/api/switch-* 는 주입 대상에서 제외된다(회귀 없음)', async () => {
    setEffectiveProjectId('proj-1');
    setEffectiveOrgId('org-1');
    await window.fetch('/api/switch-project');

    const [, init] = baseFetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.headers).toBeUndefined();
  });
});

describe('resolveEffectiveOrgId (story #2873 — 0-프로젝트 org 전환 후 침묵 오배달 재발방지)', () => {
  it('pathOrgId(경로 resolve 결과)가 있으면 최우선 — jwtOrgId/orgId 무관', () => {
    expect(resolveEffectiveOrgId('path-org', 'jwt-org', 'chain-org')).toBe('path-org');
    expect(resolveEffectiveOrgId('path-org', undefined, 'chain-org')).toBe('path-org');
  });

  it('flat 라우트(pathOrgId 없음) — jwtOrgId가 project-chain 파생값(orgId)보다 우선한다', () => {
    // 라이브 재현 그대로: 0-프로젝트 org로 전환하면 switch-org가 새 JWT의 org_id 클레임은
    // 정확히 새 org로 갱신하지만(jwtOrgId), CURRENT_PROJECT_COOKIE엔 앵커할 project가 없어
    // project-chain 파생값(orgId)은 여전히 전환 前 org를 가리킨다 — jwtOrgId를 써야 새 org로
    // 실제 반영된다(전에는 orgId를 써서 여기서 전환 前 org가 나와 조용히 오배달됐다).
    expect(resolveEffectiveOrgId(undefined, 'sk-leak-test-org', 'mungclab-org')).toBe('sk-leak-test-org');
  });

  it('flat 라우트에서 jwtOrgId가 없으면(Firebase 세션 등) orgId(project-chain)로 폴백한다', () => {
    expect(resolveEffectiveOrgId(undefined, undefined, 'chain-org')).toBe('chain-org');
  });

  it('전부 없으면 undefined', () => {
    expect(resolveEffectiveOrgId(undefined, undefined, undefined)).toBeUndefined();
  });
});
