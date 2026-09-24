/**
 * story #3877 AC3 — 선생님 경로(오늘·일감 5탭·우패널·문서·스토리 패널+임베드) i18n
 * 스코프 키의 ko.json 값에 합니다체(「습니다」·「ㅂ니다」·「십시오」)가 새로 섞여 드는
 * 것을 막는다.
 *
 * 배경: doc `[UX-v3] §⑤ 낱말 드리프트 감사` §4①(미르코 그라운딩, story #3877 AC1에서
 * develop HEAD 재실측·0건 diff 확認)이 이 스코프의 합니다체 94키(140개 소비처, namespace
 * 정밀 대조 — leaf 키 이름이 같아도 실제 소비 t() 변수의 useTranslations() 선언까지
 * 추적해 스코프 밖 화면은 걸렀다)를 실측했고, 이 스토리가 그 전부와 orgBriefing 9키
 * (AC4)를 해요체로 전량 이관했다(94+9=103키). AC5 실 캡처 검증 中 이 표에 없던 위반을
 * 하나 더 발견(`docs.emptyDescription` — 바로 옆 `emptyTitle`은 이미 해요체인데 같은
 * 빈-상태 카드 안에서 register가 섞여 있었다) — 그 자리에서 즉시 해요체로 고치고
 * SCOPED_KEYS에 추가해 총 104키.
 *
 * story #3916~#3926 — 위 104키 스코프를 점진적으로 네임스페이스 단위로 승격했다
 * (`honorific-scope/<ns>.json` 파일 하나당 네임스페이스 하나, story #3916 설계 —
 * 병렬 PR의 배열 append 충돌을 원천 봉쇄). 2026-09-15 13:xxZ 기준 68→74개 전체
 * 네임스페이스가 전부 승격 완료돼 "스코프=ko.json 전체"가 성립했다.
 *
 * story #3927 — 그 시점에 실측한 결함 클래스: 네임스페이스를 추가하는 PR마다
 * `honorific-scope/<ns>.json` 신설+공유 테스트 파일 append가 필요했고, 목록형은
 * "새 ns를 빠뜨리면 조용히 안 잰다"(fail-open) — 한 번 실제로 8ns·172leaf가 등록
 * 누락된 채 방치된 적이 있었다(그 ns들에 합니다체가 우연히 0건이라 안 드러났을 뿐).
 * 그래서 스코프 목록형을 폐기하고 **기본=ko.json 전체를 스캔, 예외만 명시 목록**으로
 * 뒤집었다 — 이제 새 네임스페이스가 생겨도 이 가드는 아무 편집 없이 자동으로 본다.
 * `SCOPED_NAMESPACES`·`honorific-scope/*.json`·`loadHonorificScopeDir`·
 * `checkScopedNamespaceMinimums`(네임스페이스별 leaf 하한)는 전량 삭제 — 대신 ko.json
 * **전체** leaf 수 하한 하나(`checkTotalLeafFloor`, 대량 삭제·로더 고장 감지)로 대체됐다.
 * `SCOPED_KEYS`(104개 · story #4231 3차 (b)에서 죽은 orgBriefing 5키를 빼 99개)는 삭제하지 않았다 — story #3877 원 표의 count-lock 회귀 테스트와
 * per-story 전용 테스트 파일(`*.3903/3921/3923.test.ts`)이 여전히 참조하는 레거시
 * 데이터이자, `findHonorificToneInScopedKeys`의 기본 인자 값으로 남아있다(더 이상 어떤
 * 필터링도 하지 않는다 — 이제 "스코프"는 언제나 ko.json 전체다).
 *
 * ⚠️scope는 이제 **ko.json leaf 전체**다. 값(value)이 판정 축이고, 키 이름·주석은
 * 대상이 아니다(한자 가드·agent-tone 가드와 동일 원칙). 정말 스캔에서 빼야 하는 자리
 * (법적 고지문 인용 등)는 `HONORIFIC_TONE_EXCEPTIONS`에 key·match·reason·addedBy를
 * 채워 명시 등록한다 — 등록 없이는 예외가 없다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
const KO_FILE = 'ko.json';

// story #3877 AC1 표(doc 5590a4c5 §4①) 94키 + AC4 orgBriefing 9키 + AC5 docs.emptyDescription
// 1키 = 104키(story #4231 3차 (b) — 죽은 orgBriefing decide*/signal*Context 5키 삭제로 99키). story #3927(전역 스캔 승격) 이후로는 더 이상 어떤 필터링에도 쓰이지 않는
// 레거시 데이터다 — findHonorificToneInScopedKeys의 기본 인자 값 + 회귀 count-lock 테스트
// + per-story 전용 테스트 파일(3903/3921/3923)의 "이 실 사고 키는 SCOPED_KEYS 정적 목록
// 안에 없었다"는 역사적 증거로만 남는다. 새 키를 추가하지 않는다(전역 스캔이 이미 본다).
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
  'docs.emptyDescription',
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

