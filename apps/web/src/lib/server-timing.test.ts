// story #4219 C1 — 서버 구간 마커가 실제 undici 요청을 잡는지(실 로컬 HTTP 서버 + 실 fetch · keep-alive).
// 마커는 동작을 바꾸지 않는 계측이라, 여기서 재는 것은 «기록이 맞는가»: 호출별 이름(경로 → 고정 이름)·시작 오프셋·
// 연결 새로 엶/재사용 · 꺼져 있으면 기록 0 · 헤더 값에 경로·id가 안 샌다.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatServerTiming, spanNameForPath, withServerTiming } from './server-timing';
import diagnosticsChannel from 'node:diagnostics_channel';

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const delay = req.url?.startsWith('/api/v2/activation/checklist') ? 40 : 5;
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, delay);
  });
  server.keepAliveTimeout = 5000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

afterEach(() => { delete process.env['SERVER_TIMING_MARKERS']; });

const get = async (path: string) => { const r = await fetch(base + path, { cache: 'no-store' }); await r.text(); };

describe('spanNameForPath — 경로 → 고정 이름(id·쿼리 안 남김)', () => {
  it('알려진 백엔드 경로 · 모르는 경로는 other', () => {
    expect(spanNameForPath('/api/v2/me')).toBe('me');
    expect(spanNameForPath('/api/v2/me/memberships')).toBe('me_memberships');
    expect(spanNameForPath('/api/v2/resolve?workspace=a&project=b')).toBe('resolve');
    expect(spanNameForPath('/api/v2/projects/6f1c2e0a-1b2c-4d5e-8f90-123456789abc')).toBe('project');
    expect(spanNameForPath('/api/v2/organizations')).toBe('organizations_list');
    expect(spanNameForPath('/api/v2/activation/checklist')).toBe('activation_checklist');
    expect(spanNameForPath('/api/v2/secret/thing/123')).toBe('other');
  });
});

describe('withServerTiming — 실 fetch 기록', () => {
  it('꺼져 있으면(기본) 기록 0 · 값은 그대로', async () => {
    const { value, spans } = await withServerTiming(async () => { await get('/api/v2/me'); return 42; });
    expect(value).toBe(42);
    expect(spans).toEqual([]);
  });

  it('⭐켜면 실 fetch 호출별 이름·시작 오프셋·시간·연결 판정이 기록된다', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    const { spans, totalMs } = await withServerTiming(async () => {
      await get('/api/v2/me');
      await get('/api/v2/organizations');
    });
    expect(spans.map((s) => s.name)).toEqual(['me', 'organizations_list']);
    expect(spans[1]!.startMs).toBeGreaterThanOrEqual(spans[0]!.startMs);
    for (const s of spans) {
      expect(s.durMs).not.toBeNull();
      expect(s.waitMs).not.toBeNull();
      expect(typeof s.newConnection).toBe('boolean');
      expect(s.proto).toBe('h1'); // story #4299 AC2 — 평문 로컬 서버 = h1(h2는 server-dispatcher.test.ts의 TLS 서버로)
    }
    expect(totalMs).toBeGreaterThanOrEqual(spans[0]!.durMs!);
  });

  it('⭐연결 판정 — 소켓 연결 시각이 이 호출 생성 뒤면 새 연결, 전이면(범위 밖 요청이 연 keep-alive 포함) 재사용', async () => {
    // 테스트 러너 안 fetch는 연결 풀 동작이 달라 실 재사용을 재현 못 해, undici와 같은 모양의 채널 이벤트를 직접 싣는다.
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    const connected = diagnosticsChannel.channel('undici:client:connected');
    const create = diagnosticsChannel.channel('undici:request:create');
    const send = diagnosticsChannel.channel('undici:client:sendHeaders');
    const trailers = diagnosticsChannel.channel('undici:request:trailers');
    const warm = await withServerTiming(async () => {}); // 구독 보장(모듈 로드 때 꺼져 있었으므로)
    expect(warm.spans).toEqual([]);
    const outsideSocket = {}, freshSocket = {};
    // 범위 밖 요청이 먼저 연결을 열어 쓰고 있었다.
    connected.publish({ socket: outsideSocket, connectParams: {} });
    const one = (path: string, socket: object, connectFirst: boolean) => {
      const request = { origin: 'http://be', path };
      create.publish({ request });
      if (connectFirst) connected.publish({ socket, connectParams: {} });
      send.publish({ request, socket, headers: '' });
      trailers.publish({ request, trailers: [] });
    };
    const { spans } = await withServerTiming(async () => {
      one('/api/v2/me', outsideSocket, false); // 범위 밖이 연 소켓 재사용
      one('/api/v2/resolve', freshSocket, true); // 이 요청이 새로 연 소켓
      one('/api/v2/projects/x', freshSocket, false); // 방금 연 소켓 재사용
    });
    expect(spans.map((s) => s.newConnection)).toEqual([false, true, false]);
  });

  it('동시 호출(Promise.all) 둘은 같은 시각에 시작하고 각자 기록된다', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    const { spans } = await withServerTiming(async () => {
      await Promise.all([get('/api/v2/projects/abc'), get('/api/v2/activation/checklist')]);
    });
    expect(spans.map((s) => s.name).sort()).toEqual(['activation_checklist', 'project']);
    expect(Math.abs(spans[0]!.startMs - spans[1]!.startMs)).toBeLessThan(20);
  });

  it('계측 범위 밖에서 나간 요청은 기록하지 않는다(요청 간 섞임 0)', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    // 다른 요청(범위 밖 문맥)이 이 요청의 계측 **도중에** 백엔드를 부른다 — 범위 밖에서 예약한 타이머라 문맥이 다르다.
    let outside: Promise<void> | undefined;
    setTimeout(() => { outside = get('/api/v2/me'); }, 5);
    const { spans } = await withServerTiming(async () => {
      await new Promise((r) => setTimeout(r, 30));
      await get('/api/v2/resolve');
    });
    await outside;
    expect(outside).toBeDefined();
    expect(spans.map((s) => s.name)).toEqual(['resolve']);
  });
});

