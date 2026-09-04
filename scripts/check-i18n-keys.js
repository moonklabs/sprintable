#!/usr/bin/env node
/**
 * Translation key validation — story #2371.
 *
 * 이전 버전(2026-07-31 이전)은 코드→messages 한 방향만 쟀고 정규식 결함 셋을 갖고 있었다
 * (실측: 손으로 돌리면 344 issues, 그런데 진짜 누락은 0건 — 전부 도구 결함). 이 판이 고친 것:
 *
 *   ㉠ `t(` 매치가 `get(`처럼 다른 식별자 끝에 걸리는 워드바운더리 누락
 *      → `(?<![\w$])t\(` 네거티브 룩비하인드로 앞이 단어문자/`$`가 아닐 때만 매치.
 *   ㉡ `useTranslations(['"])(\w+)(['"])` 가 `\w`라 점 포함 네임스페이스(`'settings.mcpConnections'`)
 *      를 못 읽고, `.match()`(matchAll 아님)라 그 파일의 «다음» useTranslations 호출로
 *      오조회하던 것 → `[\w.]+`로 점 허용 + `matchAll`로 파일당 «모든» 선언을 모은다.
 *   ㉢ `en[ns]?.[key]` 1단 조회라 messages의 2단 이상 중첩을 원리적으로 못 보던 것
 *      → messages를 완전히 평탄화(flatten)한 뒤 `"${ns}.${key}"` 문자열 조회로 바꿔 깊이
 *      제한을 없앴다(네임스페이스가 `a.b`든 `a`든, key가 `c`든 `b.c`든 최종 합성 문자열이
 *      같으면 같은 키로 잡힌다).
 *
 * ⭐추가로 이번 조사에서 스토리 원문에 없던 4번째 결함을 새로 찾아 고쳤다 —
 *   ㉣ 훅 변수명이 하드코딩된 `t`뿐이었다. 실측(grep, 2026-08-01): `const t =`가 256곳이지만
 *      `tc`(24)·`th`(7)·`tr`(2)·`tGlance`(2)·`tCage`(2)·`ta`(2)·`shellT`·`tSettings`·
 *      `tRecruiter`·`tOnboarding`·`tn`·`tMore`·`tInvite`·`tInbox`·`tEditor`·`tAgents`·`_t`·
 *      `tCommon`(7) 등 다르게 이름 붙인 훅이 55곳 넘게 있다 — 하드코딩 `t(`는 이 전부를
 *      놓친다(양방향 다). → `HOOK_BIND_RE`로 각 파일의 실제 로컬 변수명을 잡아 그 이름으로
 *      호출을 찾는다.
 *
 * 방향 둘:
 *   ① 코드 → messages (missing) — 코드가 쓰는 키가 messages에 없다.
 *   ② messages → 코드 (dead, story AC3) — messages에 있는 키를 어느 소비처도 안 읽는다.
 *      ⛔이 판은 ②의 결과를 «지우지 않는다»(AC6) — 다음 판의 재료로 목록만 낸다.
 *
 * 이 도구가 못 보는 것(AC8, 구조적 blind spot — 고치지 않고 선언만 한다):
 *   - 바닥(bare) 변수를 그대로 t()에 넘기는 자리 — `t(labelKey)`류. 리터럴이 전혀 없어
 *     정적으로 «어떤 문자열이 오는지» 알 방법이 없다(값이 아니라 변수). 실측 12파일(2026-08-01
 *     grep): activity/page.tsx · inbox/page.tsx · more/page.tsx ·
 *     settings/workflow-line-editor-section.tsx · hypotheses/hypothesis-status-badge.tsx ·
 *     cage/gate-evidence.tsx · dashboard/command-center/action-zone.tsx ·
 *     kanban/story-detail-panel.tsx · loops/loop-status-badge.tsx · nav/mobile-tab-bar.tsx ·
 *     services/notification-display.ts · loops/loop-create-dialog.tsx(`tr` 훅).
 *     이 파일들이 참조하는 네임스페이스의 키는 ②(dead) 결과에서 오탐(거짓 dead)일 수 있다
 *     — 삭제 전 사람이 그 소비처를 직접 봐야 한다(AC6와 같은 이유).
 *   - 훅이 다른 컴포넌트로 prop 전달돼 그 안에서 쓰이는 경우(파일 경계를 넘는 스코프) —
 *     이 도구는 파일 단위로만 훅↔호출을 묶는다.
 *   - 상수맵 간접 호출 자체(`t(LABEL_KEY[status])`)는 위 「바닥 변수」류와 같은 근본 이유로
 *     못 본다 — 다만 그 호출이 «리터럴 접두사를 낀 템플릿 리터럴» 안에 있으면
 *     (`t(\`risk.${RISK_KEY[x]}\`)`) 그 접두사(`risk.`)는 DYNAMIC_KEY_PREFIXES가 잡는다(아래).
 *   - 서버 `getTranslations()`는 실측 결과 전부 `useTranslations`와 동형 인자(단순 문자열
 *     네임스페이스)라 HOOK_BIND_RE가 이미 같이 잡는다 — 별도 blind spot 아님.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { flatten, escapeRegExp, stripComments, extractKeyUsages, extractHookBindings } = require('./i18n-key-parser');

const rootDir = path.join(__dirname, '..');

/**
 * AC4 — 동적 조합 화이트리스트. AC3(②)보다 먼저 서야 하는 이유: 이게 없으면 아래 접두사를
 * 쓰는 «살아 있는» 키 전부가 dead 후보로 잘못 뜬다(실측 2026-08-01 grep 전수 —
 * `grep -rEn "\bt\(\`" apps/web/src` 로 찾은 전체 템플릿 리터럴 t() 호출 기준).
 * 각 항목: 그 접두사를 쓰는 실제 호출부 파일 + 왜 정적으로 완전한 키를 못 뽑는지.
 */
