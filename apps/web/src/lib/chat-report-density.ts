/**
 * story #ec57c80c(v2 3호, 아티팩트 2fdc81aa) — 채팅 report성 메시지 밀도 변환. 소스(메시지
 * content)는 무변경 — 렌더 시점 표현 변환만. 리라이트·요약 생성 절대 금지(no-fiction) —
 * kicker·리드·목록 항목은 전부 원문 substring(마크다운 기호 strip 결과)이지 생성 텍스트가
 * 아니다.
 */

export type MessageKind = 'request' | 'handoff' | 'result' | 'ack';

const MESSAGE_KIND_LABEL: Record<MessageKind, string> = {
  request: '요청', handoff: '핸드오프', result: '판정', ack: '확인',
};

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
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
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
function isBalancedCut(text: string): boolean {
  const boldCount = (text.match(/\*\*/g) ?? []).length;
  const codeCount = (text.match(/`/g) ?? []).length;
  return boldCount % 2 === 0 && codeCount % 2 === 0;
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
  const puncMatch = trimmed.match(/[.!?](?:\s|$)/);
  const puncIdx = puncMatch && puncMatch.index !== undefined ? puncMatch.index + 1 : -1;

  const candidates = [puncIdx, newlineIdx].filter((n) => n !== -1).sort((a, b) => a - b);
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
  };
}
