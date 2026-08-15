// story #2092(P0) — 조직 삭제 다이얼로그의 "지금 진행해도 되는가" 판정을 순수함수로 뽑는다.
// 이전엔 이 판정이 JSX의 disabled= 표현식 안에 직접 있어 테스트 대상이 될 수 없었다
// (전체 페이지를 렌더해야만 검증 가능·컨텍스트 의존 과다) — 회귀가 나도 잡을 방법이
// 없었다는 뜻. page.tsx가 아닌 별도 파일인 이유: Next.js Page 모듈은 default export 외의
// named export를 "유효한 Page export field"로 인정하지 않아 빌드 타입체크가 거부한다.
//
// 서버(#2898)가 최종 방어선이라는 점은 그대로다 — 이 함수는 "안내"쪽(AC2/AC3)만 담당한다.
export function canSubmitOrgDelete(input: {
  orgName: string;
  confirmName: string;
  deletingOrg: boolean;
  orgImpactLoading: boolean;
  hasActiveSubscription: boolean;
  orgImpactFailed: boolean;
  confirmWithoutImpact: boolean;
}): boolean {
  if (input.confirmName !== input.orgName) return false;
  if (input.deletingOrg || input.orgImpactLoading) return false;
  if (input.hasActiveSubscription) return false;
  // AC2/AC3 — 영향도 조회가 실패한 채면 사용자가 명시로 인정(체크박스)하기 전엔 막는다.
  if (input.orgImpactFailed && !input.confirmWithoutImpact) return false;
  return true;
}