const DYNAMIC_KEY_PREFIXES = [
  { prefix: 'kitOrientingWakeBody_', file: 'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx', reason: 't(`kitOrientingWakeBody_${wakeInfo.method}`) — method는 RuntimeWakeMethod 유니온의 런타임 값' },
  { prefix: 'notificationLevel_', file: 'app/(authenticated)/settings/page.tsx', reason: 't(`notificationLevel_${level}`)' },
  { prefix: 'notification_category_', file: 'app/(authenticated)/settings/page.tsx', reason: 't(`notification_category_${category.key}`)' },
  { prefix: 'event_', file: 'app/(authenticated)/settings/page.tsx', reason: 't(`event_${eventType}`)' },
  { prefix: 'status', file: 'app/(authenticated)/[ws]/[proj]/loops/loops-client.tsx', reason: 't(`status${s.charAt(0).toUpperCase()}${s.slice(1)}` as "statusDraft") — camelCase 합성, 접두만 정적(대소문자 변환 이후 값은 런타임)' },
  { prefix: 'work_', file: 'components/settings/gate-level-matrix.tsx', reason: 't(`work_${wt}`)' },
  { prefix: 'actor_', file: 'components/settings/gate-level-matrix.tsx', reason: 't(`actor_${at}`)' },
  { prefix: 'billingMode_', file: 'components/agents/agent-runs-list.tsx', reason: 't(`billingMode_${billingMode}`)' },
  { prefix: 'status_', file: 'components/agents/agent-runs-list.tsx', reason: 't(`status_${s}`) / t(`status_${run.status}`)' },
  { prefix: 'failureDisposition_', file: 'components/agents/agent-runs-list.tsx', reason: 't(`failureDisposition_${getRunFailureDisposition(run)}`)' },
  { prefix: 'toolAuditSource_', file: 'components/agents/agent-run-detail.tsx', reason: 't(`toolAuditSource_${toolSource}`)' },
  { prefix: 'reviewType_', file: 'components/standup/standup-feedback-dialog.tsx', reason: 't(`reviewType_${item.review_type}`) / t(`reviewType_${option}`)' },
  { prefix: 'metric_', file: 'components/outcome/outcome-result-card.tsx', reason: 't(`metric_${result.metric}` as "metric_velocity")' },
  { prefix: 'galleryAxis', file: 'components/canvas/artifact-gallery-view.tsx', reason: 't(`galleryAxis${a[0].toUpperCase()}${a.slice(1)}`) — camelCase 합성' },
  { prefix: 'responsivePreview', file: 'components/canvas/artifact-expand-dialog.tsx', reason: 't(`responsivePreview${bp[0].toUpperCase()}${bp.slice(1)}`) — camelCase 합성' },
  { prefix: 'galleryFormat', file: 'components/canvas/artifact-thumbnail.tsx', reason: 't(`galleryFormat${state.format[0].toUpperCase()}${state.format.slice(1)}`) — camelCase 합성' },
  { prefix: 'entityType', file: 'components/loops/context-pack-panel.tsx', reason: 't(`entityType${item.entity_type...}` as "entityTypeLoop") — camelCase 합성' },
  { prefix: 'aiConfidenceLevel_', file: 'components/loops/ai-attribution.tsx', reason: 't(`aiConfidenceLevel_${confidence}` as "aiConfidenceLevel_high")' },
  { prefix: 'loopPhrase', file: 'components/org-briefing/derive-loop-face.ts', reason: 't(`loopPhrase${capitalize(derivePhrase(...))}`) — camelCase 합성' },
  { prefix: 'laneFlag_', file: 'components/flow/flow-lane.tsx', reason: 't(`laneFlag_${flag.key}`, { n: flag.count })' },
  { prefix: 'portLinkKind_', file: 'components/flow/flow-map-canvas.tsx', reason: 't(`portLinkKind_${kind}`) — 기존 코드베이스 관례' },
  { prefix: 'risk.', file: 'components/proof-capsule/proof-capsule.tsx', reason: 't(`risk.${RISK_KEY[gate.risk]}`) — 상수맵 간접 + 점 표기 하위 네임스페이스' },
  { prefix: 'status.', file: 'components/settings/mcp-connection-settings.tsx', reason: 't(`status.${connection.status}`)' },
  { prefix: 'auth.', file: 'components/settings/mcp-connection-settings.tsx', reason: 't(`auth.${connection.authStrategy}`)' },
  { prefix: 'toolPermissions.groups.', file: 'components/agents/tool-permission-picker.tsx', reason: 't(`toolPermissions.groups.${key}`)' },
];

