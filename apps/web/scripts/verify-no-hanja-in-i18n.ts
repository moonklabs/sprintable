/**
 * story #3432 AC2/AC3 — `messages/*.json`(값에만) 한자가 섞여 들어오면 CI가 빨갛게 된다.
 *
 * 배경(AC1 실측, 2026-09-04): 작업 대화에서 쓰는 표기(`확認`·`확定`)가 정본 문구로 그대로
 * 샌 사고가 `ko.json` 4,559키 전수 스캔에서 8건 나왔다(`認` 5건 + `定` 3건 — 한 글자만
 * 찾으면 같은 원인의 나머지가 남으므로 문자 클래스 전체(`\p{Script=Han}`)로 훑는다).
 * 같은 클래스 결함이 story #2441(2026-08-07)에서도 한 번 있었다 — 재발이라 이번엔 사람 눈
 * 대신 이 가드로 막는다.
 *
 * 판정 축은 **값(value)만**이다 — 키 이름·주석은 대상이 아니다(키는 코드 식별자이고 개발자만
 * 본다, 화면에 뜨는 것은 값뿐).
 *
 * 예외(HANJA_EXCEPTIONS)는 **비워 둔 채로 시작한다**. 사유 없는 예외는 왜 뚫렸는지 아무도
 * 모르게 되므로, 정말 필요해지면 key·char·reason·addedBy 네 필드를 모두 채워야 등록할 수
 * 있게 타입으로 강제한다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
const LOCALE_FILES = ['en.json', 'ko.json'];

const HAN_CHARS_GLOBAL = /\p{Script=Han}/gu;

export interface HanjaException {
  file: string;
  key: string;
  char: string;
  reason: string;
  addedBy: string;
}

// AC2: 시작은 항상 빈 배열. 항목을 추가할 땐 네 필드를 전부 채워야 한다(사유 없는 예외 금지).
export const HANJA_EXCEPTIONS: HanjaException[] = [];

function isExempt(file: string, key: string, char: string): boolean {
  return HANJA_EXCEPTIONS.some((e) => e.file === file && e.key === key && e.char === char);
}

export interface HanjaFinding {
  file: string;
  key: string;
  chars: string[];
  value: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function findHanjaInMessages(root: Record<string, unknown>, filename: string): HanjaFinding[] {
  const findings: HanjaFinding[] = [];

  function walk(node: unknown, prefix: string): void {
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
      return;
    }
    if (typeof node === 'string') {
      const matches = node.match(HAN_CHARS_GLOBAL);
      if (!matches) return;
      const chars = [...new Set(matches)].filter((c) => !isExempt(filename, prefix, c));
      if (chars.length > 0) {
        findings.push({ file: filename, key: prefix, chars, value: node });
      }
    }
  }

  walk(root, '');
  return findings;
}

export function scanLocaleFile(filePath: string, filename: string): HanjaFinding[] {
  const text = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return findHanjaInMessages(parsed, filename);
}

function main(): void {
  const allFindings: HanjaFinding[] = [];
  for (const filename of LOCALE_FILES) {
    const filePath = path.join(MESSAGES_DIR, filename);
    allFindings.push(...scanLocaleFile(filePath, filename));
  }

  if (allFindings.length > 0) {
    console.log(`❌ 사용자 문구 값에 한자 ${allFindings.length}건 발견:`);
    for (const f of allFindings) {
      console.log(`  - ${f.file} :: "${f.key}" [${f.chars.join(', ')}] → ${JSON.stringify(f.value)}`);
    }
    console.log(
      '\n→ 한자를 한글로 바꿔라(뜻·어조·길이는 그대로). 정말 필요한 예외라면 HANJA_EXCEPTIONS에' +
        ' key·char·reason·addedBy를 모두 채워 등록해야 한다(사유 없는 예외 금지).',
    );
    process.exit(1);
  }

  console.log(`OK: ${LOCALE_FILES.join(', ')} 전부 사용자 문구 값에 한자 0건`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
