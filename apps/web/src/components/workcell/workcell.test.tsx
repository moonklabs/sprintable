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

// story 38f524e1(critical, 선생님 실사고 2026-08-24) — Brief 셀 label+값 flex 행의 값
// 컬럼에 min-w-0이 없어 긴 무단절 토큰(코드·경로)이 min-content 폭을 강제, lg 3열 좁은
// 우열(246px)에서 셀 밖까지 뻗어 조상 overflow-hidden에 글자 중간 클리핑됐다. jsdom은 실제
// 레이아웃을 측정 못 하므로(라이브 픽셀 검증은 별도, feedback-render-test-over-source-grep)
// 이 테스트는 클리핑을 막는 CSS 메커니즘(min-w-0 + break-words)이 값 컬럼에 실제로 배선돼
// 있는지에 대한 회귀가드다.
describe('Workcell — story 38f524e1 Brief 값 컬럼 min-w-0/break-words 회귀가드', () => {
  it('goal/dod 값 wrapper(div)는 min-w-0, 본문(p)은 break-words를 갖는다(긴 코드·경로 토큰도 셀 폭 안에 수납)', () => {
    // story #178c7c6d(3015②) 이후 goal/dod 값은 <span> 평면 구조가 아니라
    // <div class="min-w-0"><p class="line-clamp-3 break-words">…</p></div>로 바뀌었다
    // (line-clamp+더보기 배선을 위한 wrapper). min-w-0은 wrapper(div, flex 자식)가 갖고
    // break-words는 실제 텍스트를 담는 p가 갖는다 — 3011/3012의 클리핑 방지 축은 유지.
    const longToken = 'workcell-bento-form-material-spec-2984-extremely-long-inline-code-path-token';
    const markup = renderKo(
      <Workcell
        {...BASE}
        brief={{ ...BASE.brief, goal: longToken, dod: longToken, scopes: [longToken] }}
      />,
    );
    const pMatches = [...markup.matchAll(/<div class="(min-w-0)"><p class="([^"]*)">workcell-bento-form-material-spec-2984-extremely-long-inline-code-path-token<\/p>/g)];
    // goal·dod 둘 다 같은 긴 토큰이라 이 패턴이 2번 생긴다.
    expect(pMatches).toHaveLength(2);
    for (const m of pMatches) {
      expect(m[2].split(/\s+/)).toEqual(expect.arrayContaining(['line-clamp-3', 'break-words']));
    }

    // scopes는 여전히 평면 span 구조(font-mono) — min-w-0+break-words 둘 다 그대로.
    const scopesMatch = markup.match(/<span class="(min-w-0 break-words font-mono[^"]*)">workcell-bento-form-material-spec-2984-extremely-long-inline-code-path-token<\/span>/);
    expect(scopesMatch).toBeTruthy();
    expect(scopesMatch![1].split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));
  });

  it('Run 요약(tools/scopes)도 실 파일경로 토큰 리스크가 있어 동형 처방(min-w-0 break-words)이 붙는다', () => {
    const markup = renderKo(
      <Workcell {...BASE} run={{ ...BASE.run, tools: ['apps/web/src/components/workcell/workcell.tsx'], scopes: ['apps/web/src/components/workcell/'] }} />,
    );
    // ko.json workcell.runTools = "도구" — 그 라벨을 안은 span의 class에 min-w-0/break-words가
    // 실제로 붙었는지 확인(라벨 텍스트로 정확히 좁혀 다른 span과 오탐 방지).
    const runToolsMatch = markup.match(/<span class="([^"]*)">도구 apps\/web\/src\/components\/workcell\/workcell\.tsx<\/span>/);
    expect(runToolsMatch).toBeTruthy();
    expect(runToolsMatch![1].split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));

    const runScopesMatch = markup.match(/<span class="([^"]*)">권한 apps\/web\/src\/components\/workcell\/<\/span>/);
    expect(runScopesMatch).toBeTruthy();
    expect(runScopesMatch![1].split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));
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

  it('verified → bg-proof-green 레일(유나양 확定 델타 — 이전엔 blue였다)', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="verified" />);
    const railMatch = markup.match(/^<div\b[^>]*><div class="([^"]*)" aria-hidden="true"><\/div>/);
    expect(railMatch).toBeTruthy();
    expect(railMatch![1].split(/\s+/)).toContain('bg-proof-green');
  });
});

