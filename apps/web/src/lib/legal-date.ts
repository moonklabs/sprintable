// story #4443 PR3a (PO 01:11Z) — a legal document's «시행일». `effective_from` is the moment that version takes effect (a moment is
// right: other logic may use it as one); read as a date it is the date of the law that set it. 약관 · 개인정보처리방침 · 환불정책 are
// written under Korean law by a company in Korea, so the date is Korea's — the same text for every reader, wherever they are
// (no time, no offset). Was: the server render's zone (UTC) with an offset label («08-31 15:00 GMT» for a Seoul-midnight start).
export const LEGAL_TIME_ZONE = 'Asia/Seoul';

/** «2026년 9월 1일» (ko) · «September 1, 2026» (en) — the legal date of `iso` in LEGAL_TIME_ZONE; '' for a value that is not a date. */
export function formatLegalDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { timeZone: LEGAL_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}
