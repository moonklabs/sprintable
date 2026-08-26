// [P1] iOS TestFlight 구글 로그인 후 404 — AASA 미서빙 인시던트 회귀가드.
// 기대값은 손으로 적지 않고 sprintable-mobile 레포의 `node scripts/print-aasa.js JN798BC4KC`
// (prod)·`EXPO_PUBLIC_WEB_URL=https://dev-app.sprintable.ai node scripts/print-aasa.js
// JN798BC4KC`(dev) 실측 출력을 그대로 옮겼다(2026-08-26) — 이 리포는 그 스크립트를 직접
// import할 수 없어(별개 레포) 구조를 미러링하되 값은 실측 출력과 대조해 맞춘다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAasaDocument, MissingAppleTeamIdError } from './native-app-links';

const ENV_KEYS = ['APPLE_TEAM_ID', 'MOBILE_APP_LINK_ORIGIN'];

describe('buildAasaDocument', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('throws MissingAppleTeamIdError when APPLE_TEAM_ID is unset — must not silently serve a broken app id', () => {
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://app.sprintable.ai';
    expect(() => buildAasaDocument()).toThrow(MissingAppleTeamIdError);
  });

  it('matches sprintable-mobile print-aasa.js prod output byte-for-byte in structure', () => {
    process.env['APPLE_TEAM_ID'] = 'JN798BC4KC';
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://app.sprintable.ai';
    const doc = buildAasaDocument();
    expect(doc).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appIDs: ['JN798BC4KC.com.moonklabs.sprintable'],
            components: [
              { '/': '/native/oauth-return*', comment: 'OAuth 복귀 — 앱이 안 잡으면 로그인이 브라우저에서 끝난다' },
            ],
            appID: 'JN798BC4KC.com.moonklabs.sprintable',
            paths: ['/native/oauth-return*'],
          },
        ],
      },
    });
  });

  it('matches sprintable-mobile print-aasa.js dev output byte-for-byte in structure (.dev bundle suffix)', () => {
    process.env['APPLE_TEAM_ID'] = 'JN798BC4KC';
    process.env['MOBILE_APP_LINK_ORIGIN'] = 'https://dev-app.sprintable.ai';
    const doc = buildAasaDocument();
    expect(doc).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appIDs: ['JN798BC4KC.com.moonklabs.sprintable.dev'],
            components: [
              { '/': '/native/oauth-return*', comment: 'OAuth 복귀 — 앱이 안 잡으면 로그인이 브라우저에서 끝난다' },
            ],
            appID: 'JN798BC4KC.com.moonklabs.sprintable.dev',
            paths: ['/native/oauth-return*'],
          },
        ],
      },
    });
  });

  it('defaults to dev bundle id when MOBILE_APP_LINK_ORIGIN is unset — fail toward "developer notices", not "wrong app id in prod"', () => {
    process.env['APPLE_TEAM_ID'] = 'JN798BC4KC';
    const doc = buildAasaDocument();
    expect(doc.applinks.details[0]?.appID).toBe('JN798BC4KC.com.moonklabs.sprintable.dev');
  });
});
