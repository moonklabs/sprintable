/**
 * story #2606 — 공개 법적 문서(약관/개인정보처리방침/환불정책) 서버사이드 fetch.
 *
 * 무인증 공개 엔드포인트(GET /api/v2/legal/{doc_type})라 fastapi-proxy.ts의 쿠키/Bearer
 * forwarding 로직이 불필요 — Server Component에서 직접 fetch한다(SSR로 크롤러/심사자에게
 * 실 콘텐츠가 초기 HTML에 실리게, 클라이언트 useEffect 로딩 상태로 감추지 않는다).
 */

export type LegalDocType = 'terms' | 'privacy' | 'refund_policy';

export interface LegalDocument {
  docType: LegalDocType;
  locale: string;
  content: string;
  contentFormat: 'markdown' | 'html';
  effectiveFrom: string;
}

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** 미발행(404) 또는 조회 실패 시 null — 페이지가 "준비 중" 상태를 렌더한다(placeholder 지어내지 않음). */
export async function getCurrentLegalDocument(
  docType: LegalDocType,
  locale: string = 'ko',
): Promise<LegalDocument | null> {
  try {
    const res = await fetch(
      `${FASTAPI_URL()}/api/v2/legal/${docType}?locale=${locale}`,
      { next: { revalidate: 300 } }, // 5분 캐시 — admin 개정 후 최대 5분 내 반영, 매 요청 백엔드 왕복 방지.
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      docType,
      locale: data.locale,
      content: data.content,
      contentFormat: data.content_format,
      effectiveFrom: data.effective_from,
    };
  } catch {
    return null;
  }
}
