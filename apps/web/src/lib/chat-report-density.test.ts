import { describe, expect, it } from 'vitest';
import {
  computeReportDensity, deriveKicker, deriveVerdictTone, extractLeadSentence, extractNextAction,
  extractTopLevelItems, isReportDense, REPORT_DENSITY_MIN_CHARS, REPORT_DENSITY_MIN_LINES,
} from './chat-report-density';

describe('isReportDense (story #ec57c80c, 발동 임계값)', () => {
  it('짧은 대화 메시지는 false(무변경 대상)', () => {
    expect(isReportDense('고맙는!')).toBe(false);
    expect(isReportDense('악! 확認했는.')).toBe(false);
  });

  it('줄 수가 임계값 이상이면 true', () => {
    const raw = Array.from({ length: REPORT_DENSITY_MIN_LINES }, (_, i) => `줄 ${i + 1}`).join('\n');
    expect(isReportDense(raw)).toBe(true);
  });

  it('글자 수가 임계값 이상이면 true(줄 수는 적어도)', () => {
    expect(isReportDense('가'.repeat(REPORT_DENSITY_MIN_CHARS))).toBe(true);
  });

  it('임계값 바로 아래는 false(경계 검증)', () => {
    const justUnder = Array.from({ length: REPORT_DENSITY_MIN_LINES - 1 }, (_, i) => `줄${i}`).join('\n');
    expect(isReportDense(justUnder.slice(0, REPORT_DENSITY_MIN_CHARS - 1))).toBe(false);
  });
});

describe('deriveKicker (story #ec57c80c AC2 — 오분류 안전측)', () => {
  it('message_kind가 있으면 1차 소스로 즉시 확定', () => {
    expect(deriveKicker('아무 내용', 'result')).toBe('판정');
    expect(deriveKicker('아무 내용', 'handoff')).toBe('핸드오프');
    expect(deriveKicker('아무 내용', 'request')).toBe('요청');
    expect(deriveKicker('아무 내용', 'ack')).toBe('확인');
  });

  it('message_kind가 null/undefined면 보수적 패턴 폴백 — 확실한 판정 어휘(PASS/FAIL/REQUEST_CHANGES)가 볼드 라인에 있을 때만', () => {
    expect(deriveKicker('**결과 — PASS**\n본문', null)).toBe('판정');
    expect(deriveKicker('**결과 — FAIL**\n본문', undefined)).toBe('판정');
    expect(deriveKicker('**REQUEST_CHANGES — 사유**\n본문', null)).toBe('판정');
  });

  it('message_kind 없고 패턴도 불확실하면 kicker 미표시(null) — 오분류=지어냄 방지(강제 테스트)', () => {
    expect(deriveKicker('그냥 평범한 긴 설명 문단입니다.', null)).toBeNull();
    // 볼드는 있지만 판정 어휘가 없는 경우도 미표시.
    expect(deriveKicker('**진행 상황 업데이트**\n작업 중', null)).toBeNull();
    // PASS가 볼드 밖(평문)에 있으면 미표시 — "확실한 패턴"이 아니라 보수적으로 거른다.
    expect(deriveKicker('PASS라고 들었는데 확인은 안 함', null)).toBeNull();
  });
});