describe('formatServerTiming — 이름·시간만', () => {
  it('헤더 값에 경로·id 없음', () => {
    const v = formatServerTiming('proxy', 120, [{ name: 'project', startMs: 51, durMs: 40, waitMs: 38, newConnection: true, proto: 'h2' }]);
    expect(v).toBe('proxy;dur=120, be0-project;dur=40;desc="t+51 wait=38 proto=h2 conn=new"');
    // 소켓 정보가 없던 호출은 판을 모른다(?) — 추측으로 메우지 않는다.
    expect(formatServerTiming('proxy', 1, [{ name: 'me', startMs: 0, durMs: null, waitMs: null, newConnection: null, proto: null }]))
      .toBe('proxy;dur=1, be0-me;dur=-1;desc="t+0 wait=-1 proto=? conn=?"');
    expect(v).not.toMatch(/\/api|[0-9a-f]{8}-/);
  });
});

describe('배선 핀 — 꺼져 있으면 동작 그대로 · dev 분기에서만 켬', () => {
  it('proxy는 꺼져 있으면 원래 처리로 바로 · 레이아웃은 계측 범위로 감쌈 · cloudbuild dev 분기에서만 SERVER_TIMING_MARKERS=true', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', '..', '..', '..');
    const proxy = readFileSync(join(root, 'apps/web/src/proxy.ts'), 'utf8');
    expect(proxy).toMatch(/if \(!isServerTimingEnabled\(\)\) return proxyImpl\(request\);/);
    const layout = readFileSync(join(root, 'apps/web/src/app/(authenticated)/layout.tsx'), 'utf8');
    expect(layout).toMatch(/withServerTiming\(\(\) => AuthenticatedLayoutBody\(props\)\)/);
    const cb = readFileSync(join(root, 'cloudbuild.yaml'), 'utf8');
    const devBranch = cb.match(/if \[ "\$\{_DEPLOY_ENV\}" == "dev" \]; then\n([\s\S]*?)\n\s*fi\n\s*gcloud run deploy sprintable-frontend-/);
    expect(devBranch?.[1]).toMatch(/SERVER_TIMING_MARKERS=true/);
    expect(cb.match(/SERVER_TIMING_MARKERS=true/g)).toHaveLength(1);
  });
});

