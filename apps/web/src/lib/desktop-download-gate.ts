// story #4012(critical·prod 승격 준비, 페드루 PO 確定 2026-09-17) — `/desktop`
// 다운로드 화면은 Apple 공증(선생님 몫 ⑧, 2026-09-12 결정 기록: 「공증은 외부 배포
// 시점에」) 전까지 prod에서 열려서는 안 된다. 서버 측 판정 1개(process.env.DEPLOY_ENV,
// NEXT_PUBLIC_ 접두 없음 — 클라이언트 번들에 안 실린다)로 기본값은 prod-safe(꺼짐):
// cloudbuild.yaml의 `_DEPLOY_ENV` substitution 기본값이 이미 'dev'(dev 배포에서만 명시
// 'dev')와 같은 fail-closed 관례. `/desktop/updates/macos.json` 매니페스트 라우트
// (apps/web/src/app/desktop/updates/macos.json/route.ts, 인증 밖 별도 라우트 트리)는
// 이 판정과 무관 — 건드리지 않는다(AC2).
export function isDesktopDownloadEnabled(deployEnv: string | undefined): boolean {
  return deployEnv === 'dev';
}