describe('extractLeadSentence (story #ec57c80c — 첫 문장 verbatim, 3015 규율)', () => {
  it('첫 문장 경계(마침표+공백)에서 자른다', () => {
    expect(extractLeadSentence('첫 문장입니다. 둘째 문장.')).toBe('첫 문장입니다.');
  });

  it('마침표 없이 줄바꿈만 있으면 첫 줄에서 자른다', () => {
    expect(extractLeadSentence('첫 줄 내용\n둘째 줄 내용')).toBe('첫 줄 내용');
  });

  it('줄바꿈과 마침표 중 먼저 오는 경계를 쓴다', () => {
    expect(extractLeadSentence('짧은 첫 줄\n둘째 줄. 셋째.')).toBe('짧은 첫 줄');
    expect(extractLeadSentence('첫 문장. 둘째 줄\n셋째 줄')).toBe('첫 문장.');
  });

  it('볼드/백틱 마커를 스트립한다(verbatim 텍스트는 그대로)', () => {
    expect(extractLeadSentence('**중요 결과** — `workcell.tsx` 확認.')).toBe('중요 결과 — workcell.tsx 확認.');
  });

  it('verbatim — 리라이트·요약 없이 원문 문구를 정확히 보존한다', () => {
    const raw = '실패한 결제를 재시도로 복구하는 로직 구현 완료';
    expect(extractLeadSentence(raw)).toBe(raw);
  });

  it('빈 입력은 빈 문자열', () => {
    expect(extractLeadSentence('')).toBe('');
    expect(extractLeadSentence('   ')).toBe('');
  });

  // 카디르 QA(#3448) 적출 — 문장 경계(마침표)가 볼드 스팬 중간에 떨어지면 절단 결과가
  // "**Summary."(닫는 ** 없음)가 돼 미완성 마커가 화면에 그대로 샌다. 마커가 짝 안 맞는
  // 절단은 건너뛰고 더 늦은(안전한) 경계 또는 전체로 폴백해야 한다.
  describe('카디르 repro — 마커 균형 폴백(미완성 ** 노출 방지)', () => {
    it('원 repro — "**Summary. Done**"에서 마침표가 볼드 중간에 있어도 미완성 마커가 안 샌다', () => {
      expect(extractLeadSentence('**Summary. Done**')).toBe('Summary. Done');
    });

    it('볼드 스팬 뒤에 더 안전한 줄바꿈 경계가 있으면 그쪽으로 폴백한다', () => {
      expect(extractLeadSentence('**Summary. Done**\n둘째 줄')).toBe('Summary. Done');
    });

    it('백틱(인라인 코드) 스팬 중간에 마침표가 있어도 미완성 백틱이 안 샌다', () => {
      expect(extractLeadSentence('`workcell.tsx 파일. 확認`')).toBe('workcell.tsx 파일. 확認');
    });

    it('정상적으로 짝이 맞는 절단은 기존대로 그대로 동작한다(회귀 0)', () => {
      expect(extractLeadSentence('**중요**. 둘째 문장.')).toBe('중요.');
    });
  });

  // story #3030 — 카디르 #3448 재QA 중 codex 비차단 발견①: 경계 탐색이 .match()(non-global)라
  // 첫 마침표만 후보였다. 첫 마침표가 불균형이면(뒤에 더 균형 잡힌 경계가 있어도) 곧장 전체
  // 폴백으로 건너뛰었다 — matchAll로 전 구간을 순회해 가장 이른 균형 경계를 찾도록 fix.
  describe('story #3030 — global 경계 탐색(첫 마침표 불균형이어도 뒤의 균형 경계를 찾는다)', () => {
    it('첫 마침표가 볼드 중간(불균형)이어도 그 뒤의 균형 잡힌 마침표에서 끊는다(전체 폴백 아님)', () => {
      const content = '**Summary. Done** 계속되는 문장입니다. 셋째 문장.';
      const lead = extractLeadSentence(content);
      expect(lead).toBe('Summary. Done 계속되는 문장입니다.');
      expect(lead).not.toContain('셋째');
    });
  });

  // story #3030 — 카디르 #3448 재QA 중 codex 비차단 발견②: 삼중별표(***bold+italic***)를
  // 기존 굵게(**) 정규식이 안쪽 2개만 소비해 바깥쪽에 별표 1개씩 잔존시켰다.
  describe('story #3030 — 삼중별표(bold+italic) 스트립', () => {
    it('***bold+italic***을 낱개 별표 잔존 없이 완전히 벗긴다', () => {
      expect(extractLeadSentence('***강조된 문장***입니다')).toBe('강조된 문장입니다');
    });

    it('삼중별표 뒤에 일반 굵게가 이어져도 각각 정확히 스트립된다(회귀 0)', () => {
      expect(extractLeadSentence('***매우 중요*** 그리고 **일반 강조**도 있다'))
        .toBe('매우 중요 그리고 일반 강조도 있다');
    });
  });

  // story #3080(선생님 실사용 발견) — entity 참조 토큰이 안 벗겨져 raw `[라벨](entity:...)`
  // 그대로 접힌 프리뷰에 노출됐다(스크린샷 실물). stripInlineMarkers가 볼드/코드만 다루고
  // 참조 링크 문법은 처음부터 대상 밖이었다.
  describe('story #3080 — entity 참조 토큰 스트립(라벨만 남기고 문법 벗김)', () => {
    it('[라벨](entity:type:uuid)에서 라벨만 남는다', () => {
      const uuid = '11111111-1111-1111-1111-111111111111';
      expect(extractLeadSentence(`작업 완료 — [스토리 제목](entity:story:${uuid}) 확認했는.`))
        .toBe(`작업 완료 — 스토리 제목 확認했는.`);
    });

    it('라벨 자체가 대괄호를 포함해도(팀 관례 "[P0·...] 제목") 백슬래시 이스케이프가 원복된다', () => {
      const uuid = '22222222-2222-2222-2222-222222222222';
      const raw = `[\\[P0·재질\\] 코너컷 처분](entity:story:${uuid}) 완주했는.`;
      expect(extractLeadSentence(raw)).toBe('[P0·재질] 코너컷 처분 완주했는.');
    });

    it('한 줄에 참조가 여럿이어도 전부 벗겨진다', () => {
      const a = '11111111-1111-1111-1111-111111111111';
      const b = '22222222-2222-2222-2222-222222222222';
      const raw = `[문서A](entity:doc:${a})와 [문서B](entity:doc:${b}) 둘 다 확認했는.`;
      expect(extractLeadSentence(raw)).toBe('문서A와 문서B 둘 다 확認했는.');
    });

    it('라벨 안에 중첩된 볼드도 함께 벗겨진다(볼드 스트립이 먼저 돌아야 함)', () => {
      const uuid = '33333333-3333-3333-3333-333333333333';
      expect(extractLeadSentence(`[**강조 제목**](entity:story:${uuid}) 처리됨.`))
        .toBe('강조 제목 처리됨.');
    });

    it('참조 토큰 중간에 마침표가 걸리면(마커 불균형) 전체 폴백으로 원문이 안전하게 보존된다', () => {
      // 대괄호 균형이 깨지는 절단 지점(마침표가 라벨 안에 있음)은 건너뛰고 문자열 끝까지 간다
      // — #3030과 동형의 "미절단 폴백" 정직 측 원칙(진짜 온전한 참조 토큰이 최종적으로 스트립됨).
      const uuid = '44444444-4444-4444-4444-444444444444';
      const raw = `[문장. 안에 마침표가 있는 라벨](entity:story:${uuid}) 뒤이어지는 내용.`;
      const lead = extractLeadSentence(raw);
      expect(lead).not.toContain('[문장');
      expect(lead).not.toContain('](entity:');
      expect(lead).toBe('문장. 안에 마침표가 있는 라벨 뒤이어지는 내용.');
    });

    it('라벨 내부 이스케이프(\\]) 다음에 마침표가 오면 조기 절단으로 오판하지 않는다(story #3486 카디르 QA #3448 재발견 — isBalancedCut 이스케이프 미처리)', () => {
      // 카디르 재현: 원문 세는 대괄호 카운트가 `\]`를 실제 닫는 대괄호로 착각해 "[label \]."
      // 에서 조기 절단 → entity 토큰 정규식과 안 맞아 raw `[label \].`가 그대로 샌다.
      const uuid = '55555555-5555-5555-5555-555555555555';
      const raw = `[label \\]. rest](entity:story:${uuid}) next.`;
      const lead = extractLeadSentence(raw);
      expect(lead).not.toContain('[label');
      expect(lead).not.toContain('](entity:');
      expect(lead).toBe('label ]. rest next.');
    });
  });
});

