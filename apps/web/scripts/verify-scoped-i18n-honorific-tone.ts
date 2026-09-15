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
 * ⚠️scope는 **namespace 전체가 아니라 정확히 이 104키**다(SCOPED_KEYS). namespace
 * 통째로 스캔하면(예: `cage`·`goals`·`standup`) Mirko 감사가 의도적으로 거른 스코프 밖
 * 화면의 기존 합니다체 값(예: `cage.gateDetailNotFound`·`goals.createError`·
 * `standup.loadFailed` 등 78건 실측)까지 baseline 0을 요구하게 돼 이 스토리가 안 건드린
 * 자리에서 거짓 RED가 난다 — namespace는 "어디서 이 키들을 찾았나"의 분류 메타데이터일
 * 뿐, 판정 축은 항상 키 단위다. AC1 표가 "AC2·AC3의 판별선"(페드루 PO 확定)이라는 게
 * 정확히 이 뜻이다. 다음 카드가 스코프를 넓히면 SCOPED_KEYS에 새 키를 추가한다(namespace
 * 째 추가 아님).
 *
 * story #3885 AC2 — 위 원칙의 예외 하나: `chats` 네임스페이스는 그 예외가 성립하지
 * «않는» 경우다. #3877 AC1 표가 cage/goals/standup처럼 일부러 남겨둔 스코프 밖 잔존
 * 합니다체가 chats에는 없다 — 이 스토리가 PO 재측 규칙(습니다/ㅂ니다/십시오 리터럴+NFD)
 * 으로 chats leaf 값 전수(239개)를 스캔해 걸린 66키(중복 문자열 2개 제외 고유 값 64건)
 * «전부»를 해요체로 이관했다(잔존 0). 그래서 chats만은 SCOPED_NAMESPACES(namespace
 * prefix 통째 스캔)로 승격해도 안전 — 앞으로 chats에 새로 추가되는 어떤 키든(기존 104
 * SCOPED_KEYS 목록에 미리 적어두지 않아도) 합니다체가 섞이면 자동으로 잡힌다. 다른
 * 네임스페이스(cage 등)는 여전히 잔존 채무가 있어 이 승격을 하면 안 된다 — namespace를
 * SCOPED_NAMESPACES에 추가하는 건 "이 네임스페이스는 이제 0건이 확定됐다"는 선언이다.
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
// AC4가 소비처 有로 확認해 편입한 orgBriefing 9키 + AC5 캡처 中 발견한 1키
// (docs.emptyDescription) = 104키. "namespace.leafKey" 형식. 확장 시 이 배열에 새 키를
// 추가한다(namespace를 통째로 추가하지 않는다 — 위 헤더 참고).
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

// story #3885 AC2 — chats는 잔존 채무 0으로 확定된 네임스페이스라 prefix 통째 스캔으로
// 승격(위 헤더 §3885 AC2 단락 참고). 새 네임스페이스를 추가하려면 그 네임스페이스의
// 합니다체 잔존이 정말 0인지(이 카드처럼) 먼저 전수 실측해야 한다 — 추측 금지.
// story #3889 — content(마케팅 축 콘텐츠·블로그/채널 포스트)·channelConnect(채널 연결)도
// 전량 해요체 이관 완료(잔존 0, PO 재측 271건 = findHonorificToneInScopedKeys 실 함수로
// 그라운딩 — 코드 0 규율, 직접 손으로 친 needle 재현은 NFC/NFD 함정 재발이라 실 함수만
// 신뢰) — chats와 동형 전량 승격.
// story #3892 — settings(조직·프로젝트·알림·결제 설정)도 전량 해요체 이관 완료(잔존 0,
// 실 함수로 head 재측 170건 = PO 실측과 일치 — 3889 교훈 그대로 코드 0 재확認).
// story #3895 — agents(에이전트 관리)·flow(플로우/일감 보드)·gateConfig(게이트 설정)도
// 전량 해요체 이관 완료(잔존 0, 실 함수로 head 재측 128건=62+61+5 = PO 실측과 일치).
// story #3899 — recruiter(채용)·loops(실험 루프)·cage(결재/게이트)도 전량 해요체 이관
// 완료(잔존 0, 실 함수로 head 재측 recruiter 36·loops 34·cage 29=99건 = PO 실측과 일치 —
// 3889/3892 교훈 그대로 코드 0 재확認. 전환 전 플레이스홀더-계사 인접(`}입니다`류) 세
// 네임스페이스 내 0건도 사전 스캔으로 확認).
// story #3898 — organization·pricingPlans·contentRules도 전량 해요체 이관(100키) 완료.
// story #3901 — onboarding(온보딩)·login(로그인)·storage(스토리지)·insightsBoard(인사이트
// 보드)도 전량 해요체 이관 완료(잔존 0, 실 함수로 head 재측 onboarding 27·login 17·
// storage 26·insightsBoard 25=95건 — PO 임시 needle 하한 74건보다 많음, ㅂ니다 계열까지
// NFD로 잡은 실 함수 재측이 항상 상한 자다. 전환 전 플레이스홀더-계사 인접 0건 사전 스캔
// 확認).
export const SCOPED_NAMESPACES = [
  'chats',
  'content',
  'channelConnect',
  'settings',
  'agents',
  'flow',
  'gateConfig',
  'recruiter',
  'loops',
  'cage',
  'organization',
  'pricingPlans',
  'contentRules',
  'onboarding',
  'login',
  'storage',
  'insightsBoard',
] as const;

