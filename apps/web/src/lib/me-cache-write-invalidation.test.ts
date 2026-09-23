// @vitest-environment jsdom
//
// story #4184(PR #4565 까디르 QA · PO 처방) — /api/me 결과 재사용의 무효화가 `fetchWithAuth` 쓰기만 봐서, 전역 `fetch`로
// 하는 쓰기(2FA 켜기 two-factor-section 등 ~200곳)는 캐시를 안 버렸다 — 2FA를 켠 뒤 30초 안 fetchMe()가 여전히 «꺼짐».
// 무효화를 same-origin `/api/` 요청의 단일 관문(project-context-client의 window.fetch 인터셉터)으로 옮겨 raw fetch·
// fetchWithAuth·Request 입력 모두를 한 자리에서 잡는다. 쓰기 시작·완료 둘 다 세대를 올려, 쓰기 도중 출발한 /me 응답도 버린다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler;
const calls: string[] = [];

function meResponse(totp: boolean) {
  return new Response(JSON.stringify({ data: { id: 'm-1', totp_enabled: totp } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  (window as unknown as { fetch: unknown }).fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    calls.push(`${method} ${url}`);
    return handler(url, init);
  });
});

afterEach(() => { vi.restoreAllMocks(); });

async function load() {
  const ctx = await import('@/lib/project-context-client');
  ctx.installProjectHeaderInterceptor();
  const { fetchMe } = await import('@/lib/me-client');
  return { fetchMe };
}

const meCalls = () => calls.filter((c) => c.startsWith('GET /api/me')).length;

