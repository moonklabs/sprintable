import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ProofCapsule, type ProofCapsuleProps, type ProofState } from './proof-capsule';

function renderWithIntl(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

function renderWithIntlEn(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
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
      const markup = renderWithIntl(<ProofCapsule {...BASE} density={density} />);
      expect(markup).toContain(BASE.claim);
    }
  });

  it('applies a clip-path cut-corner on full/card/row (not a plain rounded-full pill anywhere)', () => {
    // story #2955 §5 — clip-path 지오메트리 계산이 인라인 style에서 globals.css의 `.proof-cut`
    // 단일 정본으로 이관됐다(CutCornerShell). 렌더 마크업엔 이제 'polygon(' 리터럴이 없다
    // (외부 스타일시트가 그 값을 갖는다) — 클래스명으로 컷코너 적용 자체를 검증한다.
    for (const density of ['full', 'card', 'row'] as const) {
      const markup = renderWithIntl(<ProofCapsule {...BASE} density={density} />);
      expect(markup).toContain('proof-cut');
    }
  });

  it('regression #2978 — CutCornerShell never compresses below content height in a vertical flex chain (shrink-0 alongside overflow-hidden)', () => {
    // 선생님 실사용 발견 — /gates/[id] 상세가 overflow-y-auto 조상 안에서 뷰포트가 좁으면
    // 스크롤이 원천 봉쇄됐다. 원인: overflow-hidden인 flex item의 CSS 스펙상 automatic
    // minimum size가 0이라, shrink-0 없이는 셸이 내용 실제 높이보다 찌그러들며 잘림을
    // overflow-hidden이 감춰 조상 스크롤러가 넘침을 못 본다.
    // ⚠️row/audit 밀도는 셸 내부 아이콘 span 등에 무관한 shrink-0가 이미 있어 단순
    // `.toContain('shrink-0')`는 이 fix와 무관하게도 통과하는 약한 assert가 된다 — 반드시
    // CutCornerShell 자신의 리터럴 클래스 조합("proof-cut flex shrink-0")으로 특정한다
    // (mutation-검증: shrink-0 제거 시 이 assert만 RED, 위 span들은 무관).
    for (const density of ['full', 'card', 'row'] as const) {
      const markup = renderWithIntl(<ProofCapsule {...BASE} density={density} />);
      expect(markup).toContain('proof-cut flex shrink-0');
    }
  });
});

describe('ProofCapsule (4 proof states — 색만으로 의미 전달 금지, stateLabel 텍스트 항상 병기)', () => {
  for (const { state, label } of STATES) {
    it(`renders the "${label}" text alongside the ${state} state (not color-only)`, () => {
      const markup = renderWithIntl(<ProofCapsule {...BASE} proofState={state} stateLabel={label} density="full" />);
      expect(markup).toContain(label);
    });
  }
});

