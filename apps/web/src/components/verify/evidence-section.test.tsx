import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EvidenceSection, isLinkableRef } from './evidence-section';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('isLinkableRef', () => {
  it('treats http/https refs as linkable', () => {
    expect(isLinkableRef('https://github.com/moonklabs/sprintable/pull/1985')).toBe(true);
    expect(isLinkableRef('http://example.com')).toBe(true);
  });

  it('treats non-URL refs (e.g. a metric description) as non-linkable', () => {
    expect(isLinkableRef('conversion rate +4.2%')).toBe(false);
    expect(isLinkableRef('run-abc123-00208')).toBe(false);
  });
});

describe('EvidenceSection (SSR snapshot — §7 상태 매트릭스)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when hasEvidence is null (증거 0 = 행 미렌더, "증명 안 됨" 표기 금지)', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" hasEvidence={null} />),
    );
    expect(markup).toBe('');
  });

  it('renders nothing when hasEvidence is undefined (BE가 필드 자체를 안 내려도 안전한 폴백)', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" hasEvidence={undefined} />),
    );
    expect(markup).toBe('');
  });

  it('renders the collapsed trust row when hasEvidence is true, without fetching evidence eagerly', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" hasEvidence={true} />),
    );
    expect(markup).toContain('증명된 완결');
    expect(markup).toContain('근거 보기');
    // 디디 BE 가이드: "근거 보기" 클릭 전엔 evidence 리스트를 부르지 않는다(카드마다 N+1 방지).
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
