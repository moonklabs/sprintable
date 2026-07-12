import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TrustSeal, type TrustSealProps } from './trust-seal';

function render(props: TrustSealProps) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TrustSeal {...props} />
    </NextIntlClientProvider>,
  );
}

describe('TrustSeal (legacy icon — 하위호환, story-card.tsx has_evidence 호출부 무변경)', () => {
  it('renders the plain checkmark glyph when no variant is given (existing Board card call site)', () => {
    const markup = render({});
    expect(markup).toContain('svg');
    expect(markup).not.toContain('proof-amber');
    expect(markup).not.toContain('proof-green');
  });
});

describe('TrustSeal (claimed — Green 무결성 SOUL-LOCK, claimed-vs-verified-spec-handoff §1.3)', () => {
  it('never references any green token — agent 주장 단독은 Green이 될 수 없다', () => {
    const markup = render({ variant: 'claimed', agentInitial: '미' });
    expect(markup.toLowerCase()).not.toContain('proof-green');
    expect(markup.toLowerCase()).not.toContain('text-success');
  });

  it('renders the amber "주장" framing with a specific agent avatar when agentInitial is given', () => {
    const markup = render({ variant: 'claimed', agentInitial: '미' });
    expect(markup).toContain('proof-amber');
    expect(markup).toContain('에이전트 주장');
    expect(markup).toContain('인간 검증 대기');
    expect(markup).toContain('>미<');
  });

  it('falls back to a generic bot glyph when no specific agent identity is known (no-fiction — self_reported has no "who" signal)', () => {
    const markup = render({ variant: 'claimed' });
    expect(markup).toContain('svg'); // Bot icon
    expect(markup).toContain('에이전트 주장');
    expect(markup).not.toContain('undefined');
  });
});

describe('TrustSeal (verified — 인간 책임자 서명, spec §1.2)', () => {
  it('renders the green "검증" framing with human name + when + 책임 서명', () => {
    const markup = render({ variant: 'verified', humanName: '김민서', when: '2시간 전' });
    expect(markup).toContain('proof-green');
    expect(markup).toContain('김민서');
    expect(markup).toContain('2시간 전');
    expect(markup).toContain('책임 서명');
  });

  it('never falls back to the claimed amber framing when verified', () => {
    const markup = render({ variant: 'verified', humanName: '김민서', when: '2시간 전' });
    expect(markup).not.toContain('검증 대기');
    expect(markup.toLowerCase()).not.toContain('proof-amber');
  });
});
