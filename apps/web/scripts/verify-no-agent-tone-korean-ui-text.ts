/**
 * story #3824 AC1(페드루 PO 確定, 2026-09-13 01:42Z) — `messages/ko.json` 사용자 문구 값에
 * 작업 대화·내부 말투에서 쓰는 표현(「붙임」·「붙이(다)」·「딸깍」류 — 사람이 손으로 조작하는
 * 동작을 구어체·의성어로 서술하는 낱말)이 정본 문구로 새는 것을 막는다. 이 카드 자체의 신규
 * 낱말(사이드바 라벨)은 전부 명사라 이 축엔 영향이 없지만(PO: "사이드바 라벨은 명사라 영향
 * 0"), PO가 이 카드 AC1에 이 가드 신설을 못박아 `verify-no-hanja-in-i18n.ts` 옆에 같은
 * 구조로 추가한다(같은 "값만 판정·재귀 walk·file+key+match 예외" 기전 — 새 기전 발명 금지).
 *
 * 판정 축은 값(value)만이다 — 키 이름·주석은 대상이 아니다(한자 가드와 동일 원칙: 화면에
 * 뜨는 것은 값뿐).
 *
 * AGENT_TONE_EXCEPTIONS는 **비어 있지 않게 시작한다** — 한자 가드와 달리 이 패턴은 그라운딩
 * 시점(2026-09-13) 이미 실사용 중인 8건이 있었다(전부 `붙이(다)` 계열 — 콘텐츠를 캠페인에
 * "붙이는" 기능의 기존 UI 문구, `flow`의 안내 예시 문장). 이 8건을 기존 합니다체 문자열
 * 전수 이관(카드 범위 밖, AC1 명시)과 같은 채무로 그랜드파더하고, **새로 느는 자리만** 막는다
 * (can-only-shrink — 갚으면 줄고 새 채무는 못 는다, 이 저장소의 baseline 가드 공통 계약).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
// 이 패턴은 한국어 구어체/의성어 표현이라 ko.json만 대상 — en.json엔 원리적으로 안 나온다.
const LOCALE_FILES = ['ko.json'];

const AGENT_TONE_PATTERN_GLOBAL = /붙임|붙이|딸깍/g;

export interface AgentToneException {
  file: string;
  key: string;
  match: string;
  reason: string;
  addedBy: string;
}

// story #3824 그라운딩 실측(2026-09-13) — 전부 `붙이(다)` 계열, 캠페인 첨부·flow 안내 예시
// 기존 UI 문구. 이관(합니다체→해요체 등 어조 정비)은 이 카드 범위 밖(AC1 명시) — 새 자리만 막는다.
export const AGENT_TONE_EXCEPTIONS: AgentToneException[] = [
  { file: 'ko.json', key: 'flow.guidedExampleReviewAgentStatement', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'flow.guidedStatementPlaceholder', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'content.campaignAttachLabel', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'content.campaignAttachCta', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'content.campaignAttachPendingCta', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'content.campaignAttachFailed', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'contentRules.utmRulesRowTitle', match: '붙이', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
  { file: 'ko.json', key: 'contentRules.utmRulesContentFromNone', match: '붙임', reason: 'story #3824 그라운딩 시점 기존 값 — 이관은 카드 범위 밖', addedBy: '미르코' },
];

function isExempt(file: string, key: string, match: string): boolean {
  return AGENT_TONE_EXCEPTIONS.some((e) => e.file === file && e.key === key && e.match === match);
}

export interface AgentToneFinding {
  file: string;
  key: string;
  matches: string[];
  value: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function findAgentToneInMessages(root: Record<string, unknown>, filename: string): AgentToneFinding[] {
  const findings: AgentToneFinding[] = [];

  function walk(node: unknown, prefix: string): void {
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
      return;
    }
    if (typeof node === 'string') {
      const found = node.match(AGENT_TONE_PATTERN_GLOBAL);
      if (!found) return;
      const matches = [...new Set(found)].filter((m) => !isExempt(filename, prefix, m));
      if (matches.length > 0) {
        findings.push({ file: filename, key: prefix, matches, value: node });
      }
    }
  }

  walk(root, '');
  return findings;
}

export function scanLocaleFile(filePath: string, filename: string): AgentToneFinding[] {
  const text = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return findAgentToneInMessages(parsed, filename);
}

function main(): void {
  const allFindings: AgentToneFinding[] = [];
  for (const filename of LOCALE_FILES) {
    const filePath = path.join(MESSAGES_DIR, filename);
    allFindings.push(...scanLocaleFile(filePath, filename));
  }

  if (allFindings.length > 0) {
    console.log(`❌ 사용자 문구 값에 에이전트/구어체 말투(붙임·붙이·딸깍) 새 자리 ${allFindings.length}건 발견:`);
    for (const f of allFindings) {
      console.log(`  - ${f.file} :: "${f.key}" [${f.matches.join(', ')}] → ${JSON.stringify(f.value)}`);
    }
    console.log(
      '\n→ 사람이 하는 조작을 서사체로 서술한 구어체·의성어 표현이다(붙임/붙이다/딸깍). 사용자' +
        ' 관점 문장으로 바꿔라. 그라운딩 시점 기존 8건은 baseline(AGENT_TONE_EXCEPTIONS)으로' +
        ' 그랜드파더됐다 — 새 자리만 이 가드가 막는다(can-only-shrink).',
    );
    process.exit(1);
  }

  console.log(`OK: ${LOCALE_FILES.join(', ')} 사용자 문구 값에 새 에이전트/구어체 말투(붙임·붙이·딸깍) 0건(baseline ${AGENT_TONE_EXCEPTIONS.length}건은 그랜드파더)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
