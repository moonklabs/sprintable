// story #3118(Sign in with Apple) — PO 전언(페드루, 민 그라운딩 축): scope에 name/email이
// 있는 Apple 콜백은 GET 리다이렉트가 아니라 cross-site POST(response_mode=form_post)로
// 온다. SameSite=Lax 쿠키는 cross-site *POST*엔 안 실린다(Lax는 top-level GET 네비게이션만
// 봐준다) — 이 oauth_* 단명 쿠키들이 Lax로 남아있으면 Apple 콜백에서 state 검증이 "쿠키가
// 아예 안 옴"으로 매번 헛실패한다(잘 알려진 함정 클래스). Apple만 SameSite=None(+Secure
// 필수 — 브라우저가 None을 Secure 없이 거부)으로 쓴다. Google은 GET 리다이렉트라 Lax로
// 충분 — 그대로 둔다(불필요하게 None으로 넓히지 않는다, 최소 권한).
//
// story #3122(계정 연결) — 로그인 rail(auth/login/route.ts)과 link rail(auth/link/route.ts)
// 둘 다 같은 함정을 겪는다(Apple form_post는 어느 쪽이든 cross-site POST). route.ts는
// GET/POST 외의 임의 named export를 Next App Router 빌드가 라우트 핸들러로 오인해 거부할
// 수 있어(경로 규칙) 여기 lib로 분리해 두 route.ts가 공유한다 — 복붙 두 벌을 두면 한쪽만
// 고치고 잊는 사고가 나기 쉽다(SameSite 실수는 반나절 삽질급 함정이라고 페드루가 직접 경고).
export function oauthCookieOptions(provider: string) {
  if (provider === 'apple') {
    return { httpOnly: true, secure: true, sameSite: 'none' as const, maxAge: 300, path: '/' };
  }
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 300, path: '/' };
}