describe('/api/me 재사용 무효화 — 전역 fetch 쓰기(story #4184 까디르 재QA)', () => {
  it('⭐2FA 켬(raw fetch POST) → 30초 안이어도 fetchMe()는 새로 불러 «켜짐»', async () => {
    let totp = false;
    handler = async (url) => {
      if (url === '/api/me') return meResponse(totp);
      if (url === '/api/auth/2fa/verify') { totp = true; return new Response(null, { status: 200 }); }
      return new Response(null, { status: 404 });
    };
    const { fetchMe } = await load();
    expect(((await (await fetchMe()).json()) as { data: { totp_enabled: boolean } }).data.totp_enabled).toBe(false);
    await window.fetch('/api/auth/2fa/verify', { method: 'POST', body: '{}' });
    expect(((await (await fetchMe()).json()) as { data: { totp_enabled: boolean } }).data.totp_enabled).toBe(true);
    expect(meCalls()).toBe(2);
  });

  it.each([
    ['URL 입력 PATCH', () => window.fetch(new URL('/api/projects/p1', window.location.origin), { method: 'PATCH' })],
    ['Request 입력 DELETE', () => window.fetch(new Request(`${window.location.origin}/api/auth/2fa/disable`, { method: 'DELETE' }))],
    ['전환 POST(/api/switch-project)', () => window.fetch('/api/switch-project', { method: 'POST' })],
  ])('%s → 무효화', async (_n, write) => {
    handler = async (url) => (url.endsWith('/api/me') ? meResponse(false) : new Response(null, { status: 200 }));
    const { fetchMe } = await load();
    await fetchMe();
    await write();
    await fetchMe();
    expect(meCalls()).toBe(2);
  });

  it('fetchWithAuth 쓰기도 같은 관문을 지나 무효화(fetchWithAuth는 전역 fetch를 부른다)', async () => {
    handler = async (url) => (url === '/api/me' ? meResponse(false) : new Response(null, { status: 200 }));
    const { fetchMe } = await load();
    const { fetchWithAuth } = await import('@/lib/db/client');
    await fetchMe();
    await fetchWithAuth('/api/org-members/m-1', { method: 'PATCH', body: '{}' });
    await fetchMe();
    expect(meCalls()).toBe(2);
  });

  it('음성대조 — GET·HEAD·다른 출처 POST는 무효화하지 않는다(재사용 유지)', async () => {
    handler = async (url) => (url.endsWith('/api/me') ? meResponse(false) : new Response(null, { status: 200 }));
    const { fetchMe } = await load();
    await fetchMe();
    await window.fetch('/api/stories');
    await window.fetch('/api/stories', { method: 'HEAD' });
    await window.fetch('https://support-gateway.example.com/api/v1/sessions', { method: 'POST' });
    await fetchMe();
    expect(meCalls()).toBe(1);
  });

  it('쓰기가 시작되면(아직 끝나기 전에도) 쓰기 전 캐시를 버린다 — 도중 호출은 새로 부른다(쓰기 시작 무효화)', async () => {
    let releaseWrite!: () => void;
    handler = async (url) => {
      if (url === '/api/me') return meResponse(false);
      if (url === '/api/auth/2fa/verify') { await new Promise<void>((r) => { releaseWrite = r; }); return new Response(null, { status: 200 }); }
      return new Response(null, { status: 404 });
    };
    const { fetchMe } = await load();
    await fetchMe();
    const write = window.fetch('/api/auth/2fa/verify', { method: 'POST' });
    await fetchMe();
    expect(meCalls()).toBe(2);
    releaseWrite();
    await write;
  });

  it('쓰기 도중 출발한 /me 응답은 저장하지 않는다(쓰기 완료에서도 세대를 올림)', async () => {
    let releaseWrite!: () => void;
    let totp = false;
    handler = async (url) => {
      if (url === '/api/me') return meResponse(totp);
      if (url === '/api/auth/2fa/verify') {
        await new Promise<void>((r) => { releaseWrite = r; });
        totp = true;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    const { fetchMe } = await load();
    const write = window.fetch('/api/auth/2fa/verify', { method: 'POST' });
    const during = await fetchMe(); // 쓰기 도중 출발·도착(옛 값 false)
    expect(((await during.json()) as { data: { totp_enabled: boolean } }).data.totp_enabled).toBe(false);
    releaseWrite();
    await write;
    const after = await fetchMe(); // 쓰기 완료 뒤 — 도중 값이 캐시로 남았으면 false로 재사용됨
    expect(((await after.json()) as { data: { totp_enabled: boolean } }).data.totp_enabled).toBe(true);
  });
});

// ③ 가드(PO 처방의 취지 — «raw 쓰기가 조용히 새지 않게») — 쓰기 무효화는 인터셉터 한 곳이라, 새 raw fetch 쓰기는 이미
// 자동으로 덮인다. 대신 그 관문이 **설치돼 있다**는 사실 자체를 핀한다: 대시보드 셸이 렌더 단계에서(자식 fetch보다 먼저)
// installProjectHeaderInterceptor()를 부른다. 이 줄이 빠지거나 effect로 옮겨지면 raw 쓰기 무효화가 통째로 꺼진다.
describe('가드 — 쓰기 관문(fetch 인터셉터)이 앱 루트에서 설치된다(셸 밖 화면까지 · PO 위험 (a))', () => {
  it('루트 layout이 body 안 첫 자리(children보다 앞)에 FetchGateInstaller를 렌더하고, 설치기가 렌더 단계에서 관문을 연다', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const layout = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8');
    const iInstaller = layout.indexOf('<FetchGateInstaller />');
    const iChildren = layout.indexOf('{children}');
    expect(iInstaller, '루트 설치기가 없다').toBeGreaterThan(-1);
    expect(iInstaller).toBeLessThan(iChildren);
    const installer = readFileSync(join(__dirname, '..', 'components', 'providers', 'fetch-gate-installer.tsx'), 'utf8');
    expect(installer).toMatch(/^\s*installProjectHeaderInterceptor\(\);\s*$/m);
    expect(installer).not.toMatch(/useEffect/);
  });
});

describe('가드 — 쓰기 관문(fetch 인터셉터)이 대시보드 셸 렌더에서 설치된다', () => {
  it('dashboard-shell.tsx가 렌더 본문에서 installProjectHeaderInterceptor()를 부른다(useEffect 안이 아님)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'dashboard-shell.tsx'), 'utf8');
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => /^\s*installProjectHeaderInterceptor\(\);\s*$/.test(l));
    expect(idx, '설치 호출이 없다').toBeGreaterThan(-1);
    // 바로 위 20줄 안에 열린 useEffect( 가 없어야 한다(렌더 단계 설치 — 첫 자식 fetch 전).
    const before = lines.slice(Math.max(0, idx - 20), idx).join('\n');
    const openEffects = (before.match(/useEffect\(/g) ?? []).length;
    const closedEffects = (before.match(/\}, \[/g) ?? []).length;
    expect(openEffects - closedEffects, 'useEffect 안에서 설치하면 첫 로드 fetch가 관문을 안 지난다').toBeLessThanOrEqual(0);
  });
});