// story #4299 AC2 — 라우트 전체 계측(withRouteTiming)과 겹친 계측 범위. 응답을 새로 만드는 라우트(sprints · stories · goals …)는
// 인증 /api/v2/me가 본 호출 앞에 먼저 나가고, 본 호출은 안쪽 proxyToFastapi(자기 범위) 또는 저장소 fastapiCall로 나간다 —
// 바깥 범위가 둘 다 봐야 «BFF 층 몫»이 한 헤더로 갈린다.
describe('겹친 계측 범위 — 안쪽 호출도 바깥에 적힌다', () => {
  it('바깥 범위는 안쪽 범위의 호출까지 모두 · 안쪽은 자기 것만 · 시작 오프셋은 범위마다 자기 시작 기준', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    let inner: Awaited<ReturnType<typeof withServerTiming>> | undefined;
    const outer = await withServerTiming(async () => {
      await get('/api/v2/me');
      await new Promise((r) => setTimeout(r, 20));
      inner = await withServerTiming(async () => { await get('/api/v2/activation/checklist'); });
    });
    expect(outer.spans.map((s) => s.name)).toEqual(['me', 'activation_checklist']);
    expect(inner!.spans.map((s) => s.name)).toEqual(['activation_checklist']);
    const [o, i] = [outer.spans[1]!, inner!.spans[0]!];
    expect(o.startMs).toBeGreaterThanOrEqual(i.startMs + 15); // 바깥 시작이 20ms 앞
    expect([o.durMs, o.waitMs, o.newConnection]).toEqual([i.durMs, i.waitMs, i.newConnection]); // 같은 호출 · 같은 값
    expect(o.durMs).not.toBeNull();
  });
});

describe('withRouteTiming — 라우트 전체(합계 · bff_pre · 모든 백엔드 호출)', () => {
  const handler = async () => {
    await get('/api/v2/me');
    const inner = await withServerTiming(async () => { await get('/api/v2/secret/xyz-6f1c2e0a'); return 1; });
    return new Response(JSON.stringify({ data: inner.value }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const req = (mwT0?: number) => new Request('https://app.example.com/api/stories?project_id=p-1', { headers: mwT0 ? { 'x-sp-mw-t0': String(mwT0) } : {} });

  it('꺼져 있으면 handler를 그대로 — 헤더 없음 · 로그 0 · 본문 그대로', async () => {
    const { withRouteTiming } = await import('./server-timing');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await withRouteTiming('stories', handler)(req());
      expect(res.headers.get('Server-Timing')).toBeNull();
      expect(await res.json()).toEqual({ data: 1 });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('켜면 합계 · bff_pre · 인증 /me와 안쪽 호출이 한 헤더에 · 로그 한 줄(kind route/<이름>) · 경로 · id 0', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    const { withRouteTiming } = await import('./server-timing');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await withRouteTiming('stories', handler)(req(Date.now() - 7));
      const st = res.headers.get('Server-Timing') ?? '';
      expect(st).toMatch(/^bff;dur=\d+, bff_pre;dur=\d+;desc="mw\+queue", be0-me;dur=\d+;desc="t\+\d+ wait=\d+ proto=h1 conn=(new|reuse)", be1-other;dur=\d+;desc=/);
      expect(Number(/bff_pre;dur=(\d+)/.exec(st)![1])).toBeGreaterThanOrEqual(7);
      expect(st).not.toMatch(/\/api|stories|secret|6f1c2e0a|p-1/);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"server_timing"'));
      expect(lines).toHaveLength(1);
      const j = JSON.parse(lines[0]!);
      expect([j.surface, j.kind, j.status, j.spans.map((s: { name: string }) => s.name)]).toEqual(['bff', 'route/stories', 200, ['me', 'other']]);
      expect(lines[0]).not.toMatch(/secret|6f1c2e0a|p-1/);
      expect(await res.json()).toEqual({ data: 1 });
    } finally { log.mockRestore(); }
  });
});

describe('배선 핀 — 헤더 없던 라우트 9개는 라우트 전체 계측으로 감쌈', () => {
  // 기기 콜드(보드) 판에서 BFF 구간이 안 실리던 /api 9경로(4299 AC1 쿠키 판 · 13건): 응답을 apiSuccess로 새로 만들거나
  // 저장소 fastapiCall을 쓰거나 인증 /me를 먼저 부른다.
  const ROUTES: Array<[string, string]> = [
    ['billing/status', 'billing-status'], ['activation/checklist', 'activation-checklist'], ['release-notes', 'release-notes'],
    ['assets/storage-usage', 'storage-usage'], ['sprints', 'sprints'], ['stories', 'stories'], ['members', 'members'],
    ['goals', 'goals'], ['glance/attention', 'glance-attention'],
  ];
  it.each(ROUTES)('/api/%s GET = withRouteTiming(%j, …)', async (dir, kind) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'app', 'api', dir, 'route.ts'), 'utf8');
    expect(src).toContain(`export const GET = withRouteTiming('${kind}', async (`);
    expect(src).not.toMatch(/export async function GET\(/);
  });
});