function flattenNamespaceLeafKeys(root: Record<string, unknown>, namespace: string): string[] {
  const nsRoot = root[namespace];
  if (nsRoot === null || typeof nsRoot !== 'object' || Array.isArray(nsRoot)) return [];
  const keys: string[] = [];
  function walk(obj: Record<string, unknown>, prefix: string): void {
    for (const [k, v] of Object.entries(obj)) {
      const qualifiedKey = `${prefix}.${k}`;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, qualifiedKey);
      } else if (typeof v === 'string') {
        keys.push(qualifiedKey);
      }
    }
  }
  walk(nsRoot as Record<string, unknown>, namespace);
  return keys;
}

/** SCOPED_KEYS(개별 지정)와 SCOPED_NAMESPACES(전량 승격) 둘을 합친 실제 판정 대상 키
 * 목록 — ko.json 실 트리를 봐야 네임스페이스 leaf를 펼칠 수 있어 ko를 인자로 받는다. */
export function resolveEffectiveScopedKeys(ko: Record<string, unknown>): string[] {
  const namespaceKeys = SCOPED_NAMESPACES.flatMap((ns) => flattenNamespaceLeafKeys(ko, ns));
  return [...new Set([...SCOPED_KEYS, ...namespaceKeys])];
}

export interface NamespaceLeafCountViolation {
  namespace: string;
  actualCount: number;
  minExpected: number;
}

// story #3885 CHANGES①(PO PR 코멘트, 2026-09-14 18:02Z) — `flattenNamespaceLeafKeys`는
// 네임스페이스가 ko.json에서 사라지거나 개명되면 조용히 []를 돌려준다 — 그러면
// `resolveEffectiveScopedKeys`가 소리 없이 SCOPED_KEYS만으로 좁아져(namespace 전량
// 승격이 아무것도 안 더하는 상태) 이 가드가 chats 신규 위반을 하나도 못 잡게 된다.
// 네임스페이스별 leaf 최소 개수(실측값에서 여유를 둔 하한 — 리팩터로 인한 자연 증감은
// 통과하되, 네임스페이스 자체가 사라지면 반드시 fail-loud)로 이 사각을 막는다.
const SCOPED_NAMESPACE_MIN_LEAF_COUNT: Readonly<Record<(typeof SCOPED_NAMESPACES)[number], number>> = {
  chats: 200, // 실측 239개(2026-09-14, story #3885 그라운딩) — 여유 하한
  content: 500, // 실측 584개(2026-09-14, story #3889 그라운딩) — 여유 하한
  channelConnect: 150, // 실측 174개(2026-09-14, story #3889 그라운딩) — 여유 하한
  settings: 450, // 실측 538개(2026-09-14, story #3892 그라운딩) — 여유 하한
  agents: 150, // 실측 191개(2026-09-15, story #3895 그라운딩) — 여유 하한
  flow: 160, // 실측 202개(2026-09-15, story #3895 그라운딩) — 여유 하한
  gateConfig: 15, // 실측 20개(2026-09-15, story #3895 그라운딩) — 여유 하한
  recruiter: 100, // 실측 114개(2026-09-15, story #3899 그라운딩) — 여유 하한
  loops: 105, // 실측 119개(2026-09-15, story #3899 그라운딩) — 여유 하한
  cage: 230, // 실측 259개(2026-09-15, story #3899 그라운딩) — 여유 하한
  organization: 190, // 실측 212개(2026-09-14, story #3898 그라운딩) — 여유 하한
  pricingPlans: 125, // 실측 141개(2026-09-14, story #3898 그라운딩) — 여유 하한
  contentRules: 70, // 실측 81개(2026-09-14, story #3898 그라운딩) — 여유 하한
  onboarding: 75, // 실측 88개(2026-09-15, story #3901 그라운딩) — 여유 하한
  login: 30, // 실측 35개(2026-09-15, story #3901 그라운딩) — 여유 하한
  storage: 70, // 실측 82개(2026-09-15, story #3901 그라운딩) — 여유 하한
  insightsBoard: 90, // 실측 103개(2026-09-15, story #3901 그라운딩) — 여유 하한
};

