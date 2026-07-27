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

describe('EvidenceSection (SSR snapshot — §7 상태 매트릭스 + P0-04 Claimed-vs-Verified)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when selfReported is null (증거 0 = 행 미렌더, "증명 안 됨" 표기 금지)', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" selfReported={null} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />),
    );
    expect(markup).toBe('');
  });

  it('renders nothing when all fields are undefined (BE가 필드 자체를 안 내려도 안전한 폴백)', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" selfReported={undefined} humanVerified={undefined} humanVerifiedBy={undefined} humanVerifiedAt={undefined} />),
    );
    expect(markup).toBe('');
  });

  it('renders the amber "claimed" row when self_reported is true but human_verified is not, without fetching evidence eagerly', () => {
    const markup = renderToStaticMarkup(
      wrap(<EvidenceSection workItemId="s1" workItemType="story" selfReported={true} humanVerified={null} humanVerifiedBy={null} humanVerifiedAt={null} />),
    );
    expect(markup).toContain('에이전트 주장');
    expect(markup).toContain('text-warning');
    expect(markup).not.toContain('text-success');
    expect(markup).toContain('근거 보기');
    // 디디 BE 가이드: "근거 보기" 클릭 전엔 evidence 리스트를 부르지 않는다(카드마다 N+1 방지).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders the green "verified" row with the resolved human name when human_verified is true (거짓 green→amber 정정의 반대편 — 실제로 검증된 건 정확히 green)', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <EvidenceSection
          workItemId="s1"
          workItemType="story"
          selfReported={true}
          humanVerified={true}
          humanVerifiedBy="member-1"
          humanVerifiedAt="2026-07-11T00:00:00Z"
          memberMap={{ 'member-1': { name: '김민서' } }}
        />,
      ),
    );
    expect(markup).toContain('김민서');
    expect(markup).toContain('text-success');
    expect(markup).not.toContain('에이전트 주장');
  });

  it('falls back to a short id + generic label when the verifier is not in memberMap (no-fiction — never invents a name)', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <EvidenceSection
          workItemId="s1"
          workItemType="story"
          selfReported={true}
          humanVerified={true}
          humanVerifiedBy="deadbeef-0000-0000-0000-000000000000"
          humanVerifiedAt="2026-07-11T00:00:00Z"
          memberMap={{}}
        />,
      ),
    );
    expect(markup).toContain('deadbe');
    expect(markup).not.toContain('undefined');
  });
});
