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

  // story #3099(DS·AA 후속, #3090과 동형) — "검증 대기" 라벨(10.5px bold)이 라이트에서
  // proof-amber AA 미달(3.64)이라 text-proof-ink로 중립화. amber 토큰 자체를 더는 참조하지
  // 않는다(별도 dot 없는 자리라 텍스트만 — SOUL-LOCK인 "green 미참조"는 무변경).
  it('renders the neutral(ink) "주장" framing with a specific agent avatar when agentInitial is given', () => {
    const markup = render({ variant: 'claimed', agentInitial: '미' });
    expect(markup).toContain('text-proof-ink');
    expect(markup).not.toContain('proof-amber');
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

  // story #3054(2984-S6) — 컨테이너 재질이 헤어라인+엠보스 inset(VerificationStamp 재질
  // 언어)을 쓰고 bg-proof-amber-soft 채움은 안 쓴다. Green 무결성 SOUL-LOCK은 위 테스트로
  // 이미 고정 — 여기선 material만 본다.
  it('story #3054 — 헤어라인+엠보스 inset을 쓰고 bg-proof-amber-soft는 안 쓴다', () => {
    const markup = render({ variant: 'claimed', agentInitial: '미' });
    expect(markup).toContain('border-proof-line');
    expect(markup).toContain('shadow-[var(--elev-inset)]');
    expect(markup).not.toContain('bg-proof-amber-soft');
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