describe('ProofCapsule (optional fields — evidence/gate/agent 없이도 정직하게 렌더)', () => {
  it('renders without evidence, gate, or agent fields present (no "undefined" leaking into markup)', () => {
    const markup = renderWithIntl(<ProofCapsule {...BASE} density="full" />);
    expect(markup).not.toContain('undefined');
    expect(markup).not.toContain('Evidence');
    expect(markup).not.toContain('Human gate');
  });

  it('renders the agent avatar distinctly from the human avatar when an agent is present', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} agent={{ name: '미르코', initial: '미' }} density="full" />,
    );
    expect(markup).toContain('실행 미르코');
    expect(markup).toContain('책임 윤재');
  });

  it('renders evidence and gate sections only when those props are provided', () => {
    const markup = renderWithIntl(
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
    const markup = renderWithIntl(
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
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} gate={{ risk: '보통', action: '결재 →' }} density="row" />,
    );
    const gateButtonMatch = markup.match(/<a class="([^"]*)"/);
    expect(gateButtonMatch).not.toBeNull();
    expect(gateButtonMatch![1]).not.toContain('rounded-full');
    expect(gateButtonMatch![1]).toContain('rounded-[8px]');
  });

  it('supports a human/agent avatar + tone-varied gate button in row density (Attention Queue 재사용, 5f25c615)', () => {
    const markup = renderWithIntl(
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

  it('story #2249 — row density renders a pre-formatted duration badge when given one', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="row" gate={{ action: '조율' }} duration="3일 전" />,
    );
    expect(markup).toContain('3일 전');
  });

  it('story #2249 — row density renders no duration badge when duration is omitted(모름, 지어내지 않음)', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="row" gate={{ action: '조율' }} />,
    );
    expect(markup).not.toContain('일 전');
    expect(markup).not.toContain('시간 전');
  });

  // story #2923(P0-E AQ2, Yuna 확定 2026-08-22) — 개입유형(GATE/STEER/BLOCK/Q) compact 배지.
  // 「색은 신뢰상태 축 하나(레일/점)뿐」 — 이 배지는 무채(색 클래스 0)로만 렌더돼야 한다.
  it('row density renders the typeBadge text with monochrome classes (bg-proof-sunk/text-proof-ink-2 — no proofState color)', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="row" gate={{ action: '결재' }} typeBadge="GATE" />,
    );
    // 배지 자체의 스타일 클래스가 무채(proof-sunk/ink-2)인지 — 이 두 클래스는 이 컴포넌트
    // 어디에도 상태색(blue/green/amber/red) 용도로 안 쓰인다(proof-capsule.tsx 실측).
    expect(markup).toContain('GATE');
    expect(markup).toContain('bg-proof-sunk');
    expect(markup).toContain('text-proof-ink-2');
  });

  it('row density renders no typeBadge element when omitted (다른 밀도 호출부·전 F1~F3는 이 prop 자체를 안 준다, 무변화)', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="row" gate={{ action: '결재' }} />,
    );
    expect(markup).not.toContain('GATE');
    expect(markup).not.toContain('STEER');
  });

  it('typeBadge는 row 밀도 전용 — full/card/audit에는 안 새어나간다(스코프 밖 밀도 무누출)', () => {
    for (const density of ['full', 'card', 'audit'] as const) {
      const markup = renderWithIntl(<ProofCapsule {...BASE} density={density} typeBadge="GATE" />);
      expect(markup).not.toContain('>GATE<');
    }
  });

  // story P0-02(유나 full 검산, PR#3368 2026-08-22) — full 밀도 eyebrow 라벨(evidence/gate/claim
  // 3곳)+audit 밀도 mono 타임스탬프가 전부 --proof-panel 배경 위 text-proof-faint였다. 수동
  // WCAG 계산(python, 이 PR): light 2.72·dark 2.84(둘 다 AA 4.5 미달) → text-proof-ink-3(light
  // 5.92·dark 5.43, 둘 다 통과). proof-* 페어링은 자동 tint-contrast 가드 대상 밖(NON_STATUS_
  // FAMILY_NAMES 제외)이라 이 회귀가드가 유일한 고정점.
  it('full 밀도 eyebrow 라벨(evidence/gate/claim)이 text-proof-faint 대신 text-proof-ink-3를 쓴다(AA 대비)', () => {
    const markup = renderWithIntl(
      <ProofCapsule
        {...BASE}
        density="full"
        evidence={{ acMet: 1, acTotal: 1 }}
        gate={{ risk: '낮음', action: '결재' }}
        human={{ name: '유나', role: '' }}
      />,
    );
    expect(markup).not.toContain('text-proof-faint');
    // eyebrow 3곳(evidence.label/gate.label/claim.label) 전부 ink-3 — 최소 3회 등장 확인.
    expect((markup.match(/text-proof-ink-3/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('audit 밀도 타임스탬프(now+actorName)도 text-proof-faint 대신 text-proof-ink-3를 쓴다(같은 AA 처방)', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="audit" now="3일 전" human={{ name: '유나', role: '' }} />,
    );
    expect(markup).not.toContain('text-proof-faint');
    expect(markup).toContain('text-proof-ink-3');
  });
});

describe('ProofCapsule (human optional — Board card 확산, bf9037cb) — 다중 담당자 등 human 필드로 표현 안 되는 실 기능을 위한 완화', () => {
  it('renders full/audit density without a human prop, omitting the human-dependent UI instead of crashing or leaking "undefined"', () => {
    for (const density of ['full', 'audit'] as const) {
      const { human: _human, ...withoutHuman } = BASE;
      const markup = renderWithIntl(<ProofCapsule {...withoutHuman} density={density} />);
      expect(markup).not.toContain('undefined');
      expect(markup).not.toContain('책임');
    }
  });

  it('omits the Human gate section when gate is provided but human is not (도크트린⑤ — 책임자 없이 게이트 없음)', () => {
    const { human: _human, ...withoutHuman } = BASE;
    const markup = renderWithIntl(
      <ProofCapsule {...withoutHuman} gate={{ risk: '낮음', action: 'Merge gate 열기' }} density="full" />,
    );
    expect(markup).not.toContain('Human gate');
    expect(markup).not.toContain('Merge gate 열기');
  });
});

// story #2923(P0-E AQ4, 카디르 QA 이전 그라운딩 발견) — audit density가 human?.name을 mono
// 텍스트로만 붙일 뿐 아바타 자체를 안 그려(agent prop도 dispatch에서 안 넘어옴) 시안의
// "아바타 shape로 human/agent 구분"이 안 걸렸다. 공유 Avatar(shared/avatar.tsx) 재사용 —
// agent=rounded-full·human=rounded-md+border-proof-line(S4 avatar-unification 정본 그대로).
describe('ProofCapsule (audit density — actor avatar shape, story #2923 AQ4)', () => {
  it('renders a rounded-md avatar (human shape) for a human actor', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="audit" human={{ name: '윤재', role: 'owner' }} />,
    );
    expect(markup).toContain('rounded-md');
    expect(markup).toContain('border-proof-line');
    expect(markup).toContain('윤재');
  });

  it('renders a rounded-full avatar (agent shape) for an agent actor', () => {
    const { human: _human, ...withoutHuman } = BASE;
    const markup = renderWithIntl(
      <ProofCapsule {...withoutHuman} density="audit" agent={{ name: '미르코', initial: '미' }} />,
    );
    expect(markup).toContain('rounded-full');
    expect(markup).toContain('미르코');
  });

  it('omits the avatar entirely when neither human nor agent is provided (no crash, no undefined leak)', () => {
    const { human: _human, ...withoutHuman } = BASE;
    const markup = renderWithIntl(<ProofCapsule {...withoutHuman} density="audit" />);
    expect(markup).not.toContain('undefined');
  });
});

