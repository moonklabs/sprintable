// story #4398 ④ — 임시 관측(XFF 칸 모양) — 스위치 · 한 줄 · 헤더 원문이 안 섞임 · 프록시 입구에 배선됨.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logXffProbe, xffProbeEnabled, xffProbeRecord } from './xff-probe';

const GARBAGE = '<script>evil-token-4398</script>';

afterEach(() => vi.restoreAllMocks());

describe('xffProbeRecord — 주소 · 칸 수 · trace만', () => {
  it('맨 오른쪽이 주소가 아니면 표지로 · 쿠키 · 토큰 · 다른 칸은 안 남긴다', () => {
    const record = xffProbeRecord(new Headers({
      'x-forwarded-for': `198.51.100.9, ${GARBAGE}`,
      'x-cloud-trace-context': '0123456789abcdef0123456789abcdef/1;o=1',
      cookie: 'sp_at=secret-cookie',
      authorization: 'Bearer secret-token',
    }));
    expect(record).toEqual({
      event: 'xff_probe', service: 'frontend', xff_hops: 2, xff_rightmost: 'non-ip',
      trace_id: '0123456789abcdef0123456789abcdef',
    });
    const dumped = JSON.stringify(record);
    for (const leaked of ['evil-token-4398', 'secret-cookie', 'secret-token', '198.51.100.9']) expect(dumped).not.toContain(leaked);
  });

  it('주소는 그대로 · 헤더 없음은 빈 값', () => {
    expect(xffProbeRecord(new Headers({ 'x-forwarded-for': '203.0.113.7, 172.64.1.9' })).xff_rightmost).toBe('172.64.1.9');
    expect(xffProbeRecord(new Headers({}))).toMatchObject({ xff_hops: 0, xff_rightmost: '', trace_id: '' });
  });
});

describe('logXffProbe — 스위치', () => {
  const headers = new Headers({ 'x-forwarded-for': '172.64.1.9', cookie: 'sp_at=secret-cookie' });

  it('꺼져 있으면(미설정 · "true" 아님) 로그 0', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(logXffProbe(headers, {})).toBe(false);
    expect(logXffProbe(headers, { XFF_PROBE_ENABLED: '1' })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(xffProbeEnabled({ XFF_PROBE_ENABLED: 'true' })).toBe(true);
  });

  it('켜져 있으면 한 줄 JSON · 쿠키 없음', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(logXffProbe(headers, { XFF_PROBE_ENABLED: 'true' })).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'xff_probe', xff_hops: 1, xff_rightmost: '172.64.1.9' });
    expect(line).not.toContain('secret-cookie');
  });
});

it('프록시(입구)가 요청 헤더로 관측을 부른다', () => {
  const src = readFileSync(join(__dirname, '..', 'proxy.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function proxy('));
  expect(body.slice(0, 400)).toContain('logXffProbe(request.headers)');
});
