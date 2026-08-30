// story #3222 — 이중래핑 회귀가드. BE(notification_preferences.py)가 예전엔 {"data": [...]}로
// 반환했는데, 이 route(→ proxyToFastapi → apiSuccess)가 그 응답 바디를 그대로 다시
// {data: raw, ...}로 감싸 최종 FE 응답이 {data: {data: [...]}}로 이중래핑됐다(설정>알림 화면이
// 레벨 저장해도 조용히 반영 안 되는 실사고 — PR#3605 billing/orders와 동일 클래스).
// fastapi-proxy.test.ts/billing orders route.test.ts와 동형 — global.fetch mock으로 BE 응답을
// 흉내내고 GET/PUT을 직접 호출해 실경로(route → proxyToFastapi → apiSuccess)를 지난다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContextMock, getServerSessionMock } = vi.hoisted(() => ({
  getAuthContextMock: vi.fn(),
  getServerSessionMock: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: getAuthContextMock }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));

import { GET, PUT } from './route';

describe('/api/notification-preferences — 이중래핑 회귀가드(story #3222)', () => {
  beforeEach(() => {
    getAuthContextMock.mockReset();
    getServerSessionMock.mockReset();
    getAuthContextMock.mockResolvedValue({ id: 'member-1', type: 'human' });
    getServerSessionMock.mockResolvedValue({ access_token: 'token-1' });
  });

  it('GET: BE가 flat list를 반환하면 FE 최종 응답은 단일래핑 {data: [...]}이다(이중래핑 금지)', async () => {
    const bePrefs = [{
      id: 'pref-1', member_id: 'member-1', scope_type: 'global', scope_id: null,
      event_key: null, channel: 'in_app', level: 'mentions', updated_at: '2026-08-30T00:00:00Z',
    }];
    // BE 라우터(get_preferences)가 실제로 반환하는 형상 — flat list(dict로 감싸지 않음).
    global.fetch = vi.fn(async () => new Response(JSON.stringify(bePrefs), { status: 200 }));

    const res = await GET(new Request('http://localhost/api/notification-preferences'));
    const json = await res.json();

    // 이중래핑이었다면 json.data가 {data: [...]}(object)였을 것 — 배열 자체여야 한다.
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual(bePrefs);
    expect(json.error).toBeNull();
  });

  it('PUT: BE가 flat list를 반환하면 FE 최종 응답은 단일래핑 {data: [...]}이다(이중래핑 금지)', async () => {
    const bePrefs = [{
      id: 'pref-1', member_id: 'member-1', scope_type: 'global', scope_id: null,
      event_key: null, channel: 'in_app', level: 'mentions', updated_at: '2026-08-30T00:00:00Z',
    }];
    global.fetch = vi.fn(async () => new Response(JSON.stringify(bePrefs), { status: 200 }));

    const res = await PUT(new Request('http://localhost/api/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify({ preferences: [{ scope_type: 'global', scope_id: null, channel: 'in_app', level: 'mentions' }] }),
    }));
    const json = await res.json();

    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual(bePrefs);
    expect(json.data[0].level).toBe('mentions');
    expect(json.error).toBeNull();
  });
});