// story #2922 W6 델타(유나양 확定, 2026-08-22) — 스테퍼 색을 위치기반(done=항상 green)에서
// 트러스트-시맨틱(각 단계 자체의 신뢰상태, 위치 무관)으로 전환. 판별 핵심: "지나온" 단계가
// 자기 고유 색(예: running=blue)을 유지해야 하며, 그저 지나왔다고 강제로 green이 되면 안 된다
// — 이게 옛 위치기반 로직과의 진짜 차이(#3345 부수 논의가 지적한 지점).
// story #2984 §6 — 이 축(PipelineStepper 컬러 로직)은 bentoLayout=false 폴백 경로에만
// 남아있다(기본은 ConfidenceGauge, 물리량이지 색이 아니다) — 복귀 스위치를 켰을 때도 옛
// 로직이 안 죽었는지 고정하기 위해 bentoLayout={false}로 명시한다.
describe('Workcell — story #2922 W6 스테퍼 트러스트-시맨틱 컬러(유나양 확定, bentoLayout=false 폴백)', () => {
  // 각 단계의 label-wrapper class는 `role="listitem"`으로 블록을 쪼갠 뒤 그 블록의 첫
  // class="..."(레이블+색을 쥔 중간 span — 바깥 span의 class는 role 앞이라 분할로 이미
  // 소비됨, 점(dot) span의 class는 이보다 뒤에 옴)로 정확히 좁힌다.
  function stageWrapperClass(markup: string, label: string): string {
    const block = markup.split('role="listitem"').slice(1).find((b) => b.includes(`>${label}</span>`));
    if (!block) throw new Error(`stage block not found for label: ${label}`);
    const m = block.match(/class="([^"]*)"/);
    if (!m) throw new Error(`class attr not found for label: ${label}`);
    return m[1];
  }

  it('merge_ready가 current일 때, 이미 지나온 Running 단계는 강제로 green이 되지 않고 자기 고유색(blue) 유지', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="merge_ready" bentoLayout={false} />);
    const runningClass = stageWrapperClass(markup, 'Running');
    expect(runningClass.split(/\s+/)).toContain('text-proof-blue');
    expect(runningClass.split(/\s+/)).not.toContain('text-proof-green');
  });

  it('verified가 current일 때 그 자신은 green(자기 색이 진짜 green이므로)', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="verified" bentoLayout={false} />);
    const verifiedClass = stageWrapperClass(markup, 'Verified');
    expect(verifiedClass.split(/\s+/)).toContain('text-proof-green');
    expect(verifiedClass.split(/\s+/)).toContain('font-bold');
  });

  it('claimed_done이 current일 때 그 자신은 blue(주장·미검증 — 아직 green 아님)', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="claimed_done" bentoLayout={false} />);
    const claimedClass = stageWrapperClass(markup, 'Claimed done');
    expect(claimedClass.split(/\s+/)).toContain('text-proof-blue');
  });
});

