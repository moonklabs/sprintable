// story #4398 — 요청 상한이 셀 사용자 IP를 프런트가 한 번 정해 비밀과 함께 넘긴다. 위조 표:
// | 들어온 요청 | 꾸민 헤더 | 넘기는 사용자 IP |
// | CF 대역에서 접속(정상 경로) | 없음 | CF-Connecting-IP |
// | run.app 직통(CF 대역 밖) | CF-Connecting-IP · XFF 앞 칸 | 접속 주소(XFF 오른쪽 끝) |
// | 비밀 미설정 | — | 아무것도 안 실음 |
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock, getLocaleMock } = vi.hoisted(() => ({ getServerSessionMock: vi.fn(), getLocaleMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/i18n/request', () => ({ getLocale: getLocaleMock }));

import { CLIENT_IP_HEADER, EDGE_KEY_HEADER, edgeClientIpHeaders, isBackendOrigin, isCloudflareAddress, resolveClientIp } from './client-ip';
import { backendFetch } from './backend-fetch';
import { proxyToFastapi } from './fastapi-proxy';
import { fastapiBaseUrl } from './fastapi-url';

const CF_EDGE = '172.64.1.9'; // 172.64.0.0/13 안
const CF_EDGE_V6 = '2606:4700::6810:1';
const DIRECT = '198.51.100.9';
const USER = '203.0.113.7';

const h = (init: Record<string, string>) => new Headers(init);

describe('resolveClientIp — 접속 주소(XFF 오른쪽 끝)가 CF 대역일 때만 CF-Connecting-IP', () => {
  it('정상 경로: CF 대역 접속 → CF-Connecting-IP', () => {
    expect(resolveClientIp(h({ 'x-forwarded-for': `${USER}, ${CF_EDGE}`, 'cf-connecting-ip': USER }))).toBe(USER);
    expect(resolveClientIp(h({ 'x-forwarded-for': CF_EDGE_V6, 'cf-connecting-ip': '2001:db8::7' }))).toBe('2001:db8::7');
  });

  it('run.app 직통: 꾸민 CF-Connecting-IP · XFF 앞 칸은 무시 → 접속 주소', () => {
    expect(resolveClientIp(h({ 'x-forwarded-for': `${USER}, ${DIRECT}`, 'cf-connecting-ip': USER }))).toBe(DIRECT);
  });

  it('CF 대역 접속인데 CF-Connecting-IP가 없거나 깨졌으면 접속 주소', () => {
    expect(resolveClientIp(h({ 'x-forwarded-for': CF_EDGE }))).toBe(CF_EDGE);
    expect(resolveClientIp(h({ 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': 'nope' }))).toBe(CF_EDGE);
  });

  it('XFF가 없거나 오른쪽 끝이 주소가 아니면 null(로컬 · 헤더 없음)', () => {
    expect(resolveClientIp(h({}))).toBeNull();
    expect(resolveClientIp(h({ 'x-forwarded-for': `${USER}, garbage` }))).toBeNull();
  });

  it('CF 대역 판정: 대역 안 · 밖 · 주소 아님', () => {
    expect(isCloudflareAddress(CF_EDGE)).toBe(true);
    expect(isCloudflareAddress(CF_EDGE_V6)).toBe(true);
    expect(isCloudflareAddress(DIRECT)).toBe(false);
    expect(isCloudflareAddress('not-ip')).toBe(false);
  });
});

describe('edgeClientIpHeaders — 비밀 · 사용자 IP가 다 있을 때만 두 헤더', () => {
  const incoming = h({ 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': USER });
  it('비밀 있음 → 두 헤더', () => {
    expect(edgeClientIpHeaders(incoming, 's3cret')).toEqual({ [CLIENT_IP_HEADER]: USER, [EDGE_KEY_HEADER]: 's3cret' });
  });
  it('비밀 없음 · 요청 헤더 없음 · 사용자 IP 못 정함 → 아무것도 안 실음(백엔드가 자기 앞단 주소로 셈)', () => {
    expect(edgeClientIpHeaders(incoming, '')).toEqual({});
    expect(edgeClientIpHeaders(null, 's3cret')).toEqual({});
    expect(edgeClientIpHeaders(h({}), 's3cret')).toEqual({});
  });
});

describe('BFF 두 헬퍼가 백엔드로 싣는다', () => {
  beforeEach(() => {
    process.env['EDGE_CLIENT_IP_SECRET'] = 's3cret';
    getLocaleMock.mockResolvedValue('en');
    getServerSessionMock.mockResolvedValue({ access_token: 't', org_id: 'o', project_id: 'p' });
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  });
  afterEach(() => {
    delete process.env['EDGE_CLIENT_IP_SECRET'];
  });

  const sent = () => {
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    return new Headers(init.headers);
  };
  const browser = () => new Request('http://localhost/api/x', {
    method: 'POST', headers: { 'x-forwarded-for': `${USER}, ${CF_EDGE}`, 'cf-connecting-ip': USER },
  });

  it('backendFetch(백엔드 주소 · 원 요청 넘김) → 사용자 IP + 비밀', async () => {
    await backendFetch(`${fastapiBaseUrl()}/api/v2/auth/set-password/request`, { method: 'POST', request: browser() });
    expect(sent().get(CLIENT_IP_HEADER)).toBe(USER);
    expect(sent().get(EDGE_KEY_HEADER)).toBe('s3cret');
  });

  it('backendFetch가 백엔드가 아닌 주소로 가면 비밀을 싣지 않는다', async () => {
    await backendFetch('https://example.com/elsewhere', { request: browser() });
    expect(sent().get(EDGE_KEY_HEADER)).toBeNull();
    expect(sent().get(CLIENT_IP_HEADER)).toBeNull();
  });

  it('backendFetch: 비밀 미설정이면 아무것도 안 싣는다(배포 순서에 안 막힘)', async () => {
    delete process.env['EDGE_CLIENT_IP_SECRET'];
    await backendFetch(`${fastapiBaseUrl()}/api/v2/auth/token`, { method: 'POST', request: browser() });
    expect(sent().get(EDGE_KEY_HEADER)).toBeNull();
  });

  it('proxyToFastapi → 사용자 IP + 비밀 · 브라우저가 꾸민 두 헤더는 그대로 넘기지 않는다', async () => {
    const forged = new Request('http://localhost/api/auth/resend-verification', {
      method: 'POST',
      headers: {
        'x-forwarded-for': `${USER}, ${DIRECT}`, 'cf-connecting-ip': USER,
        [CLIENT_IP_HEADER]: '192.0.2.1', [EDGE_KEY_HEADER]: 'guess',
      },
    });
    await proxyToFastapi(forged, '/api/v2/auth/resend-verification');
    expect(sent().get(CLIENT_IP_HEADER)).toBe(DIRECT); // 직통이라 CF 헤더 무시 → 접속 주소
    expect(sent().get(EDGE_KEY_HEADER)).toBe('s3cret');
  });
});

describe('isBackendOrigin — 비밀은 백엔드 origin에만(문자열 앞머리 비교 X)', () => {
  const base = 'https://backend.example.run.app';
  it('같은 origin만 참', () => {
    expect(isBackendOrigin(`${base}/api/v2/auth/token`, base)).toBe(true);
    expect(isBackendOrigin('https://backend.example.run.app:8443/x', base)).toBe(false);
    expect(isBackendOrigin('http://backend.example.run.app/x', base)).toBe(false);
  });
  it('앞머리만 같은 딴 호스트 · 사용자 정보로 가린 딴 호스트 · 깨진 주소는 거짓', () => {
    expect(isBackendOrigin('https://backend.example.run.app.evil.com/x', base)).toBe(false);
    expect(isBackendOrigin('https://backend.example.run.app@evil.com/x', base)).toBe(false);
    expect(isBackendOrigin('https://user:pw@backend.example.run.app/x', base)).toBe(false);
    expect(isBackendOrigin('not a url', base)).toBe(false);
  });
});

describe('비밀을 실은 요청의 리다이렉트 — 다른 origin으로 따라가지 않는다', () => {
  beforeEach(() => {
    process.env['EDGE_CLIENT_IP_SECRET'] = 's3cret';
    getLocaleMock.mockResolvedValue('en');
    getServerSessionMock.mockResolvedValue({ access_token: 't', org_id: 'o', project_id: 'p' });
  });
  afterEach(() => {
    delete process.env['EDGE_CLIENT_IP_SECRET'];
  });
  const browser = () => new Request('http://localhost/api/x', {
    method: 'POST', headers: { 'x-forwarded-for': `${USER}, ${CF_EDGE}`, 'cf-connecting-ip': USER },
  });
  const calls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];

  it('앞머리만 같은 딴 호스트로 가는 backendFetch엔 비밀을 안 싣는다', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    await backendFetch(`${fastapiBaseUrl()}.evil.com/steal`, { request: browser() });
    const base = new URL(fastapiBaseUrl());
    await backendFetch(`${base.protocol}//${base.host}@evil.com/steal`, { request: browser() }); // 백엔드 호스트를 사용자 정보로 가린 딴 곳
    for (const [, init] of calls()) expect(new Headers(init.headers).get(EDGE_KEY_HEADER)).toBeNull();
  });

  it('다른 origin으로 가라는 307은 따라가지 않고 그대로 돌려준다(비밀이 새지 않음)', async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://evil.com/collect' } }));
    const res = await backendFetch(`${fastapiBaseUrl()}/api/v2/auth/token`, { method: 'POST', body: '{}', request: browser() });
    expect(res.status).toBe(307);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![1].redirect).toBe('manual');
  });

  it('백엔드 안의 307(끝 슬래시 등)은 같은 헤더 · 같은 방법으로 따라간다', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/api/v2/auth/token/' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await backendFetch(`${fastapiBaseUrl()}/api/v2/auth/token`, { method: 'POST', body: '{}', request: browser() });
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]![0]).toBe(`${fastapiBaseUrl()}/api/v2/auth/token/`);
    expect(calls()[1]![1].method).toBe('POST');
    expect(new Headers(calls()[1]![1].headers).get(EDGE_KEY_HEADER)).toBe('s3cret');
  });

  it('303은 GET · 본문 없음으로 따라간다(fetch 표준)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: `${fastapiBaseUrl()}/done` } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await backendFetch(`${fastapiBaseUrl()}/api/v2/x`, { method: 'POST', body: '{}', request: browser() });
    expect(calls()[1]![1].method).toBe('GET');
    expect(calls()[1]![1].body).toBeUndefined();
  });

  it('proxyToFastapi도 다른 origin 307을 따라가지 않는다', async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://evil.com/collect' } }));
    await proxyToFastapi(browser(), '/api/v2/auth/resend-verification');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![1].redirect).toBe('manual');
  });
});