describe('extractTopLevelItems (story #ec57c80c — 최상위 목록만, 하위/표/산문 제외)', () => {
  it('볼드 단독 라인(섹션 헤더)을 최상위 항목으로 뽑는다', () => {
    const raw = '**개요**\n본문\n**① 첫 항목 — PASS**\n- 하위 상세\n**② 둘째 항목 — PASS**';
    const items = extractTopLevelItems(raw);
    expect(items.map((i) => i.text)).toEqual(['개요', '① 첫 항목 — PASS', '② 둘째 항목 — PASS']);
  });

  it('들여쓰기된 하위 불릿은 최상위 목록에서 제외한다(들여쓰기 0만 최상위)', () => {
    const raw = '- 최상위 항목\n  - 들여쓴 하위 항목\n\t- 탭 들여쓴 항목';
    expect(extractTopLevelItems(raw).map((i) => i.text)).toEqual(['최상위 항목']);
  });

  it('표(| ... |) 행은 목록 항목으로 뽑지 않는다', () => {
    const raw = '- 목록 항목\n| 열1 | 열2 |\n|---|---|\n| 값1 | 값2 |';
    expect(extractTopLevelItems(raw).map((i) => i.text)).toEqual(['목록 항목']);
  });

  it('산문 문단(볼드도 불릿도 아닌 줄)은 목록에 안 들어간다', () => {
    const raw = '그냥 산문 설명입니다.\n계속되는 설명.';
    expect(extractTopLevelItems(raw)).toEqual([]);
  });
});

