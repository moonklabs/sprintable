/**
 * story #ec57c80c(v2 3호, 아티팩트 2fdc81aa) — 채팅 report성 메시지 밀도 변환. 소스(메시지
 * content)는 무변경 — 렌더 시점 표현 변환만. 리라이트·요약 생성 절대 금지(no-fiction) —
 * kicker·리드·목록 항목은 전부 원문 substring(마크다운 기호 strip 결과)이지 생성 텍스트가
 * 아니다.
 */
import { unescapeReferenceLabel } from '@/components/chat/entity-ref';

export type MessageKind = 'request' | 'handoff' | 'result' | 'ack';

const MESSAGE_KIND_LABEL: Record<MessageKind, string> = {
  request: '요청', handoff: '핸드오프', result: '판정', ack: '확인',
};

// story #5c29454b — 판정 dot 게이팅용(호출부가 density.kicker와 문자열 비교). 이 라벨은
// i18n 대상이 아니다(위 MESSAGE_KIND_LABEL 전체가 그렇듯 이 파일은 로케일 무관 내부 상수).
export const RESULT_KICKER_LABEL = MESSAGE_KIND_LABEL.result;

// story #2985 — FE ChatMessage.message_kind는 BE 계약을 앞서 좁히지 않으려 `string | null`로
// 느슨하게 타입돼 있다(이 세션의 다른 필드들과 동일 관례). 4-enum 소속 여부는 여기서
// 런타임으로만 판별한다 — 구서버·오염값은 항상 안전하게 폴백(무표시 또는 휴리스틱)한다.
function asMessageKind(value: string | null | undefined): MessageKind | null {
  return value != null && Object.hasOwn(MESSAGE_KIND_LABEL, value) ? (value as MessageKind) : null;
}

// PO 감確認 지점(발동 임계값) — 과폴딩(클릭 피로) vs 벽(스캔 불가) 트레이드오프 튜닝이
// 필요하면 이 두 상수만 바꾼다. 아티팩트 2fdc81aa ⓒ 실측(실 대화 250px+ 메시지·>400자
// 요소 다수)을 참고해 잡은 초기값.
export const REPORT_DENSITY_MIN_LINES = 8;
export const REPORT_DENSITY_MIN_CHARS = 400;

function stripInlineMarkers(text: string): string {
  return text
    // story #3030 — 삼중별표(***bold+italic***)는 아래 굵게(**) 패턴이 먼저 잡으면 한
    // 쪽에 별표 하나씩 잔존한다(`**`가 안쪽 2개만 소비, 바깥쪽 1개씩 남음) — 굵게보다
    // 먼저 3개짜리를 통째로 벗겨야 한다.
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    // story #3080(선생님 실사용 발견) — entity 참조 토큰 `[라벨](entity:type:uuid)`이 안
    // 벗겨져 접힌 프리뷰에 원문 그대로(백슬래시 이스케이프 포함) 노출됐다. 이 팀 스토리
    // 제목 관례("[P0·...] 제목")상 라벨 자체가 대괄호를 포함하는 경우가 흔해, 자동 참조
    // 링커가 라벨 내부 대괄호를 `\[`/`\]`로 이스케이프해 저장한다 — 그 이스케이프까지
    // 원복해 라벨만 남긴다(no-fiction: 원문 라벨 그대로, 참조 문법만 벗김). 볼드/코드
    // 스트립보다 반드시 뒤에 와야 한다 — 라벨 안에 중첩된 `**`가 먼저 벗겨져 있어야
    // 정확한 라벨을 얻는다(반대 순서면 `[**title**](entity:...)`의 라벨에 `**`가 남는다).
    .replace(/\[((?:\\.|[^[\]\\])*)\]\(entity:\w+:[0-9a-f-]+\)/gi, (_m, label: string) => unescapeReferenceLabel(label))
    .trim();
}

/** 긴 report성 메시지인지(발동 조건) — N줄 이상 또는 N자 이상. 짧은 대화는 항상 false. */
export function isReportDense(content: string): boolean {
  const lineCount = content.split('\n').filter((l) => l.trim().length > 0).length;
  return lineCount >= REPORT_DENSITY_MIN_LINES || content.length >= REPORT_DENSITY_MIN_CHARS;
}

// message_kind 없을 때만 도는 보수적 구조 폴백 — 확실한 판정 어휘(이 팀 실사용 관례:
// PASS/FAIL/REQUEST_CHANGES)가 볼드 라인에 있을 때만 kicker를 단다. 그 외(모호)는 전부
// 미표시 — 오분류 kicker는 지어냄이라 미표시가 항상 안전측(story AC2).
const VERDICT_PATTERN = /\*\*[^*]*\b(PASS|FAIL|REQUEST_CHANGES)\b[^*]*\*\*/;

