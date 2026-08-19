/**
 * 사업자정보 — 앱 內 단일 정본(SSOT).
 *
 * 전자상거래법 제10조(사업자의 신원·거래조건 표시 의무)에 따라 앱 안에서 확인 가능해야 하는
 * 사업자정보 6종. 값은 사업자등록증과 동일하게 기재하며, 마케팅 랜딩(sprintable-landing
 * 레포) 푸터 값(story #2740 정본 절)과 글자 단위로 일치한다.
 *
 * 앱(apps/web) 안에서는 이 파일이 유일한 정의다 — 어느 표면에서도 값을 다시 적지 않고
 * 여기서만 가져와 렌더한다(값 사본 이중화 금지, story #2741).
 *
 * ⚠️ 토스페이먼츠 심사 기간 중 수정 금지 항목.
 */
export const BUSINESS_INFO = {
  /** 상호 */
  companyName: '주식회사 뭉클랩',
  /** 대표이사 */
  ceo: '윤도선',
  /** 사업자등록번호 */
  registrationNumber: '488-88-02579',
  /** 사업장 소재지 */
  address: '경기도 고양시 일산동구 무궁화로 20-38, 5층 502호',
  /** 유선번호 */
  phone: '070-8098-5775',
  /** 통신판매업 신고번호 */
  mailOrderNumber: '제2023-고양일산동-1337호',
} as const;

/**
 * 법적 문서 렌더 경로. 기존 legal 라우트를 재사용한다 — 별도 사본 페이지를 만들지 않는다
 * (story #2741 AC4). 목적지 페이지는 GET /api/v2/legal/{type}에서 실 콘텐츠를 받는다
 * (lib/legal-docs.ts).
 */
export const LEGAL_DOC_ROUTES = {
  terms: '/terms',
  privacy: '/privacy',
  refundPolicy: '/refund-policy',
} as const;
