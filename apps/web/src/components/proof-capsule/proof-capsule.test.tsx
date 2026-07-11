import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProofCapsule, type ProofCapsuleProps, type ProofState } from './proof-capsule';

function renderWithIntl(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

const BASE: ProofCapsuleProps = {
  proofState: 'green',
  stateLabel: '증명 완료',
  claim: '결제 복구 플로우 — 재시도 로직 구현 완료',
  human: { name: '윤재', role: '책임' },
  density: 'full',
};

const STATES: { state: ProofState; label: string }[] = [
  { state: 'blue', label: '실행 중' },
  { state: 'amber', label: '검증 대기' },
  { state: 'green', label: '증명 완료' },
  { state: 'red', label: '정책 위반' },
];

describe('ProofCapsule (density variants)', () => {
  it('renders the claim text in all four density variants', () => {
    for (const density of ['full', 'card', 'row', 'audit'] as const) {
      const markup = renderToStaticMarkup(<ProofCapsule {...BASE} density={density} />);
      expect(markup).toContain(BASE.claim);
    }
  });

  it('applies a clip-path cut-corner on full/card/row (not a plain rounded-full pill anywhere)', () => {
    for (const density of ['full', 'card', 'row'] as const) {
      const markup = renderToStaticMarkup(<ProofCapsule {...BASE} density={density} />);
      expect(markup).toContain('polygon(');
    }
  });
});

describe('ProofCapsule (4 proof states — 색만으로 의미 전달 금지, stateLabel 텍스트 항상 병기)', () => {
  for (const { state, label } of STATES) {
    it(`renders the "${label}" text alongside the ${state} state (not color-only)`, () => {
      const markup = renderToStaticMarkup(<ProofCapsule {...BASE} proofState={state} stateLabel={label} density="full" />);
      expect(markup).toContain(label);
    });
  }
});

describe('ProofCapsule (optional fields — evidence/gate/agent 없이도 정직하게 렌더)', () => {
  it('renders without evidence, gate, or agent fields present (no "undefined" leaking into markup)', () => {
    const markup = renderToStaticMarkup(<ProofCapsule {...BASE} density="full" />);
    expect(markup).not.toContain('undefined');
    expect(markup).not.toContain('Evidence');
    expect(markup).not.toContain('Human gate');
  });

  it('renders the agent avatar distinctly from the human avatar when an agent is present', () => {
    const markup = renderToStaticMarkup(
      <ProofCapsule {...BASE} agent={{ name: '미르코', initial: '미' }} density="full" />,
    );
    expect(markup).toContain('실행 미르코');
    expect(markup).toContain('책임 윤재');
  });

  it('renders evidence and gate sections only when those props are provided', () => {
    const markup = renderToStaticMarkup(
      <ProofCapsule
        {...BASE}
        evidence={{ acMet: 4, acTotal: 4, autoVerify: 'passed', diff: { add: 142, del: 18 } }}
        gate={{ risk: '낮음', action: 'Merge gate 열기' }}
        density="full"
      />,
    );
    expect(markup).toContain('AC 4/4');
    expect(markup).toContain('자동검증 passed');
    expect(markup).toContain('diff +142');
    expect(markup).toContain('Merge gate 열기');
  });
});

describe('ProofCapsule (안티패턴 자체 체크 — 도크트린 준수 회귀가드)', () => {
  it('never renders raw activity-log-style vocabulary or a KPI-style numeric-only summary', () => {
    const markup = renderToStaticMarkup(
      <ProofCapsule
        {...BASE}
        evidence={{ acMet: 4, acTotal: 4, proofCount: 3 }}
        density="full"
      />,
    );
    for (const forbidden of ['스파클', 'sparkle', 'KPI']) {
      expect(markup.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('does not use a fully-rounded (999px pill) shape for the gate action button (small circular status dots are fine, buttons are not)', () => {
    const markup = renderToStaticMarkup(
      <ProofCapsule {...BASE} gate={{ risk: '보통', action: '결재 →' }} density="row" />,
    );
    const gateButtonMatch = markup.match(/<a class="([^"]*)"/);
    expect(gateButtonMatch).not.toBeNull();
    expect(gateButtonMatch![1]).not.toContain('rounded-full');
    expect(gateButtonMatch![1]).toContain('rounded-[8px]');
  });

  it('supports a human/agent avatar + tone-varied gate button in row density (Attention Queue 재사용, 5f25c615)', () => {
    const markup = renderToStaticMarkup(
      <ProofCapsule
        {...BASE}
        density="row"
        agent={{ name: '미르코', initial: '미' }}
        gate={{ action: '병합', tone: 'ready' }}
      />,
    );
    expect(markup).toContain('병합');
    expect(markup).toContain('border-proof-green');
    expect(markup).not.toContain('위험도');
  });
});

describe('ProofCapsule (human optional — Board card 확산, bf9037cb) — 다중 담당자 등 human 필드로 표현 안 되는 실 기능을 위한 완화', () => {
  it('renders full/audit density without a human prop, omitting the human-dependent UI instead of crashing or leaking "undefined"', () => {
    for (const density of ['full', 'audit'] as const) {
      const { human: _human, ...withoutHuman } = BASE;
      const markup = renderToStaticMarkup(<ProofCapsule {...withoutHuman} density={density} />);
      expect(markup).not.toContain('undefined');
      expect(markup).not.toContain('책임');
    }
  });

  it('omits the Human gate section when gate is provided but human is not (도크트린⑤ — 책임자 없이 게이트 없음)', () => {
    const { human: _human, ...withoutHuman } = BASE;
    const markup = renderToStaticMarkup(
      <ProofCapsule {...withoutHuman} gate={{ risk: '낮음', action: 'Merge gate 열기' }} density="full" />,
    );
    expect(markup).not.toContain('Human gate');
    expect(markup).not.toContain('Merge gate 열기');
  });
});

describe('ProofCapsule (footer slot — card density, Board card 확산 실기능 이관)', () => {
  it('renders arbitrary footer content below the claim/evidence in card density', () => {
    const markup = renderToStaticMarkup(
      <ProofCapsule
        {...BASE}
        density="card"
        footer={<span data-testid="board-footer-marker">보드 카드 실기능 마커</span>}
      />,
    );
    expect(markup).toContain('보드 카드 실기능 마커');
  });

  it('ignores the footer prop on non-card densities (no accidental leak)', () => {
    for (const density of ['full', 'row', 'audit'] as const) {
      const markup = renderToStaticMarkup(
        <ProofCapsule {...BASE} density={density} footer={<span>카드 전용 마커</span>} />,
      );
      expect(markup).not.toContain('카드 전용 마커');
    }
  });
});

describe('ProofCapsule (trustSeal slot — claimed-vs-verified-spec-handoff, full 밀도 전용, 시각 스캐폴딩)', () => {
  it('renders the claimed strip (amber, agent subject) when trustSeal.variant is "claimed"', () => {
    const markup = renderWithIntl(
      <ProofCapsule
        {...BASE}
        proofState="amber"
        stateLabel="주장됨"
        density="full"
        trustSeal={{ variant: 'claimed', agentName: '미르코', agentInitial: '미' }}
      />,
    );
    expect(markup).toContain('주장됨');
    expect(markup).toContain('에이전트 주장');
    expect(markup).toContain('검증 대기');
  });

  it('renders the verified strip (green, human subject) when trustSeal.variant is "verified"', () => {
    const markup = renderWithIntl(
      <ProofCapsule
        {...BASE}
        proofState="green"
        stateLabel="검증됨"
        density="full"
        trustSeal={{ variant: 'verified', humanName: '김민서', when: '2시간 전' }}
      />,
    );
    expect(markup).toContain('검증됨');
    expect(markup).toContain('김민서');
    expect(markup).toContain('책임 서명');
  });

  it('Green 무결성 SOUL-LOCK — claimed trustSeal composed into ProofCapsule never leaks a green token', () => {
    const markup = renderWithIntl(
      <ProofCapsule
        {...BASE}
        proofState="amber"
        stateLabel="주장됨"
        density="full"
        trustSeal={{ variant: 'claimed', agentName: '미르코', agentInitial: '미' }}
      />,
    );
    expect(markup.toLowerCase()).not.toContain('proof-green');
  });

  it('omits the trustSeal block entirely when not provided (무증거=무표시, 기존 호출부 무변경)', () => {
    const markup = renderWithIntl(<ProofCapsule {...BASE} density="full" />);
    expect(markup).not.toContain('책임 서명');
    expect(markup).not.toContain('검증 대기');
  });
});