function isDynamicallyComposed(flatKeyPath) {
  return DYNAMIC_KEY_PREFIXES.some(({ prefix }) => {
    const re = new RegExp(`(^|\\.)${escapeRegExp(prefix)}[\\w-]*$`);
    return re.test(flatKeyPath);
  });
}

// story #3156 — HOOK_BIND_RE/extractKeyUsages는 i18n-key-parser.js(공유 모듈)로 이관.
// ㉣(훅 변수명 하드코딩 t 가정 폐기)·㉥(멤버접근 오귀속, story #3149) 둘 다 그쪽에서 관리.

// story #3420(2026-09-04) — ③ 코드→messages, 하지만 방향 ①(HOOK_BIND_RE+extractKeyUsages)
// 이 원리적으로 못 보는 자리. 위 AC8 docstring이 이미 선언한 "바닥 변수를 그대로 t()에
// 넘기는 자리 — t(labelKey)류... 리터럴이 전혀 없어 정적으로 «어떤 문자열이 오는지» 알
// 방법이 없다"가 정확히 PR#3768(api-error.ts::KNOWN_ERRORS)이 밟은 사고 그대로였다 —
// `t(info.humanMessageKey)`(page.tsx, 호출 자리)는 리터럴이 없어 방향①이 원리적으로 못
// 보지만, `labelKey: 'errorChannelTokenExpired'`(api-error.ts, 선언 자리)는 여전히 리터럴
// 이다 — 호출 자리가 아니라 "키를 값으로 드는 테이블 선언" 자리를 스캔하면 이 blind spot을
// 닫을 수 있다. 방향①(호출부 스캔)의 대체가 아니라 보완 — 같은 "코드→messages missing"
// 축이므로 별도 스크립트/CI 스텝을 새로 만들지 않고 이 도구에 셋째 방향으로 합친다(페드루
// PO 판정, 2026-09-04 — "같은 축이면 그쪽 확장, 두 벌 금지").
//
// 선언 자리엔 네임스페이스가 없다(어느 useTranslations('content') 등에서 소비될지 그
// 자리에선 모른다) — 그래서 방향①처럼 "namespace.key" 정확매치가 아니라 "이 리터럴이 어느
// namespace 아래에든 최소 하나는 있는지"(suffix 매치)로 판정한다. 정확한 namespace까지
// 좁히려면 소비부(useTranslations 호출부)까지 역추적해야 하는데(AC8급 확장) 이 셋째 방향의
// 스코프 밖이다(아래 KEY_FIELD_NAMES에 없는 새 "키를 값으로 드는 테이블" 필드 이름도 마찬가지
// — 새로 추가하면 이 목록에 등록해야 스캔 대상이 된다).
const KEY_FIELD_NAMES = ['labelKey'];
const KEY_FIELD_RE = new RegExp(`\\b(?:${KEY_FIELD_NAMES.join('|')}):\\s*['"]([^'"]*)['"]`, 'g');