/** ko.json 전체(임의 객체)를 재귀 walk해 모든 string leaf의 dotted-path 키를 낸다 —
 * story #3927 전역 스캔의 유일한 소스. 네임스페이스 필터·레지스트리 조회 없음(스코프 자체가
 * "이 객체가 가진 leaf 전부"이므로). */
export function flattenAllLeafKeys(root: Record<string, unknown>): string[] {
  const keys: string[] = [];
  function walk(obj: Record<string, unknown>, prefix: string): void {
    for (const [k, v] of Object.entries(obj)) {
      const qualifiedKey = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, qualifiedKey);
      } else if (typeof v === 'string') {
        keys.push(qualifiedKey);
      }
    }
  }
  walk(root, '');
  return keys;
}

export function countAllLeaves(root: Record<string, unknown>): number {
  return flattenAllLeafKeys(root).length;
}

export interface UnsupportedLeafTypeViolation {
  key: string;
  type: string;
}

/** `flattenAllLeafKeys`와 똑같은 walk이되, 거기선 조용히 건너뛰던 자리(배열 등 문자열도
 * 객체도 아닌 leaf)를 여기선 위반으로 기록한다 — story #3932 AC6(카디르 #4335 리뷰 발견):
 * 배열 값이 `Array.isArray`에 걸려 재귀 walk도, string 분기도 안 타 통째로 무시되던 fail-open
 * 자리였다. 톤 스캔 스코프 밖으로 조용히 빠지는 leaf가 있으면 안 되므로 RED로 승격한다. */
export function findUnsupportedLeafTypes(root: Record<string, unknown>): UnsupportedLeafTypeViolation[] {
  const violations: UnsupportedLeafTypeViolation[] = [];
  function walk(obj: Record<string, unknown>, prefix: string): void {
    for (const [k, v] of Object.entries(obj)) {
      const qualifiedKey = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) {
        violations.push({ key: qualifiedKey, type: 'array' });
      } else if (v !== null && typeof v === 'object') {
        walk(v as Record<string, unknown>, qualifiedKey);
      } else if (typeof v !== 'string') {
        violations.push({ key: qualifiedKey, type: v === null ? 'null' : typeof v });
      }
    }
  }
  walk(root, '');
  return violations;
}

/** story #3877~#3926 시절엔 "SCOPED_KEYS ∪ 승격된 네임스페이스"의 합집합이었다. story
 * #3927부터는 스코프 자체가 ko.json 전체라 이 함수는 `flattenAllLeafKeys`의 얇은 별칭이다
 * — 이름은 유지한다(per-story 전용 테스트 파일·이 파일 자신의 다른 axis 테스트가 이
 * 이름으로 "지금 실제로 보는 키 전체"를 얻는 진입점으로 계속 쓴다). @deprecated 새 코드는
 * `flattenAllLeafKeys`를 직접 쓸 것. */
export function resolveEffectiveScopedKeys(ko: Record<string, unknown>): string[] {
  return flattenAllLeafKeys(ko);
}

export interface TotalLeafFloorViolation {
  actualCount: number;
  minExpected: number;
}

// story #3927 — 네임스페이스별 leaf 하한(SCOPED_NAMESPACE_MIN_LEAF_COUNT, honorific-scope/
// *.json 74개 파일)을 대체하는 단일 전역 하한. "대량 삭제·로더 고장"만 감지하면 되는
// 목적이라 네임스페이스 단위로 쪼갤 이유가 없다(오히려 매 네임스페이스 PR마다 파일 편집을
// 요구하던 구조 자체가 이 스토리가 없애려는 결함이었다). 실측(develop 46652946e, 2026-09-15
// 13:xxZ, #4316·#4333 着地 뒤) 74ns·leaf수는 이 파일 자기 테스트에 실 수치로 고정 —
// 하한은 그 실측치의 ~80%(3916 관례 그대로, 자연 증감은 통과하되 대량 삭제는 fail-loud).
export const MIN_TOTAL_LEAF_COUNT = 4363;