describe('Workcell — story #2922 W1 신뢰 파이프라인 헤더 스테퍼(6상태) + 2×2 구획 (bentoLayout=false 폴백)', () => {
  it('renders all six pipeline stage labels regardless of current stage', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="queued" bentoLayout={false} />);
    expect(markup).toContain('Queued');
    expect(markup).toContain('Running');
    expect(markup).toContain('Needs input');
    expect(markup).toContain('Claimed done');
    expect(markup).toContain('Verified');
    expect(markup).toContain('Merge-ready');
  });

  it('marks the current stage with aria-current="step" (색만 금지 — 스크린리더도 현재단계를 안다)', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="claimed_done" bentoLayout={false} />);
    expect(markup).toContain('aria-current="step"');
  });

  it('renders a 2×2 quadrant body (Brief|Run / Evidence|Conversation), not a vertical 4-stack', () => {
    const markup = renderKo(<Workcell {...BASE} bentoLayout={false} />);
    expect(markup).toContain('grid-cols-2');
  });
});

// story #2984 §1~§4/§6(doc workcell-bento-form-material-spec-2984) — bentoLayout 기본값
// true의 실 착지 회귀가드. §6 복귀 스위치 자체(=bentoLayout prop이 실제로 옛 모습을
// 복원하는지)는 바로 위 두 describe(bentoLayout={false} 명시)가 고정한다 — "1줄 복귀"의
// 그 1줄이 정말 옛 마크업을 그대로 살려내는지가 검증 대상이었다.
describe('Workcell — story #2984 §1~§4 bento 기본 레이아웃(bentoLayout 기본값 true)', () => {
  it('§1 — Evidence·Run·Brief·Conversation 4셀이 bento grid(1.7fr:4px:1fr 열)로 렌더된다', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('grid-cols-[1.7fr_4px_1fr]');
    expect(markup).not.toContain('grid-cols-2');
  });

  it('§2 — Brief/Run과 Evidence를 잇는 계보 연결선(가운데 트랙)이 렌더된다', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('lg:col-start-2 lg:row-start-1 lg:row-span-2');
    expect(markup).toContain('bg-proof-line-strong');
  });

  // story bc9ee586(critical, 선생님 실사고 2026-08-24) — 3열 그리드가 모바일(390px)에서
  // 그대로 유지돼 Evidence 제목 어절 세로 낙하·Run CTA 글자 꺾임. base=단일 컬럼 스택,
  // lg: 이상만 3열(GNB lg:hidden과 일치하는 breakpoint — CLAUDE.md md 사용 금지 규율).
  it('bc9ee586 — base는 단일 컬럼 스택(grid-cols-1), 3열/연결선은 lg: 이상에서만 적용된다', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('grid-cols-1');
    // 연결선 wrapper는 모바일에서 숨김(hidden), lg:flex로만 드러난다.
    expect(markup).toContain('class="hidden lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:flex lg:justify-center"');
  });

  it('§4 — Evidence 셀만 elevation(--elev-card, 인라인 카드 전용) 그림자를 갖고 나머지는 flat', () => {
    // story #2990 §4 fast-follow(유나 확定) — elev-overlay(오버레이 전용)는 "팝오버처럼
    // 분리"되는 의미 혼용이라 elev-card(인라인 카드 전용, 약한 강도)로 교체.
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('shadow-[var(--elev-card)]');
    expect(markup).not.toContain('shadow-[var(--elev-overlay)]');
    expect(markup).toContain('shadow-[0_1px_0_var(--proof-line)]');
  });

  it('§3 — 헤더가 색 스테퍼가 아니라 물리량 게이지(role=progressbar)로 렌더된다', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage="needs_input" />);
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="3"');
    expect(markup).toContain('aria-valuemax="6"');
    expect(markup).not.toContain('role="list"');
  });

  it('§6 — bentoLayout={false}로 뒤집으면 §1~§4 마크업이 전부 사라지고 옛 모습으로 복귀한다', () => {
    const markup = renderKo(<Workcell {...BASE} bentoLayout={false} />);
    expect(markup).not.toContain('grid-cols-[1.7fr_4px_1fr]');
    expect(markup).not.toContain('shadow-[var(--elev-card)]');
    expect(markup).not.toContain('role="progressbar"');
  });
});