/** SCOPED_NAMESPACES 각각의 실제 leaf 개수가 하한을 밑도는지 검사하는 순수 함수 —
 * 위반을 반환한다(main()이 이 반환값을 보고 exit 1을 결정, 이 함수 자체는 throw/exit
 * 안 함 — 다른 판정 함수들과 같은 결). */
export function checkScopedNamespaceMinimums(ko: Record<string, unknown>): NamespaceLeafCountViolation[] {
  const violations: NamespaceLeafCountViolation[] = [];
  for (const ns of SCOPED_NAMESPACES) {
    const actualCount = flattenNamespaceLeafKeys(ko, ns).length;
    const minExpected = SCOPED_NAMESPACE_MIN_LEAF_COUNT[ns];
    if (actualCount < minExpected) {
      violations.push({ namespace: ns, actualCount, minExpected });
    }
  }
  return violations;
}

// 「습니다」·「십시오」는 완성형(NFC) 원문에 그대로 리터럴로 존재한다(자음어간 종결 — 예:
// 「없습니다」는 습·니·다 3음절이 그대로 붙어 있다). 「ㅂ니다」(모음어간+ㅂ니다, 예: 「합니다」
// ·「됩니다」)는 다르다 — 그 ㅂ은 앞 음절의 **받침**으로 합쳐진 한 글자(합/됩/갑)라, NFC
// 원문엔 독립된 「ㅂ」 자모 문자가 없다. NFD(자모 분해)로 정규화하면 그 받침이
// U+11B8(HANGUL JONGSEONG PIEUP)로 분리돼 나오므로, 분해된 「니다」(U+1102 U+1175 U+1103
// U+1161)와 이어 붙었는지로 잡는다 — 실측 확認(합니다·됩니다·갑니다·입니다 전부 검출).
const NFD_JONGSEONG_B_NIDA = 'ᆸ니다';

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

// story #3877 baseline — 0건(이 스토리가 SCOPED_KEYS 104개 전부를 해요체로 이관). 새로
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

const ADNOMINAL_TERMINAL_RE = /[가-힣](는|인)\.(\s|$)/;

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
    if (ADNOMINAL_TERMINAL_RE.test(value)) findings.push({ key, value });
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

function main(): void {
  const text = readFileSync(path.join(MESSAGES_DIR, KO_FILE), 'utf8');
  const ko = JSON.parse(text) as Record<string, unknown>;

  const namespaceViolations = checkScopedNamespaceMinimums(ko);
  if (namespaceViolations.length > 0) {
    for (const v of namespaceViolations) {
      console.error(
        `FAIL: SCOPED_NAMESPACES의 "${v.namespace}" 네임스페이스 leaf가 ${v.actualCount}개뿐` +
          `(최소 ${v.minExpected}개 기대) — ko.json에서 "${v.namespace}" 네임스페이스가 사라졌거나` +
          ' 개명됐을 수 있다. 이대로면 가드가 헛돌고 있다(namespace 전량 승격이 조용히' +
          ' SCOPED_KEYS만으로 좁아진다).',
      );
    }
    process.exit(1);
  }

  const effectiveKeys = resolveEffectiveScopedKeys(ko);
  const findings = findHonorificToneInScopedKeys(ko, effectiveKeys);

  if (findings.length > 0) {
    console.log(`❌ 스코프 키(${effectiveKeys.length}개 — SCOPED_KEYS ${SCOPED_KEYS.length}+SCOPED_NAMESPACES[${SCOPED_NAMESPACES.join(',')}])의 ko.json 값에 합니다체 ${findings.length}건 발견:`);
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

  console.log(`OK: 스코프 키(${effectiveKeys.length}개 — SCOPED_KEYS ${SCOPED_KEYS.length}+SCOPED_NAMESPACES[${SCOPED_NAMESPACES.join(',')}])의 ko.json 값에 합니다체 0건`);

  // story #3900 axis ② — 페르소나 관형형 종결(스코프 키 값이 완결 어미 없이 '는'/'인'+마침표로 끝나는 것).
  const adnominalFindings = findPersonaAdnominalTerminal(ko, effectiveKeys);
  if (adnominalFindings.length > 0) {
    console.error(`❌ 스코프 키(${effectiveKeys.length}개)의 ko.json 값에 관형형 종결(완결 어미 없이 '는'/'인'+마침표) ${adnominalFindings.length}건 발견:`);
    for (const f of adnominalFindings) {
      console.error(`  - ${f.key} → ${JSON.stringify(f.value)}`);
    }
    console.error(
      "\n→ 문장은 완결 종결어미(~해요/~예요 등)로 끝나야 한다. 관형형('~는'/'~인')만 남기고" +
        ' 마침표를 찍으면 미완결 비문이다. 완결 어미로 고쳐라.',
    );
    process.exit(1);
  }
  console.log(`OK: 스코프 키(${effectiveKeys.length}개)의 ko.json 값에 관형형 종결(완결 어미 없는 '는'/'인'+마침표) 0건`);

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