/** ko.json 전체 leaf 수가 하한을 밑도는지 검사하는 순수 함수 — 위반이면 길이 1 배열,
 * 아니면 빈 배열(다른 판정 함수들과 같은 결, main()이 반환값으로 exit 여부를 결정). */
export function checkTotalLeafFloor(ko: Record<string, unknown>): TotalLeafFloorViolation[] {
  const actualCount = countAllLeaves(ko);
  if (actualCount < MIN_TOTAL_LEAF_COUNT) {
    return [{ actualCount, minExpected: MIN_TOTAL_LEAF_COUNT }];
  }
  return [];
}

// 「습니다」·「십시오」는 완성형(NFC) 원문에 그대로 리터럴로 존재한다(자음어간 종결 — 예:
// 「없습니다」는 습·니·다 3음절이 그대로 붙어 있다). 「ㅂ니다」(모음어간+ㅂ니다, 예: 「합니다」
// ·「됩니다」)는 다르다 — 그 ㅂ은 앞 음절의 **받침**으로 합쳐진 한 글자(합/됩/갑)라, NFC
// 원문엔 독립된 「ㅂ」 자모 문자가 없다. NFD(자모 분해)로 정규화하면 그 받침이
// U+11B8(HANGUL JONGSEONG PIEUP)로 분리돼 나오므로, 분해된 「니다」(U+1102 U+1175 U+1103
// U+1161)와 이어 붙었는지로 잡는다 — 실측 확認(합니다·됩니다·갑니다·입니다 전부 검출).
const NFD_JONGSEONG_B_NIDA = 'ᆸ니다'.normalize('NFD');

// story #3900 — 의문형 needle. 'ᆸ'(종성 ㅂ)+니까를 NFD로 정규화해 두면 「입니까」류의 NFD
// (받침 ㅂ이 분해돼 「니까」 앞에 붙음)와 .includes로 맞는다. escape로 정의해 소스가 NFC로
// 저장돼도 안전(직접 친 needle의 NFC/NFD 함정 회피 — memory).
const NFD_JONGSEONG_B_NIKKA = 'ᆸ니까'.normalize('NFD');

function matchesFormalRegister(value: string): string[] {
  const matches: string[] = [];
  // 서술(습니다/십시오) + 의문(습니까·story #3900) 리터럴.
  const literalMatches = value.match(/습니다|십시오|습니까/g);
  if (literalMatches) matches.push(...literalMatches);
  const nfd = value.normalize('NFD');
  // 「합니다」·「됩니다」류(모음어간 서술) — 습니다/십시오 리터럴로 이미 잡힌 값은 ㅂ니다 중복 회피.
  if (!matches.includes('습니다') && !matches.includes('십시오') && nfd.includes(NFD_JONGSEONG_B_NIDA)) {
    matches.push('ㅂ니다');
  }
  // story #3900 — 「입니까」·「합니까」류(모음어간 의문). 습니까 리터럴로 이미 잡힌 값은 중복 회피.
  if (!matches.includes('습니까') && nfd.includes(NFD_JONGSEONG_B_NIKKA)) {
    matches.push('ㅂ니까');
  }
  return matches;
}

export interface HonorificToneException {
  key: string;
  match: string;
  reason: string;
  addedBy: string;
}

// story #3877 baseline — 0건. story #3927(전역 스캔 승격)에서도 0건으로 시작한다(legal·
// githubLinks 등 예외 후보로 의심되는 네임스페이스를 직접 실측했으나 합니다체 잔존 0 —
// 지금 시점 필요한 예외가 없다). 새로 느는 자리만 이 가드가 막는다(can-only-shrink 아님 —
// 이 목록 자체는 grow-with-approval, 등록 없이 조용히 늘 수 없다는 뜻). 정말 필요하면
// key·match·reason·addedBy를 모두 채워야 등록된다(한자 가드 관례 그대로).
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

