import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProofCapsule, type ProofCapsuleProps, type ProofState } from './proof-capsule';

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
    expect(gateButtonMatch![1]).toContain('rounded-[6px]');
  });
});