describe('deriveVerdictTone (story #5c29454b — 판정 dot 색, 모호=중립 안전측)', () => {
  it('PASS/승인/완료만 있으면 success', () => {
    expect(deriveVerdictTone('**결과 — PASS**')).toBe('success');
    expect(deriveVerdictTone('선생님이 승인했는')).toBe('success');
    expect(deriveVerdictTone('작업 완료')).toBe('success');
  });

  it('FAIL/반려만 있으면 destructive', () => {
    expect(deriveVerdictTone('**결과 — FAIL**')).toBe('destructive');
    expect(deriveVerdictTone('사유 없이 반려됐는')).toBe('destructive');
  });

  it('둘 다 없거나 둘 다 있으면(모호) neutral', () => {
    expect(deriveVerdictTone('그냥 진행 상황 업데이트')).toBe('neutral');
    expect(deriveVerdictTone('이전엔 반려였는데 이번엔 승인')).toBe('neutral');
  });
});

describe('extractNextAction (story #5c29454b — 다음 행동, no-fiction 보수 패턴)', () => {
  it('"다음: ..." 구분자가 있으면 뒤의 문구를 verbatim으로 뽑는다', () => {
    expect(extractNextAction('본문\n다음: 카디르군 QA 요청')).toBe('카디르군 QA 요청');
  });

  it('"다음 행동: ..." / "→ 다음 ..." / "Next: ..." 변형도 매치한다', () => {
    expect(extractNextAction('다음 행동: PR 머지')).toBe('PR 머지');
    expect(extractNextAction('→ 다음: 배포 확인')).toBe('배포 확인');
    expect(extractNextAction('Next: review needed')).toBe('review needed');
  });

  it('구분자 없는 «다음»(사인오프·타맥락)은 매치하지 않는다(오분류 방지)', () => {
    expect(extractNextAction('다음 오는 것 잇는')).toBeNull();
    expect(extractNextAction('다음 재호출 시 반영되는')).toBeNull();
    expect(extractNextAction('다음 차례에 처리하는')).toBeNull();
  });

  it('구분자 자체가 없으면 null(지어내지 않음)', () => {
    expect(extractNextAction('그냥 평범한 보고문입니다.')).toBeNull();
  });

  it('여러 줄이 매치되면 마지막(결론) 매치를 채택한다', () => {
    const raw = '다음: 초안\n중간 내용\n다음: 최종 확定 — 배포 진행';
    expect(extractNextAction(raw)).toBe('최종 확定 — 배포 진행');
  });

  it('마크다운 마커는 스트립된 verbatim 텍스트로 나온다', () => {
    expect(extractNextAction('다음: **PR#3541** 머지')).toBe('PR#3541 머지');
  });
});