describe('Workcell Run layer (진행률바 0 — 현재행위+다음요구만)', () => {
  it('renders "지금:" current action and "다음 요구" next-need, never a percentage progress bar', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toContain('지금: 재시도 로직 검증 테스트 작성 중');
    expect(markup).toContain('다음 요구');
    expect(markup).toContain('까심군 QA 리뷰 대기');
    // story #2984 §3 — 헤더 Confidence 게이지는 물리량 채움 %를 의도적으로 쓴다(전혀 다른
    // 계약, 위 "§3" 테스트가 고정). 이 안티패턴 검사는 Run 레이어 자신의 마크업(LayerLabel
    // "Run" 이후·다음 LayerLabel "Evidence" 이전 구간)에만 좁힌다 — Run 자신은 여전히 %
    // 진행률을 렌더하면 안 된다는 원래 도크트린 그대로.
    const runStart = markup.indexOf('>Run<');
    const runEnd = markup.indexOf('>Evidence<');
    const runMarkup = markup.slice(runStart, runEnd);
    expect(runMarkup).not.toMatch(/role="progressbar"/);
    expect(runMarkup).not.toContain('progress-bar');
    expect(runMarkup).not.toMatch(/width:\s*\d+%/);
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
  it('renders no toggle/messages block at all when there are no comments (rule④ — disclosure 자체 미표시)', () => {
    const markup = renderKo(<Workcell {...BASE} conversation={{ view: 'run', messages: [] }} />);
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain('실행</button>');
  });

  it('renders all three view-toggle labels (실행/증거/결정) and the real messages inside a collapsed disclosure', () => {
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
    expect(markup).toContain('<details');
    expect(markup).toContain('실행');
    expect(markup).toContain('증거');
    expect(markup).toContain('결정');
    expect(markup).toContain('유나양');
    expect(markup).toContain('위계 낮음');
    expect(markup).toContain('↳ v4 반영');
    expect(markup).toContain('미르코군');
  });
});

// story #2922 W5 — 유나양 확定 4규칙: ①구획 본체=ChatProofSection 요약 ②story 댓글=하위
// 접힘 disclosure(기능 무손실) ③위계(챗=주·댓글=부) ④0건 정직표시(댓글0=미표시·스레드0="연결된
// 대화 없음"). ChatProofSummaryRow는 전용 sub-describe로 분리 검증.
describe('Workcell — story #2922 W5 Conversation 구획 = ChatProofSection 요약 + 댓글 하위접힘', () => {
  it('chatProof가 undefined(로딩 중)면 요약 자체를 렌더 보류한다(no-fiction — 성급한 "없음" 단정 금지)', () => {
    const markup = renderKo(<Workcell {...BASE} conversation={{ view: 'run', messages: [], chatProof: undefined }} />);
    expect(markup).not.toContain('연결된 대화 없음');
    expect(markup).not.toContain('대화 근거');
  });

  it('count=null(확認된 0건) → "연결된 대화 없음" 정직 표시(침묵 아님)', () => {
    const markup = renderKo(<Workcell {...BASE} conversation={{ view: 'run', messages: [], chatProof: { count: null, href: null } }} />);
    expect(markup).toContain('연결된 대화 없음');
  });

  it('count>0 → 건수+링크 렌더, href는 첫 근거의 대화로', () => {
    const markup = renderKo(
      <Workcell {...BASE} conversation={{ view: 'run', messages: [], chatProof: { count: 3, href: '/chats/conv-1?messageId=msg-1' } }} />,
    );
    expect(markup).toContain('대화 근거 3건 보기');
    expect(markup).toContain('href="/chats/conv-1?messageId=msg-1"');
  });

  it('위계 — 챗 요약(본체)이 댓글 disclosure(부)보다 마크업상 먼저 온다', () => {
    const markup = renderKo(
      <Workcell
        {...BASE}
        conversation={{
          view: 'run',
          messages: [{ author: '유나양', body: '코멘트' }],
          chatProof: { count: 1, href: '/chats/conv-1?messageId=msg-1' },
        }}
      />,
    );
    const chatProofIdx = markup.indexOf('대화 근거 1건 보기');
    const disclosureIdx = markup.indexOf('<details');
    expect(chatProofIdx).toBeGreaterThan(-1);
    expect(disclosureIdx).toBeGreaterThan(-1);
    expect(chatProofIdx).toBeLessThan(disclosureIdx);
  });

  // story 8df36496(high, 3011 동일 클래스 잔존) — 카디르 QA(#3440) 발견: 메시지 본문 값 span이
  // min-w-0만 갖고 break-words가 없었다. m.body는 자유텍스트라 URL·해시 등 무단절 토큰 실
  // 위험군(#3440 하네스가 증명한 대로 min-w-0 단독으론 클리핑이 재현된다).
  it('story 8df36496 — 메시지 본문 값 span이 min-w-0과 break-words를 동시에 갖는다(무단절 토큰 클리핑 회귀가드)', () => {
    const longToken = 'https://example.com/xtremelylongunbrokenidentifiertoken1234567890abcdefghijklmnop';
    const markup = renderKo(
      <Workcell
        {...BASE}
        conversation={{ view: 'run', messages: [{ author: 'A', body: longToken }] }}
      />,
    );
    // 정규식 이스케이프 없이 순수 문자열 탐색으로 토큰 직전의 span class를 역추적한다
    // (동적 토큰을 정규식에 끼워넣는 이스케이프 버그를 원천 차단).
    const bodyIdx = markup.indexOf(`>${longToken}`);
    expect(bodyIdx).toBeGreaterThan(-1);
    const spanOpenIdx = markup.lastIndexOf('<span class="', bodyIdx);
    const classStart = spanOpenIdx + '<span class="'.length;
    const classEnd = markup.indexOf('"', classStart);
    const spanClass = markup.slice(classStart, classEnd);
    expect(spanClass.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));
  });

  it('댓글 N건 disclosure 라벨에 정확한 건수가 들어간다', () => {
    const markup = renderKo(
      <Workcell
        {...BASE}
        conversation={{
          view: 'run',
          messages: [{ author: 'A', body: '1' }, { author: 'B', body: '2' }],
        }}
      />,
    );
    expect(markup).toContain('댓글 2건');
  });
});

