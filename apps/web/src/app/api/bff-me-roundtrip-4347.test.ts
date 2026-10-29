/**
 * story #4347 — `/me` 전용 칸(id · project_name · scope)을 안 읽던 BFF 핸들러 75곳을 `getOrgProjectAuthContext`로 옮겼다(AC2).
 *
 * BE `GET /api/v2/me`의 project_id · org_id는 JWT claim(app_metadata) 그대로라, claim이 둘 다 있으면 light 경로가 같은 값을 `/me` 없이 낸다.
 * 핸들러마다 실제로 불러 확인한다(`/me` 호출은 인증 단계라 핸들러 뒤쪽 로직과 무관하게 셀 수 있다 — 뒤에서 목 때문에 실패해도 수는 같다):
 * - 사람 세션 + claim → `/me` 0
 * - claim 없음 → `/me` 1(fail-closed · 예전과 같은 인증)
 * - 세션 없음 → 401
 *
 * 옮기지 않은 1곳(`KEPT`): BE를 거치지 않고 스토리지에 직접 쓰는 핸들러 — claim이 있어도 `/me`(멤버 행 실조회)로 재인가한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fastapiCallMock, getServerSessionMock } = vi.hoisted(() => ({
  fastapiCallMock: vi.fn(),
  getServerSessionMock: vi.fn(),
}));

vi.mock('@sprintable/storage-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sprintable/storage-api')>()),
  fastapiCall: fastapiCallMock,
}));
vi.mock('@/lib/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/server')>()),
  getServerSession: getServerSessionMock,
}));
vi.mock('@/lib/fastapi-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/fastapi-proxy')>()),
  proxyToFastapi: vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
}));

/** 옮긴 핸들러(«파일 메서드») — 4346 톱니 가드의 옛 목록(75)에서 `KEPT`를 뺀 74곳. */
const MOVED: readonly string[] = [
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
  'visual-artifacts/route.ts GET',
  'visual-artifacts/route.ts POST',
];

/** 옮기지 않은 핸들러 — BE 재인가 없이 스토리지에 직접 쓴다(claim만 보면 접근 취소 뒤에도 JWT 만료 전까지 올리기가 된다). */
const KEPT: readonly string[] = ['visual-artifacts/import-image/route.ts POST'];

const meCalls = () => fastapiCallMock.mock.calls.filter(([, p]) => p === '/api/v2/me').length;
const PARAMS = { params: Promise.resolve(new Proxy({}, { get: () => '00000000-0000-4000-8000-000000000001' })) };

async function call(entry: string): Promise<Response | null> {
  const [file, method] = entry.split(' ');
  const mod = (await import(/* @vite-ignore */ `./${file.replace(/\.ts$/, '')}`)) as Record<string, (r: Request, c: unknown) => Promise<Response>>;
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (method !== 'GET' && method !== 'DELETE') init.body = '{}';
  try {
    return await mod[method](new Request('http://localhost/api/x?project_id=p1&org_id=org-1', init), PARAMS);
  } catch {
    return null;  // 인증 뒤의 목 부족으로 던져도 /me 수는 이미 셌다
  }
}

beforeEach(() => {
  fastapiCallMock.mockReset();
  fastapiCallMock.mockImplementation(async (_m: string, p: string) =>
    p === '/api/v2/me' ? { id: 'm1', org_id: 'org-1', project_id: 'proj-1', project_name: 'P' } : {},
  );
  getServerSessionMock.mockReset();
});

describe('story #4347 — 옮긴 BFF 핸들러 75곳의 /me 왕복', () => {
  // story #4450 — `tasks/route.ts POST` (one of the 74 moved) was later removed (no caller · always 422), so 73 remain.
  it('목록이 75곳이다(옛 톱니 가드 목록 = 옮긴 74 + 유지 1 · 그 뒤 #4450이 옮긴 하나를 지움 → 73)', () => {
    expect(MOVED.length).toBe(73);
    expect(MOVED.filter((e) => KEPT.includes(e))).toEqual([]);
    expect(MOVED.length + KEPT.length).toBe(74);
  });

  it.each(KEPT)('%s — 유지: 사람 세션 + claim이어도 /me 1(스토리지 직접 쓰기 전 재인가)', async (entry) => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok', user_id: 'u1', org_id: 'org-1', project_id: 'proj-1' });
    await call(entry);
    expect(meCalls()).toBe(1);
  });

  it.each(MOVED)('%s — 사람 세션 + claim → /me 0', async (entry) => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok', user_id: 'u1', org_id: 'org-1', project_id: 'proj-1' });
    await call(entry);
    expect(meCalls()).toBe(0);
  });

  it.each(MOVED)('%s — claim 없음 → /me 1(fail-closed)', async (entry) => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok', user_id: 'u1', org_id: null, project_id: null });
    await call(entry);
    expect(meCalls()).toBe(1);
  });

  it.each(MOVED)('%s — 세션 없음 → 401', async (entry) => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await call(entry);
    expect(res?.status).toBe(401);
  });
});