// story #5c29454b(③ result 카드, doc result-card-final-spec-5c29454b) — 판정 dot 색.
// «확실한 어휘»일 때만 색을 준다(모호=중립 dot, 오분류=지어냄이라 안전측 폴백). 두 신호가
// 동시에 있으면(예: 전/후 상태가 섞인 요약) 어느 한쪽으로 단정 못 하니 중립.
export type VerdictTone = 'success' | 'destructive' | 'neutral';

const SUCCESS_WORDS = /\bPASS\b|승인|완료/;
const DESTRUCTIVE_WORDS = /\bFAIL\b|반려/;

export function deriveVerdictTone(content: string): VerdictTone {
  const hasSuccess = SUCCESS_WORDS.test(content);
  const hasDestructive = DESTRUCTIVE_WORDS.test(content);
  if (hasSuccess && !hasDestructive) return 'success';
  if (hasDestructive && !hasSuccess) return 'destructive';
  return 'neutral';
}

// story #5c29454b — 「다음 행동」 추출. 보수 패턴(구분자 명시 필요) — 「다음 오는 것」·
// 「다음 재호출 시」·「다음 차례」류 구분자 없는 «다음»은 애초에 매치 안 된다(오분류 방지,
// doc §③ 제외 목록). 여러 줄이 매치되면 마지막(가장 나중에 오는=결론) 매치를 채택한다.
const NEXT_ACTION_PATTERNS: RegExp[] = [
  /다음\s*[:=]\s*(.+)/,
  /→\s*다음[\s:]\s*(.+)/,
  /다음\s*행동\s*[:=]?\s*(.+)/,
  /[Nn]ext\s*:\s*(.+)/,
];

/** 원문에 명시적 「다음: ...」류 구분자가 있을 때만 추출(verbatim substring). 없으면
 * null(미표시 — kicker 보수 폴백과 동형 no-fiction 원칙). */
export function extractNextAction(content: string): string | null {
  let found: string | null = null;
  for (const line of content.split('\n')) {
    for (const pattern of NEXT_ACTION_PATTERNS) {
      const m = line.match(pattern);
      if (m?.[1]) {
        found = stripInlineMarkers(m[1]);
        break;
      }
    }
  }
  return found || null;
}

/** kicker 라벨. 1차 소스=message_kind(있으면 그걸로 확定), 없으면 보수적 패턴 폴백,
 * 그것도 아니면 null(미표시 — 지어내지 않음). */
export function deriveKicker(content: string, messageKind?: string | null): string | null {
  const kind = asMessageKind(messageKind);
  if (kind) return MESSAGE_KIND_LABEL[kind];
  if (VERDICT_PATTERN.test(content)) return '판정';
  return null;
}

