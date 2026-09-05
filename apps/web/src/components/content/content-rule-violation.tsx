import Link from 'next/link';

/**
 * story #3472 2부(BE 3471/#3825 계약, 유나 §16-7 정본 2026-09-05) — 초안 create/
 * update 응답과 상신 422 CONTENT_RULE_VIOLATION이 공유하는 shape. field는 소비
 * 화면의 실제 입력 필드 이름과 정확히 일치해야 한다(channel_post: text|link_url,
 * site_post: title|summary|body_md — story #3483, BE 필드별 lint 뒤).
 *
 * story #3483 — channel-posts 상세(3472 2부)에서 site-posts 상세(3483)로 재사용
 * 하기 위해 공용으로 뺀다(동작 무변, 중복 0). severity가 계약에 없는 것은 "알고
 * 줄인 것"(첫 슬라이스=기계 검사 전부 차단) — 문구 키를 …BlockedHint 꼴로 짓는다.
 */
export interface ContentRuleViolation {
  code: string;
  field: string;
  value: string;
  hint_key: string;
  settings_path: string;
}

// ⛔§16-7 "settings_path를 그대로 href로 쓰지 않는다" — FE가 아는 값만 라우트로
// 매핑하고, 모르는 값이면 링크를 그리지 않는다(경로 결정권을 BE로 넘기지 않는다).
export const KNOWN_CONTENT_RULES_SETTINGS_PATH = '/organization/content-rules';

// story #3472 2부(§16-7) — code로 사람 문구를 고른다(hint_key는 BE 계약에 있으나
// 값 자체가 아직 정해지지 않아 code를 1차 판정축으로 쓴다 — code는 그라운딩된 두
// 값(banned_term·utm_missing)이 확실하다). 미지 code는 지어내지 않고 제네릭으로.
export function contentRuleViolationHint(
  code: string,
  value: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (code === 'banned_term') return t('contentRuleBannedTermBlockedHint', { value });
  if (code === 'utm_missing') return t('contentRuleUtmMissingBlockedHint');
  return t('contentRuleGenericBlockedHint');
}

/**
 * story #3483 — "그 필드 아래" 목록(§16-7). 호출부가 `violations`를 이미 해당
 * field로 필터해 넘긴다(이 컴포넌트는 필터링을 모른다 — 어느 필드축이 있는지는
 * 소비 화면(channel_post: text/link_url, site_post: title/summary/body_md)마다
 * 달라 여기서 안 정한다).
 */
export function ContentRuleViolationList({
  violations, testId, t,
}: {
  violations: ContentRuleViolation[];
  testId: string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <>
      {violations.map((v, i) => (
        <p key={`${v.code}-${i}`} className="text-xs text-muted-foreground" data-testid={testId}>
          {contentRuleViolationHint(v.code, v.value, t)}{' '}
          {v.settings_path === KNOWN_CONTENT_RULES_SETTINGS_PATH ? (
            <Link href={v.settings_path} className="underline">{t('contentRuleLinkLabel')}</Link>
          ) : null}
        </p>
      ))}
    </>
  );
}

/** story #3483 — "그래서 못 한다"는 버튼 밖·비활성(§17-13과 같은 규율). */
export function ContentRuleSubmitBlockedReason({
  count, testId, t,
}: {
  count: number;
  testId: string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      {t('contentRuleSubmitBlockedHint', { count })}
    </p>
  );
}
