// story #4219 C1 — 서버 구간 마커가 실제 undici 요청을 잡는지(실 로컬 HTTP 서버 + 실 fetch · keep-alive).
// 마커는 동작을 바꾸지 않는 계측이라, 여기서 재는 것은 «기록이 맞는가»: 호출별 이름(경로 → 고정 이름)·시작 오프셋·
// 연결 새로 엶/재사용 · 꺼져 있으면 기록 0 · 헤더 값에 경로·id가 안 샌다.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
    const v = formatServerTiming('proxy', 120, [{ name: 'project', startMs: 51, durMs: 40, waitMs: 38, newConnection: true }]);
    expect(v).toBe('proxy;dur=120, be0-project;dur=40;desc="t+51 wait=38 conn=new"');
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
