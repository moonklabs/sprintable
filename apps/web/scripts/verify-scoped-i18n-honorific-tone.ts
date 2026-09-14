/**
 * story #3877 AC3 — 선생님 경로(오늘·일감 5탭·우패널·문서·스토리 패널+임베드) i18n
 * 스코프 키의 ko.json 값에 합니다체(「습니다」·「ㅂ니다」·「십시오」)가 새로 섞여 드는
 * 것을 막는다.
 *
 * 배경: doc `[UX-v3] §⑤ 낱말 드리프트 감사` §4①(미르코 그라운딩, story #3877 AC1에서
 * develop HEAD 재실측·0건 diff 확認)이 이 스코프의 합니다체 94키(140개 소비처, namespace
 * 정밀 대조 — leaf 키 이름이 같아도 실제 소비 t() 변수의 useTranslations() 선언까지
 * 추적해 스코프 밖 화면은 걸렀다)를 실측했고, 이 스토리가 그 전부와 orgBriefing 9키
 * (AC4)를 해요체로 전량 이관했다 — 총 103키.
 *
 * ⚠️scope는 **namespace 전체가 아니라 정확히 이 103키**다(SCOPED_KEYS). namespace
 * 통째로 스캔하면(예: `cage`·`goals`·`standup`) Mirko 감사가 의도적으로 거른 스코프 밖
 * 화면의 기존 합니다체 값(예: `cage.gateDetailNotFound`·`goals.createError`·
 * `standup.loadFailed` 등 78건 실측)까지 baseline 0을 요구하게 돼 이 스토리가 안 건드린
 * 자리에서 거짓 RED가 난다 — namespace는 "어디서 이 키들을 찾았나"의 분류 메타데이터일
 * 뿐, 판정 축은 항상 키 단위다. AC1 표가 "AC2·AC3의 판별선"(페드루 PO 확定)이라는 게
 * 정확히 이 뜻이다. 다음 카드가 스코프를 넓히면 SCOPED_KEYS에 새 키를 추가한다(namespace
 * 째 추가 아님).
 *
 * 판정 축은 값(value)만이다 — 키 이름·주석은 대상이 아니다(한자 가드·agent-tone 가드와
 * 동일 원칙).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
const KO_FILE = 'ko.json';

// story #3877 AC1 표(doc 5590a4c5 §4①, develop f35a59d46c에서 재실측·0건 diff) 94키 +
// AC4가 소비처 有로 확認해 편입한 orgBriefing 9키 = 103키. "namespace.leafKey" 형식.
// 확장 시 이 배열에 새 키를 추가한다(namespace를 통째로 추가하지 않는다 — 위 헤더 참고).
export const SCOPED_KEYS = [
  'board.acSaveFailed',
  'board.assigneeNotSetTitle',
  'board.backlinksTargetGone',
  'board.createStoryFailed',
  'board.deleteStoryDialogBody',
  'board.descriptionSaveFailed',
  'board.dispatchFailedBody',
  'board.dispatchFailedTitle',
  'board.dispatchSuccessTitle',
  'board.kickoffConflict',
  'board.kickoffError',
  'board.kickoffNoMatch',
  'board.kickoffTriggered',
  'board.noActivity',
  'board.noComments',
  'board.noStories',
  'board.noTasks',
  'board.originNotCollected',
  'board.realtimeAssigneeChanged',
  'board.realtimePositionChanged',
  'board.realtimeStatusChanged',
  'board.rejectedRelationsRestoreErrorFallback',
  'board.rejectedRelationsRestored',
  'board.rejectedRelationsTargetGone',
  'board.storyMoveFailed',
  'board.titleSaveFailed',
  'board.transitionViolation',
  'cage.fallbackNotifyError',
  'cage.fallbackNotifySuccess',
  'cage.gateTransitionError',
  'cage.sigEvidenceViewedLabel',
  'cage.withdrawError',
  'cage.withdrawIrreversibleWarning',
  'cage.withdrawSuccess',
  'canvas.artifactCreateFailed',
  'canvas.emptyHint',
  'canvas.emptyTitle',
  'canvas.saveFailedNote',
  'docs.attachImageUnavailable',
  'docs.createFailed',
  'docs.deleteFailed',
  'docs.docGateApproverPickerDuplicateWarning',
  'docs.docGateTransitionErrorGeneric',
  'docs.docTreeDeleteBody',
  'docs.indexLoadError',
  'docs.indexNoResults',
  'docs.moveCircularError',
  'docs.moveFailed',
  'docs.movePermissionError',
  'docs.moveSortModeActiveError',
  'docs.newFolderCreateFailed',
  'docs.notFound',
  'docs.renameFailed',
  'docs.reorderFailed',
  'docs.statusConflict',
  'docs.statusRemoteChanged',
  'goals.declareL1LoadError',
  'goals.transitionFailedFallback',
  'hypotheses.noLinked',
  'hypotheses.pickerEmpty',
  'orgBriefing.clusterUnclosedOutcomeMissingTitle',
  'orgBriefing.clusterUnclosedOverdueGoalTitle',
  'orgBriefing.clusterUnclosedOverdueHypothesisTitle',
  'orgBriefing.decideBlockerContext',
  'orgBriefing.decideGateContext',
  'orgBriefing.decideReviewContext',
  'orgBriefing.signalAgentStuckContext',
  'orgBriefing.signalBlockerContext',
  'orgBriefing.signalHypothesisFalsifiedTitle',
  'retro.addActionFailed',
  'retro.addItemFailed',
  'retro.advanceFailed',
  'retro.discussNotesHint',
  'retro.exportCopied',
  'retro.exportFailed',
  'retro.groupFailed',
  'retro.hEmptyNone',
  'retro.loadFailed',
  'retro.mergeHint',
  'retro.noActions',
  'retro.noItems',
  'retro.recAdoptFailed',
  'retro.synthesisEditHint',
  'retro.synthesisGenerateFailed',
  'retro.voteFailed',
  'share.shareToWebDesc',
  'sprints.activateError',
  'sprints.assignError',
  'sprints.closeError',
  'sprints.createError',
  'sprints.declareL1LoadError',
  'sprints.deleteConfirmBody',
  'sprints.deleteError',
  'sprints.loadMoreError',
  'sprints.noSprintStories',
  'sprints.unassignError',
  'standup.actionFailed',
  'standup.bridgeLoadFailed',
  'standup.bridgeMoreResults',
  'standup.bridgeNoStories',
  'standup.bridgeSearchNoResults',
  'standup.noEntries',
  'standup.noFeedback',
] as const;

// 「습니다」·「십시오」는 완성형(NFC) 원문에 그대로 리터럴로 존재한다(자음어간 종결 — 예:
// 「없습니다」는 습·니·다 3음절이 그대로 붙어 있다). 「ㅂ니다」(모음어간+ㅂ니다, 예: 「합니다」
// ·「됩니다」)는 다르다 — 그 ㅂ은 앞 음절의 **받침**으로 합쳐진 한 글자(합/됩/갑)라, NFC
// 원문엔 독립된 「ㅂ」 자모 문자가 없다. NFD(자모 분해)로 정규화하면 그 받침이
// U+11B8(HANGUL JONGSEONG PIEUP)로 분리돼 나오므로, 분해된 「니다」(U+1102 U+1175 U+1103
// U+1161)와 이어 붙었는지로 잡는다 — 실측 확認(합니다·됩니다·갑니다·입니다 전부 검출).
const NFD_JONGSEONG_B_NIDA = 'ᆸ니다';

function matchesFormalRegister(value: string): string[] {
  const matches: string[] = [];
  const literalMatches = value.match(/습니다|십시오/g);
  if (literalMatches) matches.push(...literalMatches);
  // 습니다 자체가 이미 받침ㅂ(습=스+ㅂ)을 포함해 NFD 검사에도 걸린다 — 습니다/십시오로 이미
  // 잡힌 값은 중복 태그(「습니다」+「ㅂ니다」 동시 표시)를 피하려 ㅂ니다 검사를 건너뛴다.
  // 「합니다」·「됩니다」처럼 습니다/십시오가 전혀 없는 순수 모음어간 케이스만 ㅂ니다로 잡는다.
  if (matches.length === 0 && value.normalize('NFD').includes(NFD_JONGSEONG_B_NIDA)) {
    matches.push('ㅂ니다');
  }
  return matches;
}

export interface HonorificToneException {
  key: string;
  match: string;
  reason: string;
  addedBy: string;
}

// story #3877 baseline — 0건(이 스토리가 SCOPED_KEYS 103개 전부를 해요체로 이관). 새로
// 느는 자리만 이 가드가 막는다(can-only-shrink, 이 저장소 baseline 가드 공통 계약). 정말
// 필요하면 key·match·reason·addedBy를 모두 채워야 등록된다(한자 가드 관례 그대로).
export const HONORIFIC_TONE_EXCEPTIONS: HonorificToneException[] = [];

function isExempt(key: string, match: string): boolean {
  return HONORIFIC_TONE_EXCEPTIONS.some((e) => e.key === key && e.match === match);
}

export interface HonorificToneFinding {
  key: string;
  matches: string[];
  value: string;
}

function getByPath(root: Record<string, unknown>, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, root);
}

export function findHonorificToneInScopedKeys(
  ko: Record<string, unknown>,
  keys: readonly string[] = SCOPED_KEYS,
): HonorificToneFinding[] {
  const findings: HonorificToneFinding[] = [];
  for (const key of keys) {
    const value = getByPath(ko, key);
    if (typeof value !== 'string') continue; // 키가 없거나(리팩터) 문자열이 아니면 이 가드의 관심사 아님.
    const found = matchesFormalRegister(value);
    if (found.length === 0) continue;
    const matches = [...new Set(found)].filter((m) => !isExempt(key, m));
    if (matches.length > 0) {
      findings.push({ key, matches, value });
    }
  }
  return findings;
}

function main(): void {
  const text = readFileSync(path.join(MESSAGES_DIR, KO_FILE), 'utf8');
  const ko = JSON.parse(text) as Record<string, unknown>;
  const findings = findHonorificToneInScopedKeys(ko);

  if (findings.length > 0) {
    console.log(`❌ 스코프 키(${SCOPED_KEYS.length}개)의 ko.json 값에 합니다체 ${findings.length}건 발견:`);
    for (const f of findings) {
      console.log(`  - ${f.key} [${f.matches.join(', ')}] → ${JSON.stringify(f.value)}`);
    }
    console.log(
      '\n→ story #3877(선생님 경로 라이팅 톤) 스코프다. 토스 스타일 해요체로 고쳐라' +
        '(doc a699be00 §⑤ 톤 표 참고). 정말 예외가 필요하면 HONORIFIC_TONE_EXCEPTIONS에' +
        ' key·match·reason·addedBy를 모두 채워 등록해라.',
    );
    process.exit(1);
  }

  console.log(`OK: 스코프 키(${SCOPED_KEYS.length}개)의 ko.json 값에 합니다체 0건`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
