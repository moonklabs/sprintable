/**
 * story #3876(§⑤ 낱말 드리프트 감사, PO 확定 2026-09-14) — JSX 텍스트 자식(children)에
 * 순 ASCII 영단어/구가 t() 없이 그대로 박히는 클래스를 고정한다. 실 사고: 스토리 패널의
 * `Dispatch`·`Labels`·`Dependencies`·`Blocked by`/`Blocking`/`Depends on`/`Depended by`·
 * `Acceptance Criteria` 8곳이 ko 로케일에서도 영문 그대로 노출(§⑤-1 낱말 표, doc a699be00)
 * — verify-no-hardcoded-korean-ui-text.ts(story #3741, 한글이 en 로케일에 새는 클래스)의
 * 거울상: 여기선 **영문이 ko 로케일에 새는** 클래스를 잡는다.
 *
 * ## 기전 — AST(verify-no-hardcoded-korean-ui-text.ts와 동형, 새 기전 발명 금지)
 * `apps/web/src` 전수(.tsx)를 walk, `JsxText` 노드만 본다(verify-no-hardcoded-korean-
 * ui-text.ts와 달리 StringLiteral 전체까지는 안 넓힌다 — 이 카드의 실 사고 전부가 JSX
 * **children** 자리였고, 속성값까지 넓히면 스코프가 이 카드 밖으로 크게 발산한다. 필요해
 * 지면 별도 스토리/축).
 *
 * ASCII_WORD_RE: 공백 트림 후 알파벳으로 시작, 알파벳/숫자/공백/하이픈/어퍼스트로피만으로
 * 구성된 문자열(2자 이상) — "Dispatch"·"Blocked by"·"Acceptance Criteria"류를 잡고,
 * 「·」·「—」·「/」·숫자 단독·빈 문자열은 첫 글자가 알파벳이 아니라 구조적으로 제외된다.
 *
 * ## baseline-freeze(story #3741/#3776 관례 그대로) + ALLOWLIST 이원화
 * ① ALLOWLIST — **영구** 예외(브랜드명·단위 약어처럼 번역 대상 자체가 아닌 것). 사유
 *    1줄 필수, PO 승인 없이 조용히 못 늘어난다(개수 실측이 그대로 계약).
 * ② BASELINE(JSON 파일) — 이 카드(#3876) 스코프 밖 **잔존 채무**(§⑤ 감사가 아직 안 돈
 *    화면 등). "더 늘지 않는다"만 보장, 전량 정리는 별건.
 * 늘어도(new)·줄어도(stale) FAIL — baseline은 "지금도 실재하는 위반의 정확한 목록"이어야
 * 한다는 계약(story #3776 ③-b와 동형).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface AsciiJsxTextRef {
  file: string;
  line: number;
  text: string;
}

// 알파벳 시작 + 알파벳/숫자/공백/하이픈/어퍼스트로피 반복, 2자 이상. 「SP」·「OK」류 2자
// 약어도 잡힌다 — ALLOWLIST에서 사유와 함께 개별 처리(임의 길이 하한으로 선제 배제하지
// 않는다, fail-closed 방향).
const ASCII_WORD_RE = /^[A-Za-z][A-Za-z0-9]*(?:[ '-][A-Za-z0-9]+)*$/;

export function scanContent(content: string, file: string): AsciiJsxTextRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics === undefined) {
    throw new Error(`FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심).`);
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const refs: AsciiJsxTextRef[] = [];
  function walk(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const trimmed = node.getText(sf).trim();
      if (trimmed.length >= 2 && ASCII_WORD_RE.test(trimmed)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        refs.push({ file, line, text: trimmed });
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

/** ref의 안정 키 — 파일+텍스트(줄 번호 제외, 인접 편집에 안 흔들리게 — story #3875
 * CHANGES·verify-no-handrolled-card.ts violationKey와 동일 계약). */
export function refKey(r: Pick<AsciiJsxTextRef, 'file' | 'text'>): string {
  return `${r.file}::${r.text}`;
}

