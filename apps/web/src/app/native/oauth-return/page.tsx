'use client';

// [P1 인시던트→P1 후속] AASA 미서빙으로 유니버설 링크 복귀가 실패하면(또는 iOS 17.4 미만 —
// ASWebAuthenticationSession의 https 콜백 인식 자체가 그 미만에서 성립하지 않는다, App.js
// supportsUniversalLinkCallback 참조) 인앱 시트가 이 경로를 직접 로드한다.
//
// 이 페이지가 실제로 렌더된다는 것 자체가 이미 "17.4+ https 자동 복귀"가 아닌 경로라는 뜻이다
// — 17.4+ 기기는 OS가 유니버설 링크를 세션 안에서 가로채 이 페이지가 로드되기 전에 시트를
// 닫는다. 그래서 모드 감지 로직은 불요: 여기 도달했으면 항상 custom scheme(ai.sprintable)
// 폴백 대상이다(선생님 직권 확定+산티아고 사후 조건부 허용, 2026-08-26).
//
// ⛔산티아고 조건: custom scheme 홉은 **사용자 탭(명시적 상호작용)** 없이 자동 발동 금지 —
// intent-squatting 공격면 완화 조건 중 하나(계약 doc 5e2964d6 재검토). 자동 location.replace
// 금지, 버튼 탭에서만 이동한다. scheme·path는 App.js OAUTH_RETURN_SCHEME_URL과 byte-exact
// (`ai.sprintable:/oauth-return` — 단일 슬래시).
import { useSearchParams } from 'next/navigation';

const OAUTH_RETURN_SCHEME_URL = 'ai.sprintable:/oauth-return';

export default function NativeOauthReturnPage() {
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const appReturnUrl = query ? `${OAUTH_RETURN_SCHEME_URL}?${query}` : OAUTH_RETURN_SCHEME_URL;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="max-w-sm rounded-2xl bg-background p-8 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-foreground">로그인이 완료됐습니다</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          아래 버튼을 눌러 Sprintable 앱으로 돌아가 주세요.
        </p>
        <a
          href={appReturnUrl}
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90"
        >
          Sprintable 앱으로 돌아가기
        </a>
      </div>
    </div>
  );
}