describe('computeReportDensity (story #ec57c80c — 통합, 발동 게이트)', () => {
  it('발동 조건 미충족이면 null(호출부가 기존 렌더로 폴백)', () => {
    expect(computeReportDensity('짧은 메시지', 'result')).toBeNull();
  });

  it('발동 조건 충족 시 kicker/리드/목록 전부 채운다', () => {
    const raw = [
      '**전체 판정 — PASS**',
      '오늘 배포한 3개 표면 전부 실측 완료.',
      '**① 3009 — PASS**',
      '- 인라인 카드 elev-card 토큰 확認',
      '**② 3010 — PASS**',
      '- inbox Bot칩 확認',
      '**③ 3011 — PASS**',
      '- Workcell 잘림 fix 확認',
    ].join('\n');
    const result = computeReportDensity(raw, 'result');
    expect(result).not.toBeNull();
    expect(result!.kicker).toBe('판정');
    expect(result!.lead).toBe('전체 판정 — PASS');
    // 첫 줄(리드로 이미 쓴 볼드 헤더)은 목록에서 중복 제거된다 — ①②③만 남는다.
    expect(result!.topLevelItems.map((i) => i.text)).toEqual([
      '① 3009 — PASS', '② 3010 — PASS', '③ 3011 — PASS',
    ]);
  });

  // 실렌더 격리 harness(next build 실 CSS 번들)로 스크린샷 대조 중 실제로 잡힌 결함 —
  // 첫 줄이 볼드 헤더면 extractLeadSentence와 extractTopLevelItems가 같은 줄을 각자
  // 독립적으로 뽑아 리드와 목록 첫 항목이 화면에 그대로 중복 노출됐다.
  it('첫 줄이 볼드 헤더면 리드와 동일 텍스트가 목록에 중복되지 않는다(실렌더로 적발된 회귀)', () => {
    const raw = [
      '**요약 문장입니다**',
      '**두 번째 헤더**',
      '- 상세 1',
      '**세 번째 헤더**',
      '- 상세 2',
      '**네 번째 헤더**',
      '- 상세 3',
      '- 상세 4',
    ].join('\n');
    const result = computeReportDensity(raw, null);
    expect(result).not.toBeNull();
    expect(result!.lead).toBe('요약 문장입니다');
    expect(result!.topLevelItems.map((i) => i.text)).toEqual(['두 번째 헤더', '세 번째 헤더', '네 번째 헤더']);
    expect(result!.topLevelItems.some((i) => i.text === result!.lead)).toBe(false);
  });

  it('story #5c29454b — verdictTone/nextAction도 함께 채운다', () => {
    const raw = [
      '**전체 판정 — PASS**',
      '오늘 배포한 3개 표면 전부 실측 완료.',
      '**① 3009 — PASS**',
      '- 인라인 카드 elev-card 토큰 확認',
      '**② 3010 — PASS**',
      '- inbox Bot칩 확認',
      '**③ 3011 — PASS**',
      '- Workcell 잘림 fix 확認',
      '다음: 유나군 design 게이트 대기',
    ].join('\n');
    const result = computeReportDensity(raw, 'result');
    expect(result!.verdictTone).toBe('success');
    expect(result!.nextAction).toBe('유나군 design 게이트 대기');
  });

  it('story #5c29454b — «다음» 구분자가 원문에 없으면 nextAction=null(지어내지 않음)', () => {
    const raw = [
      '**전체 판정 — PASS**',
      '오늘 배포한 3개 표면 전부 실측 완료.',
      '**① 3009 — PASS**',
      '- 인라인 카드 elev-card 토큰 확認',
      '**② 3010 — PASS**',
      '- inbox Bot칩 확認',
      '**③ 3011 — PASS**',
      '- Workcell 잘림 fix 확認',
    ].join('\n');
    const result = computeReportDensity(raw, 'result');
    expect(result!.nextAction).toBeNull();
  });
});