export interface StaleExceptionViolation {
  key: string;
  match: string;
}

// story #3927 CHANGES 2(PO 리뷰, 2026-09-15) — 예외 목록(HONORIFIC_TONE_EXCEPTIONS)
// 자체가 이 스토리가 봉쇄하려던 것과 같은 fail-open 클래스를 열어 둔 채였다: 예외를 건
// key·match가 나중에 값이 해요체로 고쳐지거나 키 자체가 사라져도, 그 예외 항목은
// ko.json 어디에도 안 걸리는 채로 조용히 남는다(baseline can-only-shrink 계약이 이
// 목록엔 없었다). 예외는 "지금 실재하는 예외"만이어야 한다(한자 가드·다른 baseline
// 가드들과 같은 계약) — 다 쓴 예외를 지우지 않으면 다음 사람이 "이 자리는 왜 예외지?"를
// 다시 조사해야 한다.
export function checkStaleExceptions(ko: Record<string, unknown>): StaleExceptionViolation[] {
  const violations: StaleExceptionViolation[] = [];
  for (const exc of HONORIFIC_TONE_EXCEPTIONS) {
    const value = getByPath(ko, exc.key);
    const currentMatches = typeof value === 'string' ? matchesFormalRegister(value) : [];
    if (!currentMatches.includes(exc.match)) {
      violations.push({ key: exc.key, match: exc.match });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// story #3900 axis ② — 페르소나 관형형 종결(스코프 네임스페이스 값이 완결 종결어미 없이
// 관형형 '는'/'인' + 마침표로 끝나는 것). 에이전트를 "완결 문장"으로 이관하는 과정에서
// 「~되돌리는.」·「~엣지인.」처럼 관형형만 남기고 마침표를 찍는 실수가 재발하지 않도록
// 막는다. 「~는 것」·「~인 것」 등 정당한 관형형+의존명사는 마침표가 아니라 뒤에 명사가
// 오므로 아래 정규식에 걸리지 않는다.
// ---------------------------------------------------------------------------
export interface AdnominalTerminalFinding {
  key: string;
  value: string;
}

const ADNOMINAL_TERMINAL_RE = /([가-힣]+)(는|인)\.(\s|$)/g;

// story #4203(유나 확정 문안 «할 일 → 진행 중 → 완료 확인.»·«제출 → 검토 → 승인.») — «확인»·«승인»은 관형형
// 어미 '인'이 아니라 '인'으로 끝나는 한자어 명사다(명사형 종결은 이 제품의 설명 두 마디 꼴 «흐름. ~에 적합.»).
// 예외는 **낱말 전체 일치**로만 — 까디르 QA(PR #4566): 끝 두 글자만 보면 «회원인.»·«지원인.»·«명확인.» 같은 진짜 관형형
// «~인.»이 «원인»·«확인»에 걸려 통과했다. 새 명사가 필요하면 이 표에 한 줄(사유: 명사형 종결 문안).
const NOUNS_ENDING_IN_IN = new Set(['확인', '승인', '재승인', '미확인']);

function hasAdnominalTerminal(value: string): boolean {
  for (const m of value.matchAll(ADNOMINAL_TERMINAL_RE)) {
    const word = m[1]! + m[2]!;
    if (m[2] === '인' && NOUNS_ENDING_IN_IN.has(word)) continue;
    return true;
  }
  return false;
}

export function findPersonaAdnominalTerminal(
  ko: Record<string, unknown>,
  keys: readonly string[] = [],
): AdnominalTerminalFinding[] {
  const findings: AdnominalTerminalFinding[] = [];
  for (const key of keys) {
    const value = getByPath(ko, key);
    if (typeof value !== 'string') continue;
    // '~는 것' / '~인 것' 등 정당한 관형형+의존명사는 마침표가 아니라 뒤에 명사가 오므로
    // 위 정규식에 안 걸린다.
    if (hasAdnominalTerminal(value)) findings.push({ key, value });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// story #3900 axis ③ — 플레이스홀더 값 바로 뒤에 조사를 문자열에 고정해 둔 자리(런타임
// 값의 받침 유무에 따라 절반은 비문이 되는 자리). 이 축은 스코프 무관 — ko.json 전체 leaf
// 값을 스캔한다(어느 화면이든 플레이스홀더+고정 조사는 잘못이다). 이중형(`{name}이(가)`)은
// 조사 뒤에 '('가 오지 공백/문자열끝이 아니라 아래 정규식에 걸리지 않는다(의도된 허용).
// ---------------------------------------------------------------------------
export interface PlaceholderParticleFinding {
  key: string;
  value: string;
}

const PLACEHOLDER_PARTICLE_RE = /\{[a-zA-Z_][a-zA-Z0-9_]*\}(이|가|을|를|은|는|과|와|으로|로)(\s|$)/;

export function findHardcodedParticleAfterPlaceholder(
  ko: Record<string, unknown>,
): PlaceholderParticleFinding[] {
  const findings: PlaceholderParticleFinding[] = [];
  function walk(obj: Record<string, unknown>, prefix: string): void {
    for (const [k, v] of Object.entries(obj)) {
      const dottedKey = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, dottedKey);
      } else if (typeof v === 'string') {
        if (PLACEHOLDER_PARTICLE_RE.test(v)) findings.push({ key: dottedKey, value: v });
      }
    }
  }
  walk(ko, '');
  return findings;
}

// ---------------------------------------------------------------------------
// story #3914 axis ④ — 에이전트 어미 누출(스코프 값이 '…지?' 반말/자문 물음으로 끝나는 것).
// 배경: 에이전트 말투('~하는지?'/'~할지?')가 해요체 이관을 거쳐 사용자 UI에 샌 실 사례
// (retro.stageForwardConfirm·retro.stageBackConfirm·standup.deleteFeedbackConfirm 3건).
// 사용자 대상 물음은 완결 해요체 의문형(~까요?/~나요?/~가요? = '요?')이어야 한다. '지?'는
// 반말 자문투라 RED — '~까요?'/'~나요?'/'~가요?'는 '요?'로 끝나 아래 정규식에 안 걸린다(허용).
// ---------------------------------------------------------------------------
export interface AgentEndingLeakFinding {
  key: string;
  value: string;
}

const AGENT_ENDING_QUESTION_RE = /[가-힣]지\?/;

export function findAgentEndingQuestionLeak(
  ko: Record<string, unknown>,
  keys: readonly string[] = [],
): AgentEndingLeakFinding[] {
  const findings: AgentEndingLeakFinding[] = [];
  for (const key of keys) {
    const value = getByPath(ko, key);
    if (typeof value !== 'string') continue;
    if (AGENT_ENDING_QUESTION_RE.test(value)) findings.push({ key, value });
  }
  return findings;
}

function main(): void {
  const text = readFileSync(path.join(MESSAGES_DIR, KO_FILE), 'utf8');
  const ko = JSON.parse(text) as Record<string, unknown>;

  const floorViolations = checkTotalLeafFloor(ko);
  if (floorViolations.length > 0) {
    const v = floorViolations[0]!;
    console.error(
      `FAIL: ko.json 전체 leaf가 ${v.actualCount}개뿐(최소 ${v.minExpected}개 기대) — ` +
        '대량 삭제 또는 messages/ko.json 로더 고장이 의심된다(가드가 헛돌고 있을 수 있다).',
    );
    process.exit(1);
  }

  const unsupportedLeafTypes = findUnsupportedLeafTypes(ko);
  if (unsupportedLeafTypes.length > 0) {
    console.error(
      `FAIL: ko.json에 지원하지 않는 leaf 타입 ${unsupportedLeafTypes.length}건 발견(문자열도 ` +
        '객체도 아님 — 톤 스캔이 조용히 건너뛰는 자리다):',
    );
    for (const v of unsupportedLeafTypes) console.error(`  - ${v.key} [${v.type}]`);
    console.error(
      '\n→ i18n leaf 값은 문자열만 지원한다. 배열/숫자/불리언 등은 톤 검사를 우회하므로' +
        ' 구조를 문자열로 고칠 것.',
    );
    process.exit(1);
  }

  const staleExceptions = checkStaleExceptions(ko);
  if (staleExceptions.length > 0) {
    console.error(`FAIL: HONORIFIC_TONE_EXCEPTIONS에 ${staleExceptions.length}건이 등재됐으나 지금 ko.json 어디에도 안 걸린다:`);
    for (const v of staleExceptions) console.error(`  - ${v.key}::${v.match}`);
    console.error('\n→ 고쳐졌다면(해요체로 옮겼거나 키를 삭제했다면) HONORIFIC_TONE_EXCEPTIONS에서 그 항목을 지울 것.');
    process.exit(1);
  }

  const effectiveKeys = flattenAllLeafKeys(ko);
  const nsCount = new Set(Object.keys(ko)).size;
  const findings = findHonorificToneInScopedKeys(ko, effectiveKeys);

  if (findings.length > 0) {
    console.log(`❌ ko.json 전체(${nsCount}ns·${effectiveKeys.length}leaf)의 값에 합니다체 ${findings.length}건 발견:`);
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

  console.log(`OK: ko.json 전체(${nsCount}ns·${effectiveKeys.length}leaf)의 값에 합니다체 0건`);

  // story #3900 axis ② — 페르소나 관형형 종결(값이 완결 어미 없이 '는'/'인'+마침표로 끝나는 것).
  const adnominalFindings = findPersonaAdnominalTerminal(ko, effectiveKeys);
  if (adnominalFindings.length > 0) {
    console.error(`❌ ko.json 전체(${effectiveKeys.length}leaf)의 값에 관형형 종결(완결 어미 없이 '는'/'인'+마침표) ${adnominalFindings.length}건 발견:`);
    for (const f of adnominalFindings) {
      console.error(`  - ${f.key} → ${JSON.stringify(f.value)}`);
    }
    console.error(
      "\n→ 문장은 완결 종결어미(~해요/~예요 등)로 끝나야 한다. 관형형('~는'/'~인')만 남기고" +
        ' 마침표를 찍으면 미완결 비문이다. 완결 어미로 고쳐라.',
    );
    process.exit(1);
  }
  console.log(`OK: ko.json 전체(${effectiveKeys.length}leaf)의 값에 관형형 종결(완결 어미 없는 '는'/'인'+마침표) 0건`);

  // story #3914 axis ④ — 에이전트 어미 누출(값이 '…지?' 반말 물음으로 끝나는 것).
  const agentEndingFindings = findAgentEndingQuestionLeak(ko, effectiveKeys);
  if (agentEndingFindings.length > 0) {
    console.error(`❌ ko.json 전체(${effectiveKeys.length}leaf)의 값에 에이전트 어미 누출('…지?' 반말 물음) ${agentEndingFindings.length}건 발견:`);
    for (const f of agentEndingFindings) {
      console.error(`  - ${f.key} → ${JSON.stringify(f.value)}`);
    }
    console.error(
      "\n→ 사용자 대상 물음은 완결 해요체 의문형(~까요?/~나요?/~가요?)이어야 한다. '~지?'는" +
        ' 반말 자문투(에이전트 말투)라 사용자 UI에 두면 안 된다. 「~까요?」로 고쳐라.',
    );
    process.exit(1);
  }
  console.log(`OK: ko.json 전체(${effectiveKeys.length}leaf)의 값에 에이전트 어미 누출('…지?' 반말 물음) 0건`);

  // story #3900 axis ③ — 플레이스홀더 값 바로 뒤 고정 조사(스코프 무관·ko.json 전체 leaf 스캔).
  const particleFindings = findHardcodedParticleAfterPlaceholder(ko);
  if (particleFindings.length > 0) {
    console.error(`❌ ko.json 전체 leaf 값에 플레이스홀더 뒤 고정 조사 ${particleFindings.length}건 발견:`);
    for (const f of particleFindings) {
      console.error(`  - ${f.key} → ${JSON.stringify(f.value)}`);
    }
    console.error(
      '\n→ 플레이스홀더 값의 받침 유무에 따라 조사가 갈린다(비문 위험). @/lib/korean-particle의' +
        ' 헬퍼(pickIGaJosa·pickEulReulJosa·pickEunNeunJosa·pickEuroJosa)로 컴포넌트에서 조사를' +
        ' 넘기거나, 조사가 필요 없게 문장을 재구성하거나, 이중형(`{x}이(가)`)으로 적어라.',
    );
    process.exit(1);
  }
  console.log('OK: ko.json 전체 leaf 값에 플레이스홀더 뒤 고정 조사 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
