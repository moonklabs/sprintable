// @vitest-environment jsdom
//
// story #3483 — content-rule-violation.tsx가 channel-posts 상세(3472 2부)에서
// 빠져나온 공용 컴포넌트라 이 파일이 회귀 0의 유일한 pin이다(소비 화면 각각의
// 테스트는 여전히 배선만 검증한다).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ContentRuleViolationList, ContentRuleSubmitBlockedReason,
  contentRuleViolationHint, KNOWN_CONTENT_RULES_SETTINGS_PATH,
  type ContentRuleViolation,
} from './content-rule-violation';

const MESSAGES: Record<string, string> = {
  contentRuleBannedTermBlockedHint: '「{value}」은 쓸 수 없습니다.',
  contentRuleUtmMissingBlockedHint: '링크에 UTM 3종이 있어야 합니다.',
  contentRuleGenericBlockedHint: '이 값은 콘텐츠 규칙에 맞지 않습니다.',
  contentRuleSubmitBlockedHint: '규칙 위반 {count}건을 고쳐야 상신할 수 있습니다.',
  contentRuleLinkLabel: '콘텐츠 규칙',
};

function t(key: string, values?: Record<string, string | number>): string {
  let s = MESSAGES[key] ?? key;
  if (values) for (const [k, v] of Object.entries(values)) s = s.replace(`{${k}}`, String(v));
  return s;
}

function violation(overrides: Partial<ContentRuleViolation> = {}): ContentRuleViolation {
  return {
    code: 'banned_term', field: 'text', value: '무료체험', hint_key: 'content_rules.banned_term',
    settings_path: KNOWN_CONTENT_RULES_SETTINGS_PATH, ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

describe('contentRuleViolationHint', () => {
  it('banned_term — 걸린 낱말을 문구에 보간한다', () => {
    expect(contentRuleViolationHint('banned_term', '무료체험', t)).toBe('「무료체험」은 쓸 수 없습니다.');
  });
  it('utm_missing — 고정 문구(값 보간 없음)', () => {
    expect(contentRuleViolationHint('utm_missing', '', t)).toBe('링크에 UTM 3종이 있어야 합니다.');
  });
  it('⭐미지 code — 지어내지 않고 제네릭 폴백', () => {
    expect(contentRuleViolationHint('unknown_future_code', 'x', t)).toBe('이 값은 콘텐츠 규칙에 맞지 않습니다.');
  });
});

describe('ContentRuleViolationList', () => {
  it('빈 배열 — 아무것도 안 그린다', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => { root.render(<ContentRuleViolationList violations={[]} testId="x" t={t} />); });
    expect(container.querySelectorAll('[data-testid="x"]')).toHaveLength(0);
    act(() => { root.unmount(); });
  });

  it('⭐settings_path가 FE-known 값이면 「콘텐츠 규칙」 링크를 함께 그린다', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => { root.render(<ContentRuleViolationList violations={[violation()]} testId="x" t={t} />); });
    const el = container.querySelector('[data-testid="x"]');
    expect(el?.textContent).toBe('「무료체험」은 쓸 수 없습니다. 콘텐츠 규칙');
    expect(el?.querySelector('a')?.getAttribute('href')).toBe(KNOWN_CONTENT_RULES_SETTINGS_PATH);
    act(() => { root.unmount(); });
  });

  it('⭐settings_path가 미지 값이면 링크를 안 그린다(경로 결정권을 BE로 안 넘김)', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => { root.render(<ContentRuleViolationList violations={[violation({ settings_path: '/some/other/path' })]} testId="x" t={t} />); });
    expect(container.querySelector('[data-testid="x"] a')).toBeNull();
    act(() => { root.unmount(); });
  });

  it('여러 건 — 각각 별도 줄로 전부 그린다', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => {
      root.render(<ContentRuleViolationList
        violations={[violation({ value: 'a' }), violation({ value: 'b', code: 'utm_missing' })]}
        testId="x" t={t}
      />);
    });
    expect(container.querySelectorAll('[data-testid="x"]')).toHaveLength(2);
    act(() => { root.unmount(); });
  });
});

describe('ContentRuleSubmitBlockedReason', () => {
  it('개수를 문구에 보간한다', () => {
    container = document.createElement('div');
    root = createRoot(container);
    act(() => { root.render(<ContentRuleSubmitBlockedReason count={3} testId="x" t={t} />); });
    expect(container.querySelector('[data-testid="x"]')?.textContent).toBe('규칙 위반 3건을 고쳐야 상신할 수 있습니다.');
    act(() => { root.unmount(); });
  });
});
