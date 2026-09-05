import { describe, expect, it } from 'vitest';
import { extractHits } from './verify-no-date-tolocalestring-marketing-surface';

describe('extractHits — 순수 판정 함수(story #3486 재발 가드)', () => {
  it('⭐#3486 실사고 픽스처 — 고치기 前 channels/page.tsx 원문을 그대로 잡는다', () => {
    const hits = extractHits(
      "{t('channelConnectedBy', { time: new Date(conn.created_at).toLocaleString() })}",
      'app/(authenticated)/organization/channels/page.tsx',
    );
    expect(hits).toEqual([{ file: 'app/(authenticated)/organization/channels/page.tsx', line: 1 }]);
  });

  it('toLocaleDateString·toLocaleTimeString도 잡는다', () => {
    expect(extractHits('new Date(x).toLocaleDateString()', 'f.tsx')).toHaveLength(1);
    expect(extractHits('new Date(x).toLocaleTimeString()', 'f.tsx')).toHaveLength(1);
  });

  it('formatRelativeTime로 고친 뒤에는 안 잡는다(회귀 0)', () => {
    const hits = extractHits(
      "{t('channelConnectedBy', { time: formatRelativeTime(conn.created_at, locale, displayTimezone) })}",
      'app/(authenticated)/organization/channels/page.tsx',
    );
    expect(hits).toEqual([]);
  });

  it('여러 줄에 걸쳐 있으면 줄 번호를 정확히 낸다', () => {
    const content = [
      'const a = 1;',
      'const b = new Date(x).toLocaleString();',
      'const c = 2;',
    ].join('\n');
    expect(extractHits(content, 'f.tsx')).toEqual([{ file: 'f.tsx', line: 2 }]);
  });
});