function extractTableKeyLiterals(content) {
  const out = [];
  for (const m of content.matchAll(KEY_FIELD_RE)) {
    if (m[1] !== '') out.push(m[1]); // 빈 문자열은 "소비부가 문구 직접 조립"이라는 의도적 위임 표시 — 스캔 제외
  }
  return out;
}

function existsInFlat(flat, bareKey) {
  return Object.prototype.hasOwnProperty.call(flat, bareKey)
    || Object.keys(flat).some((full) => full.endsWith(`.${bareKey}`));
}

// main()으로 감싸 CLI 실행(require.main === module)일 때만 돈다 — 그래야 테스트가 순수함수
// (flatten/stripComments/isDynamicallyComposed)만 require해 쓸 때 이 스캔 전체(파일 I/O·
// process.exit)가 같이 실행되는 부작용이 없다.
function main() {
  const enMessages = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/web/messages/en.json'), 'utf8'));
  const koMessages = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/web/messages/ko.json'), 'utf8'));
  const enFlat = flatten(enMessages);
  const koFlat = flatten(koMessages);

  const files = execSync('find apps/web/src -name "*.tsx" -o -name "*.ts"', { encoding: 'utf8', cwd: rootDir })
    .trim()
    .split('\n')
    .filter(f => !f.includes('.test.') && !f.includes('.spec.'));

  const issues = [];
  const namespaceUsage = new Map(); // namespace -> Set(key) — 리포트용 요약
  const referencedPaths = new Set(); // 방향② dead-key 스캔이 쓰는 「참조된 전체 경로」 집합
  const tableReferencedBareKeys = new Set(); // story #3420 — 방향③ 키(네임스페이스 없음, bare)

  files.forEach(file => {
    const content = stripComments(fs.readFileSync(path.join(rootDir, file), 'utf8'));

    // story #3420 — 방향③(테이블 선언 리터럴). 훅 바인딩(useTranslations 등) 자체가 없는
    // 파일(예: api-error.ts — 자신은 t()를 호출하지 않고 다른 파일이 소비할 라벨을 값으로만
    // 든다)도 스캔해야 하므로, 아래 훅 바인딩 0건 early-return «전에» 돈다.
    for (const key of extractTableKeyLiterals(content)) {
      tableReferencedBareKeys.add(key);
      const enValue = existsInFlat(enFlat, key);
      const koValue = existsInFlat(koFlat, key);
      if (!enValue) issues.push({ file, namespace: '(table)', key, fullKey: key, type: 'missing_en' });
      if (!koValue) issues.push({ file, namespace: '(table)', key, fullKey: key, type: 'missing_ko' });
    }

    const varToNamespace = extractHookBindings(content);
    if (varToNamespace.size === 0) return;

    for (const [varName, namespace] of varToNamespace) {
      // ㉠ 워드바운더리 + ㉥ 멤버접근 제외 — extractKeyUsages 참조.
      for (const key of extractKeyUsages(content, varName)) {
        const fullKey = `${namespace}.${key}`;
        referencedPaths.add(fullKey);

        if (!namespaceUsage.has(namespace)) namespaceUsage.set(namespace, new Set());
        namespaceUsage.get(namespace).add(key);

        const enValue = enFlat[fullKey];
        const koValue = koFlat[fullKey];
        if (enValue === undefined) issues.push({ file, namespace, key, fullKey, type: 'missing_en' });
        if (koValue === undefined) issues.push({ file, namespace, key, fullKey, type: 'missing_ko' });
      }
    }
  });

  // ── AC3 — messages → 코드(dead key). en.json을 SSOT로 순회(ko는 phrase-collision 가드가
  // 따로 en/ko 짝을 지킨다 — 이 스캔은 「코드가 안 읽는다」만 잰다, en/ko 짝 불일치는 다른 자리).
  const deadCandidates = [];
  for (const flatPath of Object.keys(enFlat)) {
    if (referencedPaths.has(flatPath)) continue;
    if (isDynamicallyComposed(flatPath)) continue;
    // story #3420 — 방향③(테이블 선언, 네임스페이스 없는 bare 키)이 참조하는 키를 dead
    // 후보에서 뺀다. bare 키는 어느 네임스페이스에도 실릴 수 있어 suffix 매치로 본다.
    const bareSegment = flatPath.slice(flatPath.lastIndexOf('.') + 1);
    if (tableReferencedBareKeys.has(bareSegment)) continue;
    deadCandidates.push(flatPath);
  }

  // ── Report ──
  console.log('\n=== Translation Key Validation Report (story #2371) ===\n');

  console.log('① 코드 → messages (missing)');
  if (issues.length === 0) {
    console.log('  ✅ 0건\n');
  } else {
    const missingEn = issues.filter(i => i.type === 'missing_en');
    const missingKo = issues.filter(i => i.type === 'missing_ko');
    console.log(`  ❌ ${issues.length}건`);
    if (missingEn.length > 0) {
      console.log(`\n  🚨 Missing in en.json (${missingEn.length}):`);
      missingEn.forEach(i => console.log(`    - ${i.fullKey} (used in ${i.file})`));
    }
    if (missingKo.length > 0) {
      console.log(`\n  🚨 Missing in ko.json (${missingKo.length}):`);
      missingKo.forEach(i => console.log(`    - ${i.fullKey} (used in ${i.file})`));
    }
    console.log('');
  }

  const dynamicallyExempted = Object.keys(enFlat).filter(isDynamicallyComposed).length;
  console.log('② messages → 코드 (dead-key 후보 — ⛔목록일 뿐, 이 도구는 지우지 않는다·AC6)');
  console.log(`  후보 ${deadCandidates.length}건 · 동적조합 화이트리스트로 제외 ${dynamicallyExempted}건`);
  if (deadCandidates.length > 0 && process.env.I18N_SHOW_DEAD === '1') {
    deadCandidates.forEach(k => console.log(`    - ${k}`));
  }
  console.log('  (전체 목록: I18N_SHOW_DEAD=1 node scripts/check-i18n-keys.js)\n');

  console.log('Namespace usage summary:');
  for (const [namespace, keys] of namespaceUsage.entries()) {
    console.log(`  ${namespace}: ${keys.size} keys`);
  }
  console.log('');

  if (issues.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { flatten, escapeRegExp, stripComments, isDynamicallyComposed, extractKeyUsages, DYNAMIC_KEY_PREFIXES, extractTableKeyLiterals, existsInFlat, main };