// story #2993(PO 확定①②, 2026-08-24) — pipelineStage/owner 둘 다 이전엔 null이면 Workcell
// 전체를 지웠다("주전장이 안 보인다" 실사고 근본원인). 이제 무조건 렌더하고 각자 정직한
// 빈 상태로 대체한다(합성값 금지 — #2933 H1 조건②·no-fiction 유지).
describe('Workcell — story #2993 pipelineStage/owner null 정직 빈 상태(합성 금지)', () => {
  it('pipelineStage=null이면 게이지/스테퍼 대신 "파이프라인 범위 밖" 표시, role=progressbar/listitem 렌더 안 함', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage={null} />);
    expect(markup).toContain('완료 — 신뢰 파이프라인 범위 밖');
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('role="listitem"');
  });

  it('pipelineStage=null이어도 나머지 구획(Brief/Run/Evidence/Conversation)은 그대로 렌더된다', () => {
    const markup = renderKo(<Workcell {...BASE} pipelineStage={null} />);
    expect(markup).toContain('Brief');
    expect(markup).toContain('Run');
    expect(markup).toContain('Evidence');
    expect(markup).toContain('Conversation');
  });

  it('brief.owner=null이면 "책임자 미지정" 정직 표시(허구 human 이름 없음)', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, owner: null }} />);
    expect(markup).toContain('책임자 미지정');
    expect(markup).not.toContain('책임 윤재');
  });

  it('agent만 있고 owner=null이어도 agent 표기는 정상 렌더(둘은 독립 축)', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, owner: null }} />);
    expect(markup).toContain('실행 미르코군');
  });
});