// PO 위험 (b) — 재사용률. «설정 화면 열기 + 채팅 1회 보내기» 순서의 /api/me 네트워크 수를 잰다(설정 한 번 = 절 7곳이
// fetchMe: 동시 5 + 첫 응답 뒤 순차 2 — 배포 18 CDP에서 본 모양). 주기적 non-GET은 없다(setInterval 콜백 전수: 쓰기 0 —
// inbox 15초 새로고침은 GET). 사용자 손 없이 나가는 쓰기는 채팅 읽음 표시(/read, 열린 대화에 새 메시지가 올 때 1회·up_to 멱등).
describe('재사용률 — 설정 열기·채팅 보내기 순서의 /api/me 수(PO 위험 (b))', () => {
  async function openSettings(fetchMe: () => Promise<Response>) {
    await Promise.all([fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe()]);
    await fetchMe();
    await fetchMe();
  }
  beforeEach(() => {
    handler = async (url) => (url === '/api/me' ? meResponse(false) : new Response(null, { status: 200 }));
  });

  it('설정 열기 → 30초 안 다시 열기(쓰기 없음) = 1회', async () => {
    const { fetchMe } = await load();
    await openSettings(fetchMe);
    await openSettings(fetchMe);
    expect(meCalls()).toBe(1);
  });

  it('설정 열기 → 채팅 1회 보내기(POST) → 다시 열기 = 2회(쓰기 뒤 한 번만 새로)', async () => {
    const { fetchMe } = await load();
    await openSettings(fetchMe);
    await window.fetch('/api/conversations/c1/messages', { method: 'POST', body: '{}' });
    await openSettings(fetchMe);
    expect(meCalls()).toBe(2);
  });

  it('⭐채팅 읽음 표시(/read, 자동·고빈도)는 제외 — 읽음 POST가 진행 중이어도 설정 진입은 /me 1회(PO 위험 (b))', async () => {
    let releaseRead!: () => void;
    let firstRead = true;
    handler = async (url) => {
      if (url === '/api/me') return meResponse(false);
      if (url.endsWith('/read') && firstRead) {
        firstRead = false;
        await new Promise<void>((r) => { releaseRead = r; });
      }
      return new Response(null, { status: 200 });
    };
    const { fetchMe } = await load();
    const read = window.fetch('/api/conversations/c1/read', { method: 'POST', body: '{}' });
    await openSettings(fetchMe);
    releaseRead();
    await read;
    for (let i = 0; i < 5; i++) await window.fetch('/api/chats/c1/read', { method: 'POST', body: '{}' });
    await openSettings(fetchMe);
    expect(meCalls()).toBe(1);
  });

  it('제외 목록은 읽음 경로만 — 같은 대화의 메시지 보내기(/messages)는 여전히 무효화', async () => {
    const { isMeInvalidatingWrite } = await import('@/lib/project-context-client');
    expect(isMeInvalidatingWrite('/api/conversations/c1/read', 'POST')).toBe(false);
    expect(isMeInvalidatingWrite('/api/chats/c1/read', 'POST')).toBe(false);
    expect(isMeInvalidatingWrite('/api/conversations/c1/messages', 'POST')).toBe(true);
    expect(isMeInvalidatingWrite('/api/conversations/c1/read/extra', 'POST')).toBe(true);
    expect(isMeInvalidatingWrite('/api/conversations/c1/read', 'GET')).toBe(false);
  });
});
