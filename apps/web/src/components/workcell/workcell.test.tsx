import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { ReactElement } from 'react';
import { Workcell, type WorkcellProps } from './workcell';

// Workcell이 useTranslations('workcell')을 쓰므로 렌더에 NextIntlClientProvider 필수.
// ko 로케일로 감싸 기존 한글 스냅샷 단언을 그대로 유지한다(KO 회귀 대조 = AC3).
function renderKo(ui: ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );
}

const BASE: WorkcellProps = {
  title: '결제 복구 플로우 — 재시도 로직',
  pipelineStage: 'running',
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
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('Brief');
    expect(markup).toContain('Run');
    expect(markup).toContain('Evidence');
    expect(markup).toContain('Conversation');
  });

  it('renders the header title and the current pipeline stage label together (색만으로 의미 전달 금지)', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain(BASE.title);
    expect(markup).toContain('Running');
  });

  it('renders Brief goal/dod + header owner/agent(story #2922 W4 — 헤더로 승격)', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('실패한 결제를 재시도로 복구');
    expect(markup).toContain('AC 4 충족');
    expect(markup).toContain('책임 윤재');
    expect(markup).toContain('실행 미르코군');
  });
});

// story #2922 W4 — 책임자/실행자가 헤더 한 곳으로 승격됐다(Brief 구획 중복 제거).
describe('Workcell — story #2922 W4 책임자/실행자 헤더 승격(중복 제거 회귀가드)', () => {
  it('owner/agent "라벨+이름" 텍스트가 정확히 한 번씩만 렌더된다(헤더 SSOT, Brief에 중복 없음)', () => {
    // #3339(2921) 이후 Avatar 컴포넌트가 접근성용 aria-label={name}도 함께 심는다 —
    // 이름 substring 단독 카운트는 그 aria-label과 겹쳐 거짓 "2회"로 보이므로, 실제
    // 헤더가 렌더하는 "라벨+이름" 조합 문구로 좁혀서 정확히 1회임을 확인한다.
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup.split('책임 윤재').length - 1).toBe(1);
    expect(markup.split('실행 미르코군').length - 1).toBe(1);
  });

  it('agent 없으면(브리핑에 실행자 미배정) 실행 라벨 자체가 안 뜬다(no-fiction)', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, agent: undefined }} />);
    expect(markup).toContain('책임 윤재');
    expect(markup).not.toContain('실행 미르코군');
  });
});

// story #2922 W6(선행 조각) — Proofline 좌측 레일. queued는 4색(blue/amber/green/red) 중
// 어느 것도 아니라(신호 없음) 회색 폴백이어야 한다(no-fiction — 색을 지어내지 않음).
describe('Workcell — story #2922 W6 Proofline 레일(단계→색 파생)', () => {
  it('merge_ready → bg-proof-green 레일', () => {
    // 카디르군 QA(#3345 HIGH) — 이전 정규식(전역 class+aria-hidden 매치)이 레일이 아니라
    // merge_ready일 때 PipelineStepper의 «선행완료 점»(동일하게 bg-proof-green+
    // aria-hidden="true")에 우연매치해 로드베어링이 아니었다(뮤테이션해도 안 깨짐, 실증
    // — codex+카디르 완전독립 이중재현). 최상위 첫 자식(레일 그 자체)에만 앵커링한다.
    const markup = renderKo(<Workcell {...BASE} pipelineStage="merge_ready" />);
    const railMatch = markup.match(/^<div\b[^>]*><div class="([^"]*)" aria-hidden="true"><\/div>/);
    expect(railMatch).toBeTruthy();
    expect(railMatch![1].split(/\s+/)).toContain('bg-proof-green');
  });

  it('needs_input → bg-proof-amber 레일', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="needs_input" />);
    expect(markup).toMatch(/class="[^"]*bg-proof-amber[^"]*"[^>]*aria-hidden="true"/);
  });

  it('queued(신호 없음) → 4색 어느 것도 안 쓰고 중립 회색(bg-proof-line)만', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="queued" />);
    const railMatch = markup.match(/<div class="w-1 shrink-0 self-stretch[^"]*" aria-hidden="true"><\/div>/);
    expect(railMatch).toBeTruthy();
    expect(railMatch![0]).toContain('bg-proof-line');
    expect(railMatch![0]).not.toMatch(/bg-proof-(blue|amber|green|red)/);
  });
});

describe('Workcell — story #2922 W1 신뢰 파이프라인 헤더 스테퍼(6상태) + 2×2 구획', () => {
  it('renders all six pipeline stage labels regardless of current stage', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="queued" />);
    expect(markup).toContain('Queued');
    expect(markup).toContain('Running');
    expect(markup).toContain('Needs input');
    expect(markup).toContain('Claimed done');
    expect(markup).toContain('Verified');
    expect(markup).toContain('Merge-ready');
  });

  it('marks the current stage with aria-current="step" (색만 금지 — 스크린리더도 현재단계를 안다)', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="claimed_done" />);
    expect(markup).toContain('aria-current="step"');
  });

  it('renders a 2×2 quadrant body (Brief|Run / Evidence|Conversation), not a vertical 4-stack', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('grid-cols-2');
  });
});

describe('Workcell Run layer (진행률바 0 — 현재행위+다음요구만)', () => {
  it('renders "지금:" current action and "다음 요구" next-need, never a percentage progress bar', () => {
    const markup = renderKo(<Workcell {...BASE} />);
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
    const clean = renderKo(<Workcell {...BASE} run={{ ...BASE.run, blocked: null }} />);
    expect(clean).toContain('없음');

    const blocked = renderKo(<Workcell {...BASE} run={{ ...BASE.run, blocked: '의존 대기 중' }} />);
    expect(blocked).toContain('의존 대기 중');
  });
});

describe('Workcell Evidence layer (Proof Capsule 재사용 · null=정직한 빈 상태)', () => {
  it('shows an honest empty state when evidence is null (no fabricated claim)', () => {
    const markup = renderKo(<Workcell {...BASE} evidence={null} />);
    expect(markup).toContain('아직 증거 없음');
  });

  it('renders the actual ProofCapsule component when evidence is provided', () => {
    // ProofCapsule의 FullVariant/EvidenceRow/GateRow가 proofCapsule i18n 배선(useTranslations)을
    // 쓰므로 NextIntlClientProvider 필수(다른 Workcell 테스트는 evidence=null이라 이 경로를 안 탐).
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <Workcell
          {...BASE}
          evidence={{
            proofState: 'green', stateLabel: '증명 완료', claim: '재시도 로직 구현 완료',
            human: { name: '윤재', role: 'human' }, density: 'full',
            evidence: { acMet: 4, acTotal: 4, autoVerify: 'passed' },
            gate: { risk: '낮음', action: 'Merge gate 열기' },
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(markup).toContain('재시도 로직 구현 완료');
    expect(markup).toContain('AC 4/4');
    expect(markup).toContain('Merge gate 열기');
  });
});

describe('Workcell Conversation layer (작업-귀속 · 전역 chat과 분리 · 뷰 가소성)', () => {
  it('shows an honest empty state when there are no messages', () => {
    const markup = renderKo(<Workcell {...BASE} conversation={{ view: 'run', messages: [] }} />);
    expect(markup).toContain('아직 메시지가 없습니다');
  });

  it('renders all three view-toggle labels (실행/증거/결정) and the real messages with author+body', () => {
    const markup = renderKo(
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
