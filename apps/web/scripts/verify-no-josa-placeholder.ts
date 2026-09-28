/**
 * story #4120([E-RECIPE-1·Phase 3 폴리시], PO 실측 2026-09-21) — #4117(PR #4497)이
 * 「{name}을(를) 해지할까요」류 raw 조사 플레이스홀더 1자리를 pickEulReulJosa로 고쳤지만
 * 같은 클래스가 ko.json 11+키·BE gate_service.py 1건에 더 남아 있었다(이 카드가 전부
 * 처리). 재발을 막는 회귀가드 — 값이 실제로 노출되는 세 표면(ko.json 값·apps/web/src·
 * backend/app)에 「을(를)」「이(가)」「은(는)」「와(과)」가 그 형태 그대로(조사를 문자열에
 * 고정하는 그 실수) 다시 생기면 FAIL한다.
 *
 * 판정 — 여는 괄호 바로 앞이 공백이 아닌 자리(`\S(를)` 류)만 잡는다. 이 4패턴은 항상 앞
 * 낱말에 **공백 없이 바로 붙는** josa 자리에서만 버그로 나타난다("노트북을(를)"이지
 * "노트북 을(를)"이 아니다) — 이 요건이 없으면 "PO (가) 결정"처럼 완전히 무관한 괄호
 * 병기(옵션 A/B 표기 등)까지 오탐한다(derive-now-face.ts에서 실측 — 앞이 공백).
 *
 * GRANDFATHER 없음(카드 명시 baseline 0) — 이 스토리가 알려진 자리를 전부 고친 뒤의
 * 첫 스캔이 0건이라 clean-slate로 연다(verify-no-hardcoded-app-domain.ts 선례와 동형).
 *
 * 스코프 — 테스트/스크립트 파일 제외(카드 명시). ko.json은 en.json과 달리 조사가
 * 존재하는 유일한 로케일이라(en 무변 경계) en.json은 스캔하지 않는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC_ROOT = path.resolve(SCRIPT_DIR, '../src');
const KO_MESSAGES_PATH = path.resolve(SCRIPT_DIR, '../messages/ko.json');
const BACKEND_APP_ROOT = path.resolve(SCRIPT_DIR, '../../../backend/app');

const JOSA_PATTERNS: { label: string; re: RegExp }[] = [
  { label: '을(를)', re: /\S\(를\)/g },
  { label: '이(가)', re: /\S\(가\)/g },
  { label: '은(는)', re: /\S\(는\)/g },
  { label: '와(과)', re: /\S\(와\)/g },
];

export interface JosaPlaceholderHit {
  file: string;
  line: number;
  label: string;
  snippet: string;
}

export function findJosaPlaceholdersInText(content: string, file: string): JosaPlaceholderHit[] {
  const hits: JosaPlaceholderHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const { label, re } of JOSA_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) hits.push({ file, line: i + 1, label, snippet: line.trim() });
    }
  }
  return hits;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function findJosaPlaceholdersInMessages(root: Record<string, unknown>, filename: string): JosaPlaceholderHit[] {
  const hits: JosaPlaceholderHit[] = [];
  function walk(node: unknown, keyPath: string): void {
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, keyPath ? `${keyPath}.${k}` : k);
      return;
    }
    if (typeof node === 'string') {
      for (const { label, re } of JOSA_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(node)) hits.push({ file: filename, line: 0, label, snippet: `${keyPath} = ${JSON.stringify(node)}` });
      }
    }
  }
  walk(root, '');
  return hits;
}

const TEST_RE = /\.(test|spec)\.[jt]sx?$/;
const SRC_EXT_RE = /\.(tsx?|jsx?)$/;
const PY_EXT_RE = /\.py$/;
const PY_TEST_DIR_RE = /(^|\/)tests(\/|$)/;

function walk(dir: string, extRe: RegExp, excludeDirRe: RegExp | null, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (excludeDirRe && excludeDirRe.test(full)) continue;
      walk(full, extRe, excludeDirRe, out);
    } else if (extRe.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

export function scanWebSrc(srcRoot: string): JosaPlaceholderHit[] {
  const files: string[] = [];
  walk(srcRoot, SRC_EXT_RE, null, files);
  const hits: JosaPlaceholderHit[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    hits.push(...findJosaPlaceholdersInText(readFileSync(abs, 'utf8'), `apps/web/src/${rel}`));
  }
  return hits;
}

export function scanBackendApp(appRoot: string): JosaPlaceholderHit[] {
  const files: string[] = [];
  walk(appRoot, PY_EXT_RE, PY_TEST_DIR_RE, files);
  const hits: JosaPlaceholderHit[] = [];
  for (const abs of files) {
    const rel = path.relative(appRoot, abs).split(path.sep).join('/');
    hits.push(...findJosaPlaceholdersInText(readFileSync(abs, 'utf8'), `backend/app/${rel}`));
  }
  return hits;
}

export function scanKoMessages(filePath: string): JosaPlaceholderHit[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  return findJosaPlaceholdersInMessages(parsed, 'apps/web/messages/ko.json');
}

export function scanRepository(): JosaPlaceholderHit[] {
  return [
    ...scanKoMessages(KO_MESSAGES_PATH),
    ...scanWebSrc(WEB_SRC_ROOT),
    ...scanBackendApp(BACKEND_APP_ROOT),
  ];
}

function main(): void {
  const hits = scanRepository();

  if (hits.length > 0) {
    console.log(`❌ 조사 플레이스홀더(문자열에 조사를 안 고르고 고정) ${hits.length}건 발견:`);
    for (const h of hits) {
      const loc = h.line > 0 ? `${h.file}:${h.line}` : h.file;
      console.log(`  - [${h.label}] ${loc} — ${h.snippet}`);
    }
    console.log(
      '\n→ 값의 받침 유무에 맞춰 렌더 시점에 조사를 고른다(apps/web/src/lib/korean-particle.ts의' +
        ' pickEulReulJosa/pickIGaJosa/pickEunNeunJosa, BE는 app/utils/korean_particle.py의' +
        ' pick_i_ga_josa) — 문자열에 고정 병기하지 않는다(story #4117/#4120 처방과 동형).',
    );
    process.exit(1);
  }

  console.log('OK: ko.json·apps/web/src·backend/app 전부 조사 플레이스홀더(을(를)/이(가)/은(는)/와(과)) 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
