/**
 * story #4320(유나 디자인 판정 · PO 2026-09-26) — BFF가 **스스로 만드는** 상류 오류 봉투(시간 초과 · 연결 불가 · 원 요청 취소)의 문장 한 곳.
 *
 * 왜: 이 봉투들은 백엔드 문장이 아니라 BFF가 지은 문장이라 BE i18n 카탈로그를 안 거친다 — 한국어로 박아 두면 게이트 상세 · 결재 요청
 * 카드 · 문서 게이트 레일 · 파일 뷰어가 `error.message`를 그대로 띄워 영어 로케일에도 한국어가 떴다(2982 · 3786 부류). 로케일은 앱이
 * 화면에 쓰는 것과 같은 해석(`getLocale` — 쿠키 → Accept-Language → 기본값) · 문장은 messages의 `bffEnvelope`.
 *
 * 받는 쪽이 없는 499(브라우저가 이미 떠남)도 같은 규칙 — 로그 · 계측에 남는 문장이 로케일마다 갈리지 않게.
 */
import { getLocale } from '@/i18n/request';
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from '@/i18n/locale-negotiation';
import { createTranslator } from 'next-intl';
import { apiError } from '@/lib/api-response';

export type BffEnvelopeCode = 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNREACHABLE' | 'CLIENT_CLOSED_REQUEST' | 'UPSTREAM_NON_JSON';

/** 코드 → messages `bffEnvelope` 키. 형은 `Record<string, string>` 그대로(i18n 키 가드가 이 모양의 표 값을 «읽힘»으로 센다 · 코드가 빠짐없이
 * 있는지는 테스트가 고정). */
const ENVELOPE_KEY: Record<string, string> = {
  UPSTREAM_TIMEOUT: 'upstreamTimeout',
  UPSTREAM_UNREACHABLE: 'upstreamUnreachable',
  CLIENT_CLOSED_REQUEST: 'clientClosedRequest',
  UPSTREAM_NON_JSON: 'upstreamNonJson',
};

/** 기본 status. 상류가 JSON이 아닌 오류 본문(CF HTML 오류 페이지 등)은 상류 status를 그대로(`status`로 넘긴다). */
const ENVELOPE_STATUS: Record<BffEnvelopeCode, number> = {
  UPSTREAM_TIMEOUT: 503,
  UPSTREAM_UNREACHABLE: 503,
  CLIENT_CLOSED_REQUEST: 499,
  UPSTREAM_NON_JSON: 502,
};

/** 요청 스코프 밖(쿠키 · 헤더를 못 읽는 자리)이면 기본 로케일. */
async function envelopeLocale(): Promise<SupportedLocale> {
  try {
    const locale = await getLocale();
    return isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export async function bffEnvelopeError(code: BffEnvelopeCode, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const locale = await envelopeLocale();
  const messages = (await import(`../../messages/${locale}.json`)).default;
  // next-intl의 요청 설정(getTranslations)을 안 거친다 — 요청 스코프 밖(직접 fetch를 쓰는 lib)에서도 돌고, 로케일은 위에서 이미 풀었다.
  const t = createTranslator({ locale, messages, namespace: 'bffEnvelope' });
  return apiError(code, t(ENVELOPE_KEY[code]), opts.status ?? ENVELOPE_STATUS[code], undefined, opts.headers);
}
