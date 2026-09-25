import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { storageSummaryText } from './storage-view';

// story #4302(유나 판정) — 스토리지 상단 뱃지: 자산을 커서로 나눠 받으므로 수 · 용량 둘 다 불러온 것의 합. 더 남았으면 둘 다 `+`.
const GB = 1.2 * 1024 ** 3;
function render(locale: 'ko' | 'en', count: number, bytes: number, hasMore: boolean): string {
  const t = createTranslator({ locale, messages: locale === 'ko' ? koMessages : enMessages, namespace: 'storage' });
  return storageSummaryText(t, count, bytes, hasMore);
}

describe('storageSummaryText', () => {
  it('⭐더 남았으면 수 · 용량 둘 다 `+` — ko «48+개 자산 · … GB+» · en «48+ assets · … GB+»', () => {
    const ko = render('ko', 48, GB, true);
    expect(ko).toMatch(/^48\+개 자산 · .+\+$/);
    const en = render('en', 48, GB, true);
    expect(en).toMatch(/^48\+ assets · .+\+$/);
  });
  it('다 불러왔으면 맨 수 · 맨 용량(`+` 없음) · en 복수형 그대로', () => {
    expect(render('ko', 48, GB, false)).not.toContain('+');
    expect(render('en', 1, 10, false)).toMatch(/^1 asset · /);
    expect(render('en', 1, 10, true)).toMatch(/^1\+ asset · .+\+$/);
  });
});
