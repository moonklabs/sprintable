// iOS Universal Link 검증파일(AASA, apple-app-site-association) 본문 — sprintable-mobile
// 레포 lib/appLinks.js가 선언한 경로 단일 출처(`/native/oauth-return*`)를 미러링한다.
// [P1 인시던트] 선생님 실기기 iOS TestFlight Google 로그인 후 404 — 이 파일이 여태 없어서
// 유니버설 링크 복귀가 앱으로 반사되지 않고 웹이 직접 로드돼 404가 났다.
//
// 두 리포로 갈라진 선언이라(Android는 앱 매니페스트, iOS는 이 서버 파일) 손으로 옮겨 적으면
// 드리프트가 생긴다 — `node scripts/print-aasa.js <TEAM_ID>` 실측 출력과 구조를 맞춘 값이다
// (native-app-links.test.ts가 그 출력과 대조).
import { NextResponse } from 'next/server';

const APP_LINK_PATH = '/native/oauth-return*';
const APP_LINK_COMMENT = 'OAuth 복귀 — 앱이 안 잡으면 로그인이 브라우저에서 끝난다';

// mobile lib/webOrigin.js와 같은 규율: 기본값은 dev — 환경변수 설정을 까먹었을 때
// "사용자에게 prod 앱ID가 잘못 박히는" 쪽이 아니라 "개발자가 알아채는" 쪽으로 실패해야 한다.
const PROD_APP_LINK_ORIGIN = 'https://app.sprintable.ai';
const DEV_APP_LINK_ORIGIN = 'https://dev-app.sprintable.ai';
const BASE_BUNDLE_ID = 'com.moonklabs.sprintable';

export function currentAppLinkOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env['MOBILE_APP_LINK_ORIGIN']?.trim() || DEV_APP_LINK_ORIGIN;
}

// app.config.js(#2979)의 isDev 판정과 동형 — dev 호스트는 bundle id에 `.dev`가 붙는다.
export function bundleIdForOrigin(origin: string): string {
  return origin === PROD_APP_LINK_ORIGIN ? BASE_BUNDLE_ID : `${BASE_BUNDLE_ID}.dev`;
}

export class MissingAppleTeamIdError extends Error {}

export function buildAasaDocument(env: NodeJS.ProcessEnv = process.env) {
  const teamId = env['APPLE_TEAM_ID']?.trim();
  if (!teamId) {
    throw new MissingAppleTeamIdError('APPLE_TEAM_ID env var missing — cannot build AASA');
  }
  const bundleId = bundleIdForOrigin(currentAppLinkOrigin(env));
  const appId = `${teamId}.${bundleId}`;
  return {
    applinks: {
      apps: [], // legacy(iOS 12 이하) 규격 — 반드시 빈 배열
      details: [
        {
          appIDs: [appId],
          components: [{ '/': APP_LINK_PATH, comment: APP_LINK_COMMENT }],
          appID: appId, // legacy 자리 — 신형(components)과 같은 값 중복
          paths: [APP_LINK_PATH],
        },
      ],
    },
  };
}

// 조건 1(리다이렉트 금지)·2(Content-Type: application/json 정확히, charset 파라미터 없이)를
// NextResponse.json()의 기본 charset 부착 없이 직접 못박는다 — iOS AASA 검증기는 까다롭다.
export function aasaRouteResponse(): NextResponse {
  try {
    const doc = buildAasaDocument();
    return new NextResponse(JSON.stringify(doc), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof MissingAppleTeamIdError) {
      console.error('aasa.missing_team_id — APPLE_TEAM_ID env var not set on this deploy');
      return NextResponse.json({ error: 'aasa_not_configured' }, { status: 500 });
    }
    throw err;
  }
}
