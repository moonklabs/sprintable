// [P1] AASA 서버 조건(print-aasa.js --checklist) 3종 회귀가드: 무리다이렉트·Content-Type
// 정확히 application/json(charset 파라미터 없이)·유효 JSON 본문.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const ENV_KEYS = ['APPLE_TEAM_ID', 'MOBILE_APP_LINK_ORIGIN'];

describe('GET /.well-known/apple-app-site-association', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('serves 200 with exactly application/json (no charset) and no redirect when configured', async () => {
    process.env['APPLE_TEAM_ID'] = 'JN798BC4KC';
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://app.sprintable.ai';
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Location')).toBeNull();
    const body = await res.json();
    expect(body.applinks.details[0].appID).toBe('JN798BC4KC.com.moonklabs.sprintable');
  });

  it('fails loud (500, not a broken 200) when APPLE_TEAM_ID is missing on this deploy', async () => {
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://app.sprintable.ai';
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
