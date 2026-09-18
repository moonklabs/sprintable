// story #4012(critical·prod 승격 준비, 페드루 PO 確定 2026-09-17 · CHANGES 2026-09-17) —
// `/desktop` 다운로드 화면은 Apple 공증(선생님 몫 ⑧, 2026-09-12 결정 기록: 「공증은
// 외부 배포 시점에」) 전까지 prod에서 열려서는 안 된다. 서버 측 판정 1개
// (process.env.DESKTOP_DOWNLOAD_ENABLED, NEXT_PUBLIC_ 접두 없음 — 클라이언트 번들에
// 안 실린다). 전용 키(당초 DEPLOY_ENV==='dev' 비교였으나 PO CHANGES — 배포 환경
// 이름 비교면 공증 완료 뒤 prod에서 켜려면 코드를 고쳐 재배포해야 해서, AC1이 요구하는
// "설정으로 켜고 끄는 스위치"가 아니었다). cloudbuild.yaml이 dev 분기에서만 이 키를
// `true`로 붙인다(prod는 아예 안 실어 미설정=꺼짐) — 값이 정확히 "true"일 때만 켜진다.
// `/desktop/updates/macos.json` 매니페스트 라우트(apps/web/src/app/desktop/updates/
// macos.json/route.ts, 인증 밖 별도 라우트 트리)는 이 판정과 무관 — 건드리지 않는다(AC2).
export function isDesktopDownloadEnabled(desktopDownloadEnabled: string | undefined): boolean {
  return desktopDownloadEnabled === 'true';
}