describe('ProofCapsule (footer slot — card·full 밀도, Board card 확산+story #2926 P0-F F2 gates/[id] 실기능 이관)', () => {
  it('renders arbitrary footer content below the claim/evidence in card density', () => {
    const markup = renderWithIntl(
      <ProofCapsule
        {...BASE}
        density="card"
        footer={<span data-testid="board-footer-marker">보드 카드 실기능 마커</span>}
      />,
    );
    expect(markup).toContain('보드 카드 실기능 마커');
  });

  // story #2926(P0-F F2) — full 밀도도 footer를 받는다: GateRow(단일 버튼 추상)로는 gates/[id]
  // 페이지의 4갈래 상태 분기(읽기전용/무권한/서명플로우/평버튼)를 못 담아, org/project 컨텍스트·
  // 배지·상태분기·EntityBacklinksSection 전부를 footer로 이관했다(카드 전용이던 전제가 바뀜).
  it('renders arbitrary footer content below claim/gate in full density too', () => {
    const markup = renderWithIntl(
      <ProofCapsule
        {...BASE}
        density="full"
        footer={<span data-testid="gate-detail-footer-marker">gates/[id] 상태분기 마커</span>}
      />,
    );
    expect(markup).toContain('gates/[id] 상태분기 마커');
  });

  it('ignores the footer prop on row/audit densities (no accidental leak — 이 둘은 여전히 전용 아님)', () => {
    for (const density of ['row', 'audit'] as const) {
      const markup = renderWithIntl(
        <ProofCapsule {...BASE} density={density} footer={<span>카드·full 전용 마커</span>} />,
      );
      expect(markup).not.toContain('카드·full 전용 마커');
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
        trustSeal={{ variant: 'claimed', agentInitial: '미' }}
      />,
    );
    expect(markup).toContain('주장됨');
    expect(markup).toContain('에이전트 주장');
    expect(markup).toContain('인간 검증 대기');
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
        trustSeal={{ variant: 'claimed', agentInitial: '미' }}
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

describe('ProofCapsule (EN locale — regression: 전면 하드코딩 한국어였던 것 i18n 배선, 유나 ko/en 카피 13키)', () => {
  it('renders claim/evidence/gate/risk entirely in English, no raw Korean or raw i18n key leaking through', () => {
    const markup = renderWithIntlEn(
      <ProofCapsule
        {...BASE}
        agent={{ name: 'Alex', initial: 'A' }}
        now="2h ago"
        evidence={{ acMet: 4, acTotal: 4, autoVerify: 'passed', proofCount: 3 }}
        gate={{ risk: '낮음', action: 'Open merge gate' }}
        density="full"
      />,
    );
    expect(markup).toContain('Claim · Agent says done');
    expect(markup).toContain('By Alex');
    expect(markup).toContain('Now: <b>2h ago</b>');
    expect(markup).toContain('Evidence · Against requirements');
    expect(markup).toContain('AC 4/4 met');
    expect(markup).toContain('Auto-check passed');
    expect(markup).toContain('3 evidence');
    expect(markup).toContain('Human gate · Human is accountable');
    expect(markup).toContain('Owned by');
    expect(markup).toContain('Risk: Low');
    // former hardcoded-Korean UI chrome must not survive in EN render (test fixture data like
    // stateLabel/human.name is expected to stay whatever language the caller passes — only the
    // component's own chrome strings are in scope here).
    for (const formerHardcoded of ['실행', '책임', '위험도', '자동검증', '지금:', '증거', 'Human gate · 인간']) {
      expect(markup).not.toContain(formerHardcoded);
    }
    expect(markup).not.toContain('proofCapsule.');
  });

  it('translates all three risk levels correctly (canonical ko literal -> EN label, not passthrough)', () => {
    const cases = [
      { risk: '낮음' as const, expected: 'Risk: Low' },
      { risk: '보통' as const, expected: 'Risk: Medium' },
      { risk: '높음' as const, expected: 'Risk: High' },
    ];
    for (const { risk, expected } of cases) {
      const markup = renderWithIntlEn(
        <ProofCapsule {...BASE} gate={{ risk, action: 'Review' }} density="full" />,
      );
      expect(markup).toContain(expected);
    }
  });
});

describe('ProofCapsule — story #2926(P0-F F1) onClaimClick (card density only)', () => {
  it('renders claim as a <button> when onClaimClick is provided(F1 소비처 — approval-request-card.tsx)', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="card" onClaimClick={() => {}} />,
    );
    expect(markup).toContain('<button');
    expect(markup).toContain(BASE.claim);
  });

  it('renders claim as plain text when onClaimClick is omitted(기존 card 호출부 — Board story-card.tsx 등 — 무변화)', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="card" />,
    );
    expect(markup).not.toContain('<button');
    expect(markup).toContain(BASE.claim);
  });
});

