import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workcell, type WorkcellProps } from './workcell';

const BASE: WorkcellProps = {
  title: '결제 복구 플로우 — 재시도 로직',
  proofState: 'blue',
  stateLabel: '실행 중',
  brief: {
    goal: '실패한 결제를 재시도로 복구',
    dod: 'AC 4 충족 · 자동검증 passed · 정본 승인',
    owner: { name: '윤재', role: '책임' },
    agent: { name: '미르코군', initial: '미' },
  },
  run: {
    now: '재시도 로직 검증 테스트 작성 중',
    stage: '구현→검증',
    tools: ['pytest'],
    scopes: ['repo write'],
    blocked: null,
    nextNeed: '까심군 QA 리뷰 대기',
  },
  evidence: null,
  conversation: { view: 'run', messages: [] },
};

describe('Workcell (4층 — Brief/Run/Evidence/Conversation)', () => {
  it('renders all four layer labels', () => {
    const markup = renderToStaticMarkup(<Workcell {...BASE} />);
    expect(markup).toContain('Brief');
    expect(markup).toContain('Run');
    expect(markup).toContain('Evidence');
    expect(markup).toContain('Conversation');
  });

  it('renders the header title and state label together (색만으로 의미 전달 금지)', () => {
    const markup = renderToStaticMarkup(<Workcell {...BASE} />);
    expect(markup).toContain(BASE.title);
    expect(markup).toContain('실행 중');
  });

  it('renders Brief goal/dod/owner/agent', () => {
    const markup = renderToStaticMarkup(<Workcell {...BASE} />);
    expect(markup).toContain('실패한 결제를 재시도로 복구');
    expect(markup).toContain('AC 4 충족');
    expect(markup).toContain('책임 윤재');
    expect(markup).toContain('실행 미르코군');
  });
});

describe('Workcell Run layer (진행률바 0 — 현재행위+다음요구만)', () => {
  it('renders "지금:" current action and "다음 요구" next-need, never a percentage progress bar', () => {
    const markup = renderToStaticMarkup(<Workcell {...BASE} />);
    expect(markup).toContain('지금: 재시도 로직 검증 테스트 작성 중');
    expect(markup).toContain('다음 요구');
    expect(markup).toContain('까심군 QA 리뷰 대기');
    // clip-path(컷코너)는 CSS 값이라 '%'를 포함하는 게 정상이고, LayerLabel 설명 문구도
    // "진행률바 아님"이라 그 단어 자체는 등장한다(부재를 명시하는 문구) — 실제로 검사할 건
    // 진행률 바 "구현"(role/class/width:N% 스타일) 자체가 없다는 것.
    expect(markup).not.toMatch(/role="progressbar"/);
    expect(markup).not.toContain('progress-bar');
    expect(markup).not.toMatch(/width:\s*\d+%/);
  });

  it('shows "없음" for blocked when null, and the blocked value when present (never hidden — 도크트린 ③)', () => {
    const clean = renderToStaticMarkup(<Workcell {...BASE} run={{ ...BASE.run, blocked: null }} />);
    expect(clean).toContain('없음');

    const blocked = renderToStaticMarkup(<Workcell {...BASE} run={{ ...BASE.run, blocked: '의존 대기 중' }} />);
    expect(blocked).toContain('의존 대기 중');
  });
});

describe('Workcell Evidence layer (Proof Capsule 재사용 · null=정직한 빈 상태)', () => {
  it('shows an honest empty state when evidence is null (no fabricated claim)', () => {
    const markup = renderToStaticMarkup(<Workcell {...BASE} evidence={null} />);
    expect(markup).toContain('아직 증거 없음');
  });

  it('renders the actual ProofCapsule component when evidence is provided', () => {
    const markup = renderToStaticMarkup(
      <Workcell
        {...BASE}
        evidence={{
          proofState: 'green', stateLabel: '증명 완료', claim: '재시도 로직 구현 완료',
          human: { name: '윤재', role: 'human' }, density: 'full',
          evidence: { acMet: 4, acTotal: 4, autoVerify: 'passed' },
          gate: { risk: '낮음', action: 'Merge gate 열기' },
        }}
      />,
    );
    expect(markup).toContain('재시도 로직 구현 완료');
    expect(markup).toContain('AC 4/4');
    expect(markup).toContain('Merge gate 열기');
  });
});

describe('Workcell Conversation layer (작업-귀속 · 전역 chat과 분리 · 뷰 가소성)', () => {
  it('shows an honest empty state when there are no messages', () => {
    const markup = renderToStaticMarkup(<Workcell {...BASE} conversation={{ view: 'run', messages: [] }} />);
    expect(markup).toContain('아직 메시지가 없습니다');
  });

  it('renders all three view-toggle labels (실행/증거/결정) and the real messages with author+body', () => {
    const markup = renderToStaticMarkup(
      <Workcell
        {...BASE}
        conversation={{
          view: 'run',
          messages: [
            { author: '유나양', body: '위계 낮음 · primary로 키우기', resultLink: '↳ v4 반영' },
            { author: '미르코군', body: '반영했는 — 테스트 추가 중' },
          ],
        }}
      />,
    );
    expect(markup).toContain('실행');
    expect(markup).toContain('증거');
    expect(markup).toContain('결정');
    expect(markup).toContain('유나양');
    expect(markup).toContain('위계 낮음');
    expect(markup).toContain('↳ v4 반영');
    expect(markup).toContain('미르코군');
  });
});