// ALLOWLIST — 영구 예외(번역 대상 자체가 아님). story #3876 실측(apps/web/src 전수, 62건)
// 그라운딩 — 각 항목 실 코드 문맥 확認(추측 0) 후 분류.
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // 스토리 포인트 단위 약어("12 SP") — 국제 애자일 관례 약어, 번역 대상 아님.
  'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx::SP',
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx::SP',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::SP',
  // ISO 4217 통화 코드(KRW/USD) — 국제 표준 코드, 번역 대상 아님.
  'app/(authenticated)/organization/content-rules/page.tsx::KRW',
  'app/(authenticated)/organization/content-rules/page.tsx::USD',
  'components/content/boost-request-dialog.tsx::KRW',
  'components/content/boost-request-dialog.tsx::USD',
  // 데이터 용량 단위(GB) — 국제 표준 단위, 번역 대상 아님.
  'ee/components/billing/pricing-plan-card.tsx::GB',
  // SSE(Server-Sent Events) 프로토콜 약어 — 관리자/에이전트 상세 기술 배지, 그라운딩:
  // workforce/[id]/page.tsx:628 주석("Fakechat 채널 (SSE)") 확認, 프로토콜 고유명.
  'app/(authenticated)/organization/workforce/[id]/page.tsx::SSE',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::SSE',
  // 도구 권한 그룹 원시 식별자(mono·line-through로 "차단됨" 예시 표시, recruiter-client.tsx
  // :1423-1424 그라운딩) — 자연어 UI 카피가 아니라 config 키 표기 그 자체.
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::admin',
  'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::destructive',
  // 브랜드/제품 고유명사 — 번역 대상 아님.
  'app/share/layout.tsx::Sprintable',
  'components/brand/sprintable-logo.tsx::Sprintable',
  'components/ai/ai-generation-loading.tsx::Sprintable AI',
  'app/onboarding/connect-step.tsx::Claude Code',
  // 키보드 키 이름(Esc) — 전세계 공통 키캡 표기, 번역 대상 아님.
  'components/chat/asset-picker-popover.tsx::esc',
  'components/command-palette/command-palette.tsx::ESC',
  // 폰트 프리뷰 팬그램(라틴 글리프 시연용, font-preview.tsx 그라운딩) — 번역하면 목적
  // 자체(영문 글리프 표본)가 무의미해짐.
  "components/design-system/font-preview.tsx::The quick brown fox jumps over the lazy dog",
  // 코드블록/에디터 노드 기술 식별자(코드펜스 언어명·노드 타입 표기, 전세계 공통 미번역
  // 관례) — code-block-copy.tsx:52·math-node.tsx:51 그라운딩.
  'components/docs/extensions/code-block-copy.tsx::mermaid',
  'components/docs/extensions/math-node.tsx::math',
  // 내부 리워드 토큰 심볼(TJSB) — 통화 코드류 고유 심볼, 번역 대상 아님.
  'app/(authenticated)/rewards/page.tsx::TJSB',
  'components/agents/agent-performance-panel.tsx::TJSB',
  // LLM 토큰 수 단위 약어(tok) — 에이전트 실행 이력(기술 화면)의 단위 표기.
  'components/agents/agent-runs-list.tsx::tok',
]);

function walkTsxFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsxFiles(full, out);
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
}

const MIN_EXPECTED_TSX_FILES = 300;

export function scanRepo(srcRoot: string): AsciiJsxTextRef[] {
  const files: string[] = [];
  walkTsxFiles(srcRoot, files);
  if (files.length < MIN_EXPECTED_TSX_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const refs: AsciiJsxTextRef[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    refs.push(...scanContent(content, rel));
  }
  return refs;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'raw-ascii-jsx-text-baseline.json');

interface BaselineFile {
  _comment: string[];
  keys: string[];
}

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

export function computeNewViolations(refs: AsciiJsxTextRef[], allowlist: ReadonlySet<string>, baseline: ReadonlySet<string>): AsciiJsxTextRef[] {
  return refs.filter((r) => {
    const key = refKey(r);
    return !allowlist.has(key) && !baseline.has(key);
  });
}

export function computeStaleBaseline(refs: AsciiJsxTextRef[], baseline: ReadonlySet<string>): string[] {
  const foundKeys = new Set(refs.map(refKey));
  return [...baseline].filter((k) => !foundKeys.has(k));
}

function main(): number {
  let refs: AsciiJsxTextRef[];
  try {
    refs = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
  const staleBaseline = computeStaleBaseline(refs.filter((r) => !ALLOWLIST.has(refKey(r))), baseline);

  const fileCount = new Set(refs.map((r) => r.file)).size;
  console.log(
    `[story #3876] 순 ASCII JSX 텍스트 리터럴 스캔 — 검출 ${refs.length}건/${fileCount}파일 · ` +
      `ALLOWLIST ${ALLOWLIST.size}건 · baseline(grandfather) ${baseline.size}건 · ` +
      `신규 ${newViolations.length}건 · stale ${staleBaseline.length}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: ALLOWLIST/baseline에 없는 순 ASCII JSX 텍스트 발견(t() 없이 영문이 ko 로케일에 그대로 노출):');
    for (const r of newViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  - ${r.file}:${r.line} "${r.text}"`);
    }
    console.error(
      '\n→ next-intl i18n 키(messages/ko.json·en.json)로 옮길 것 — 새 낱말이 필요하면 §⑤ 낱말 표를 먼저 확定(유나) ' +
        '한 뒤 반영. 정말 번역 대상이 아니면(브랜드명·단위 약어 등) ALLOWLIST에 사유와 함께 등재(PO 승인), ' +
        '이 카드 스코프 밖이면 baseline에 등재(PO 승인).',
    );
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline에 ${staleBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다:`);
    for (const k of staleBaseline.sort()) console.error(`  - ${k}`);
    console.error('\n→ 고쳐졌다면(i18n 키로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  if (failed) return 1;

  console.log('\nOK: ALLOWLIST/baseline 초과 없음(신규 0건) · stale 0건(죽은 baseline 항목 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const refs = scanRepo(SRC_ROOT).filter((r) => !ALLOWLIST.has(refKey(r)));
    const keys = [...new Set(refs.map(refKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3876(§⑤ 낱말 드리프트) grandfather baseline — 이 가드 첫 도입 시점(스토리 패널 8곳',
        'fix 後) develop의 기존 순 ASCII JSX 텍스트 리터럴 잔존분(이 카드 스코프 밖 화면).',
        '마이그레이션 대상 아님 — 이 게이트는 "더 늘지 않는다"만 보장한다(freeze, 전량 정리는 후속 별건).',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