// story #5b3aea5e(구현, 3015 시안 178c7c6d ② 표현층) — Brief 「원문 덤프」 폐지. 마크다운
// 스트립+리드 추출+3줄 클램프+「더 보기」기존 본문 위임. 소스(story.description 등) 자체는
// 무변경 — Workcell은 여전히 전달받은 문자열을 표현만 변환한다(리라이트·요약 생성 금지).
describe('Workcell — story #5b3aea5e Brief 콘텐츠 층(마크다운 스트립·리드 추출·클램프·더보기)', () => {
  const RAW_GOAL = 'doc `workcell-bento-form-material-spec-2984`가 구현 SSOT.\n\n## 범위\n- 대상: `apps/web/src/components/kanban/story-detail-panel.tsx`\n## 처방\n뭔가';

  it('마크다운 기호(##·백틱·리스트 대시) 원문이 렌더 결과에 노출되지 않는다', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, goal: RAW_GOAL }} />);
    expect(markup).not.toContain('##');
    expect(markup).not.toContain('`workcell-bento-form-material-spec-2984`');
    expect(markup).not.toContain('- 대상');
  });

  it('첫 ## 헤딩 前 프로즈만 verbatim 노출(리라이트·요약 없음) — 헤딩 이후 섹션(범위·처방)은 렌더되지 않는다', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, goal: RAW_GOAL }} />);
    expect(markup).toContain('doc workcell-bento-form-material-spec-2984가 구현 SSOT.');
    expect(markup).not.toContain('story-detail-panel.tsx');
    expect(markup).not.toContain('처방');
  });

  it('goal 값에 line-clamp-3가 적용된다(3줄 상한 — 잘림 아닌 의도된 절제)', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).toMatch(/class="[^"]*\bline-clamp-3\b[^"]*"[^>]*>실패한 결제를 재시도로 복구/);
  });

  it('onGoalMore 콜백이 있으면 "더 보기" 링크가 렌더되고 클릭 시 콜백이 호출된다', () => {
    let called = false;
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, onGoalMore: () => { called = true; } }} />);
    expect(markup).toContain('더 보기 →');
    // renderToStaticMarkup은 이벤트 핸들러를 실행할 DOM이 없다 — 콜백 자체가 prop으로
    // 전달돼 실제로 쓰였는지는 마크업에 링크가 등장하는지로 간접 확인(정직한 한계 고지).
    expect(called).toBe(false);
  });

  it('onGoalMore가 없으면 "더 보기" 링크 자체를 렌더하지 않는다(갈 곳 없는 링크 금지)', () => {
    const markup = renderKo(<Workcell {...BASE} />);
    expect(markup).not.toContain('더 보기 →');
  });

  it('dod=null이면 "완료 조건 미기재 · 본문 AC 보기"를 정직 표시한다(onDodMore 제공 시)', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, dod: null, onDodMore: () => {} }} />);
    expect(markup).toContain('완료 조건 미기재');
    expect(markup).toContain('본문 AC 보기');
  });

  it('dod=null·onDodMore 없으면 "본문 AC 보기" 링크 없이 "완료 조건 미기재"만 뜬다', () => {
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, dod: null }} />);
    expect(markup).toContain('완료 조건 미기재');
    expect(markup).not.toContain('본문 AC 보기');
  });

  it('dod가 있으면 goal과 동형으로 스트립+리드+클램프 처리된다(마크다운 노출 0)', () => {
    const rawDod = '## AC\n- `tsc --noEmit` clean\n- 전체 vitest green';
    const markup = renderKo(<Workcell {...BASE} brief={{ ...BASE.brief, dod: rawDod }} />);
    // 전체가 헤딩(## AC)으로 시작 — extractBriefLead가 헤딩 텍스트 자체로 폴백한다.
    expect(markup).not.toContain('##');
    expect(markup).not.toContain('- `tsc');
  });
});