// story #32dcc294(v2 #2, 시안 a230cfd5) — card 밀도 전용 신규 슬롯(headerAside/cardHeader).
// 둘 다 optional·미전달 시 렌더 결과가 기존과 완전히 동일해야 다른 card 소비처
// (approval-request-card.tsx)가 무영향임이 보장된다.
describe('ProofCapsule — story #32dcc294 headerAside/cardHeader(card 밀도 전용 신규 슬롯)', () => {
  // 카디르 QA(#3446) REQUEST_CHANGES 적출 — 이전 버전은 post-PR 코드끼리 같은 렌더를 두 번
  // 비교하는 동어반복이라 어떤 변경에도 통과하는 무효 가드였다(구현이 깨져도 절대 안 빨개짐).
  // "byte-identical"은 옛 마크업 구조(=고정 문자열 리터럴)와 대조해야만 실패할 수 있는 가드가
  // 된다 — 아래는 StateHeader의 <span>이 wrapper div 없이 outer div의 직계 자식으로 오는지를
  // 옛 마크업 그대로 박아 확인한다(양성대조: headerAside를 주면 이 단언은 반드시 깨져야 한다).
  it('headerAside를 안 넘기면 wrapper div 자체가 렌더되지 않는다 — StateHeader가 옛 구조 그대로 outer div의 직계 자식(byte-identical, 고정 문자열 대조)', () => {
    const markup = renderWithIntl(<ProofCapsule {...BASE} density="card" />);
    expect(markup).toContain(
      '<div class="min-w-0 flex-1 px-3 py-2.5"><span class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-proof-green">',
    );
    // 새 wrapper(headerAside 전용)는 아예 없어야 한다.
    expect(markup).not.toContain('class="flex items-center justify-between gap-2"');
  });

  it('양성대조 — headerAside를 주면 위 "직계 자식" 단언이 실제로 깨진다(가드가 진짜 실패할 수 있음을 증명)', () => {
    const markup = renderWithIntl(<ProofCapsule {...BASE} density="card" headerAside={<span>x</span>} />);
    expect(markup).not.toContain(
      '<div class="min-w-0 flex-1 px-3 py-2.5"><span class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-proof-green">',
    );
    expect(markup).toContain('class="flex items-center justify-between gap-2"');
  });

  it('cardHeader를 안 넘기면 claim div가 옛 구조 그대로 StateHeader 바로 다음에 온다(byte-identical, 고정 문자열 대조)', () => {
    const markup = renderWithIntl(<ProofCapsule {...BASE} density="card" />);
    expect(markup).toContain(
      '</span><div class="mt-1.5 line-clamp-2 text-[12.5px] font-semibold leading-snug text-proof-ink">',
    );
  });

  it('headerAside를 넘기면 StateHeader와 같은 justify-between 행에 렌더된다', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="card" headerAside={<span data-testid="aside">#3017</span>} />,
    );
    expect(markup).toContain('#3017');
    // justify-between 행의 자식 순서: StateHeader(span)가 먼저, aside(span data-testid)가
    // 그 바로 뒤 형제로 같은 부모 div 안에 들어간다.
    const rowStart = markup.indexOf('class="flex items-center justify-between gap-2"');
    const stateHeaderIdx = markup.indexOf('증명 완료', rowStart);
    const asideIdx = markup.indexOf('data-testid="aside"', rowStart);
    expect(rowStart).toBeGreaterThan(-1);
    expect(stateHeaderIdx).toBeGreaterThan(rowStart);
    expect(asideIdx).toBeGreaterThan(stateHeaderIdx);
  });

  it('cardHeader를 넘기면 StateHeader 행 다음·claim 앞에 렌더된다', () => {
    const markup = renderWithIntl(
      <ProofCapsule {...BASE} density="card" cardHeader={<div data-testid="header">다음: 게이트 승인 대기</div>} />,
    );
    const headerIdx = markup.indexOf('다음: 게이트 승인 대기');
    const claimIdx = markup.indexOf(BASE.claim);
    expect(headerIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(claimIdx);
  });

  it('다른 card 소비처(예: approval-request-card.tsx)가 새 prop을 안 쓰는 렌더는 여전히 button/claim 규약을 그대로 지킨다(회귀 0)', () => {
    const markup = renderWithIntl(<ProofCapsule {...BASE} density="card" onClaimClick={() => {}} />);
    expect(markup).toContain('<button');
    expect(markup).toContain(BASE.claim);
  });
});
