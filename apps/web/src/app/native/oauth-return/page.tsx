// [P1 인시던트] AASA 미서빙으로 유니버설 링크 복귀가 실패하면 인앱 브라우저가 이 경로를 직접
// 로드한다 — 그 경우에도 raw 404는 안 된다(PO 지시). custom scheme 폴백은 별건 HOLD 스토리
// (E-MOBILE OAuth 복귀 App Link 단일 의존 제거)라 여기서 자동 리다이렉트를 시도하지 않는다 —
// 로그인 자체는 이미 끝났다는 것만 알리고 사용자가 직접 앱으로 돌아가게 안내한다.
export const metadata = { title: 'Sprintable' };

export default function NativeOauthReturnPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="max-w-sm rounded-2xl bg-background p-8 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-foreground">로그인이 완료됐습니다</h1>
        <p className="text-sm text-muted-foreground">
          이 화면은 닫으시고 Sprintable 앱으로 돌아가 주세요.
        </p>
      </div>
    </div>
  );
}