// 카디르 QA(#3448) 적출 — "**Summary. Done**"류에서 문장 경계(마침표)가 볼드 스팬
// 중간에 떨어지면 절단 결과가 "**Summary."(닫는 ** 없음)가 돼 미완성 마커가 그대로
// 화면에 샌다. 굵게·인라인코드 마커(짝수 개수) 균형이 안 맞는 절단은 "미절단 폴백"(정직
// 측)으로 건너뛴다.
// story #3080 — entity 참조 토큰(`[라벨](entity:...)`)도 같은 결함 클래스: 마침표가 토큰
// 중간(라벨 안·href 안)에 떨어지면 절단 결과가 여는 대괄호만 남은 `[라벨 일부`가 그대로
// 샌다. 대괄호 개수 균형도 함께 본다 — 같은 "미절단 폴백" 정직 측 원칙 재사용.
// story #3486(카디르 QA #3448 재발견) — 이 함수는 stripInlineMarkers(42행) 적용 前 원문
// 위에서 세는데, 라벨 안 리터럴 대괄호를 이스케이프한 `\[`/`\]`(42행 관례)를 실제 여닫는
// 대괄호로 착각해 균형을 오판한다("[label \]. rest]..."가 "\]"까지만 보고 1:1로 착각) —
// 카운트용 사본에서 백슬래시 이스케이프 시퀀스부터 걷어낸다(42행의 원복과 달리 여기선
// 문법 문자로도 안 세야 하므로 통째로 제거).
function isBalancedCut(text: string): boolean {
  const unescaped = text.replace(/\\./g, '');
  const boldCount = (unescaped.match(/\*\*/g) ?? []).length;
  const codeCount = (unescaped.match(/`/g) ?? []).length;
  const openBracket = (unescaped.match(/\[/g) ?? []).length;
  const closeBracket = (unescaped.match(/\]/g) ?? []).length;
  return boldCount % 2 === 0 && codeCount % 2 === 0 && openBracket === closeBracket;
}

/** 첫 문장을 verbatim으로 추출(리라이트 0). 문장 경계 = 마침표/느낌표/물음표+공백(또는
 * 문자열 끝) 또는 첫 줄바꿈 중 먼저 오는 지점 — report 메시지는 첫 줄이 이미 한 논지인
 * 경우가 많아(볼드 헤더 라인 관례) 줄바꿈도 유효한 경계로 취급한다. 두 경계 다 마커
 * (굵게·인라인코드)를 반으로 가르면 더 늦은(안전한) 경계로, 그마저 없으면 전체로
 * 폴백한다(「미절단 폴백」— 정직 측, 미완성 마커 노출 방지). */
export function extractLeadSentence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  const newlineIdx = trimmed.indexOf('\n');
  // story #3030 — 예전엔 .match()(non-global)라 마침표 후보가 첫 하나뿐이었다. 그 첫
  // 마침표가 마커 불균형 지점에 떨어지면(예: "**Summary. Done** 이어지는 문장.") 뒤에
  // 더 이른(=더 짧은) 균형 잡힌 경계가 있어도 못 찾고 바로 전체 폴백으로 건너뛰었다 —
  // matchAll로 전 구간 후보를 모아 그중 가장 이른 균형 경계를 채택한다.
  const puncIndices = [...trimmed.matchAll(/[.!?](?:\s|$)/g)]
    .map((m) => m.index)
    .filter((idx): idx is number => idx !== undefined)
    .map((idx) => idx + 1);

  const candidates = [...puncIndices, newlineIdx].filter((n) => n !== -1).sort((a, b) => a - b);
  const end = candidates.find((c) => isBalancedCut(trimmed.slice(0, c))) ?? trimmed.length;

  return stripInlineMarkers(trimmed.slice(0, end));
}

export interface TopLevelListItem {
  text: string;
}

/** 최상위 섹션만 뽑는다. report 메시지 관례상 볼드 단독 라인(섹션 헤더)이 있으면 그
 * 헤더들이 최상위 구조 그 자체이고, 그 아래 들여쓰기 없는 대시 불릿은 헤더에 딸린
 * "하위 상세"다(전문 보기로 접힘) — 헤더가 하나도 없을 때만 들여쓰기 0의 최상위
 * 불릿(-/*) 자체를 목록으로 쓴다(단순 평문 목록 메시지 대응). 표·산문 문단·들여쓰기된
 * 하위 내용은 어느 경우든 대상 밖(원문은 그대로 「전문 보기」에 남는다 — 정보 소실 0,
 * 이 함수는 무엇을 미리 보여줄지만 고르지 원문을 바꾸지 않는다). */
export function extractTopLevelItems(content: string): TopLevelListItem[] {
  const lines = content.split('\n');
  const boldHeaders: TopLevelListItem[] = [];
  for (const line of lines) {
    const boldOnly = line.match(/^\*\*([^*]+)\*\*\s*$/);
    if (boldOnly) boldHeaders.push({ text: stripInlineMarkers(boldOnly[1]!) });
  }
  if (boldHeaders.length > 0) return boldHeaders;

  const bullets: TopLevelListItem[] = [];
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) bullets.push({ text: stripInlineMarkers(bullet[1]!) });
  }
  return bullets;
}

export interface ReportDensity {
  kicker: string | null;
  lead: string;
  topLevelItems: TopLevelListItem[];
  // story #5c29454b — kicker가 «판정»일 때만 의미 있다(호출부가 그 조건으로 게이팅).
  verdictTone: VerdictTone;
  nextAction: string | null;
}

/** 발동 조건(isReportDense) 미충족이면 null — 호출부는 null이면 기존 렌더를 그대로 쓴다
 * (짧은 대화 무변경, story AC1). */
export function computeReportDensity(content: string, messageKind?: string | null): ReportDensity | null {
  if (!isReportDense(content)) return null;
  const lead = extractLeadSentence(content);
  // report 메시지 첫 줄이 그 자체로 볼드 섹션 헤더인 경우(예: "**전체 판정 — PASS**"),
  // extractLeadSentence와 extractTopLevelItems가 같은 줄을 각자 독립적으로 뽑아 리드와
  // 목록 첫 항목이 그대로 중복된다 — 리드로 이미 쓴 항목은 목록에서 제외한다.
  const topLevelItems = extractTopLevelItems(content).filter((item) => item.text !== lead);
  return {
    kicker: deriveKicker(content, messageKind),
    lead,
    topLevelItems,
    verdictTone: deriveVerdictTone(content),
    nextAction: extractNextAction(content),
  };
}
