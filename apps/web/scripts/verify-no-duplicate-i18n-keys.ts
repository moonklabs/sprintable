/**
 * story #2395([결함·FE] i18n 파일 sibling 중복 키) — 같은 부모 객체 안에서 키가 두 번 이상
 * 나오면(JSON 표준상 마지막 값이 조용히 이긴다·에러도 경고도 없음) CI가 잡는다.
 *
 * `JSON.parse`는 이 정보를 근본적으로 못 준다 — 파싱 시점에 이미 마지막 값으로 collapse돼
 * 있다(V8 내장 파서, object_pairs_hook 같은 훅 없음). 그래서 최소 recursive-descent JSON
 * 파서를 직접 짜서 객체를 "키-값 쌍의 배열"로 파싱한다(collapse 전 원본 순서 보존) —
 * `en.json`/`ko.json`이 실제로 이 순수-객체-트리(배열·중첩 문자열 객체) 모양이라 파서
 * 범위를 그 수준으로 최소화했다(전체 JSON 스펙 아님, 필요한 만큼만).
 *
 * AC1 실측(2026-08-17, story #2395): 이 스캐너로 전수한 결과 en.json·ko.json 합쳐 정확히
 * 4건(양쪽 2쌍씩, 전부 `goals` 네임스페이스) — `goals.loading`(값 같음, 무해)·
 * `goals.backToList`(값 다름, PO 판정 후 현재 활성값으로 확定). 둘 다 이 PR에서 제거됨 —
 * baseline은 0에서 시작한다(alembic 형제-PR 가드 story #2401과 동일 관례: 새로 생기는 것만
 * 막는다, 기존 채무 grandfather 불필요 — 채무 자체가 0이었으므로).
 *
 * ⛔이 가드가 «못 잡는» 것(AC6):
 *   ㉠ 배열 원소 안의 중첩 객체(예: `[{"a":1,"a":2}]`) — 이 코드베이스의 로케일 파일엔 배열이
 *     안 쓰이지만, 만약 쓰이게 되면 이 파서는 배열 원소를 일반 JSON.parse로 처리해(간소화)
 *     그 안의 중복은 못 잡는다. 지금은 해당 없음(실측: en/ko 전체에 배열 0개).
 *   ㉡ 다른 로케일 파일(en/ko 외 새 언어 추가 시) — `LOCALE_FILES` 상수에 수동으로 추가해야
 *     스캔 대상이 된다. 자동 발견 아님(파일 시스템 glob 대신 명시 목록 — 오타 방지).
 *   ㉢ 문법 오류(잘린 JSON 등)는 이 스캐너가 아니라 기존 `JSON.parse`(빌드·i18n-key-coverage)가
 *     먼저 잡는다 — 이 스캐너는 유효한 JSON 안의 sibling 중복만 본다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
const LOCALE_FILES = ['en.json', 'ko.json'];

type JsonValue = string | number | boolean | null | JsonValue[] | PairsObject;
/** 파싱 시점의 원본 [key, value] 배열 — 중복 키가 있으면 같은 key가 두 번 이상 나온다. */
type PairsObject = { __pairs: [string, JsonValue][] };

class ParseError extends Error {}

function parseJsonPreservingDuplicates(text: string): PairsObject {
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    while (i < n && /\s/.test(text[i]!)) i++;
  }

  function parseValue(): JsonValue {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return parseNumber();
  }

  function parseObject(): PairsObject {
    i++; // {
    const pairs: [string, JsonValue][] = [];
    skipWs();
    if (text[i] === '}') { i++; return { __pairs: pairs }; }
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[i] !== ':') throw new ParseError(`expected ':' at ${i}`);
      i++;
      const value = parseValue();
      pairs.push([key, value]);
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      throw new ParseError(`expected ',' or '}' at ${i}`);
    }
    return { __pairs: pairs };
  }

  function parseArray(): JsonValue[] {
    i++; // [
    const arr: JsonValue[] = [];
    skipWs();
    if (text[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      throw new ParseError(`expected ',' or ']' at ${i}`);
    }
    return arr;
  }

  function parseString(): string {
    if (text[i] !== '"') throw new ParseError(`expected '"' at ${i}`);
    i++;
    let out = '';
    while (text[i] !== '"') {
      if (i >= n) throw new ParseError('unterminated string');
      if (text[i] === '\\') {
        i++;
        const esc = text[i];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        if (esc === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
          i += 5;
        } else {
          out += map[esc!] ?? esc!;
          i++;
        }
      } else {
        out += text[i];
        i++;
      }
    }
    i++; // closing "
    return out;
  }

  function parseNumber(): number {
    const start = i;
    while (i < n && /[-+0-9.eE]/.test(text[i]!)) i++;
    return Number(text.slice(start, i));
  }

  const result = parseValue();
  skipWs();
  if (!(typeof result === 'object' && result !== null && '__pairs' in result)) {
    throw new ParseError('root is not an object');
  }
  return result as PairsObject;
}

export interface DuplicateFinding {
  file: string;
  path: string;
  value1: JsonValue;
  value2: JsonValue;
  sameValue: boolean;
}

function isPairsObject(v: JsonValue): v is PairsObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && '__pairs' in v;
}

export function findDuplicateSiblingKeys(pairsObj: PairsObject, filename: string): DuplicateFinding[] {
  const findings: DuplicateFinding[] = [];

  function walk(obj: PairsObject, prefix: string): void {
    const seen = new Map<string, JsonValue>();
    for (const [key, value] of obj.__pairs) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      if (isPairsObject(value)) {
        walk(value, fullPath);
      }
      if (seen.has(key)) {
        findings.push({
          file: filename, path: fullPath,
          value1: seen.get(key)!, value2: value,
          sameValue: JSON.stringify(seen.get(key)) === JSON.stringify(value),
        });
      }
      seen.set(key, value);
    }
  }

  walk(pairsObj, '');
  return findings;
}

export function scanLocaleFile(filePath: string, filename: string): DuplicateFinding[] {
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseJsonPreservingDuplicates(text);
  return findDuplicateSiblingKeys(parsed, filename);
}

function main(): void {
  const allFindings: DuplicateFinding[] = [];
  for (const filename of LOCALE_FILES) {
    const filePath = path.join(MESSAGES_DIR, filename);
    allFindings.push(...scanLocaleFile(filePath, filename));
  }

  if (allFindings.length > 0) {
    console.log(`❌ 같은 부모 안 sibling 중복 키 ${allFindings.length}건 발견:`);
    for (const f of allFindings) {
      const marker = f.sameValue ? '(값 같음 — 무해하나 죽은 무게)' : '(값 다름 — ⚠️ 화면에 안 뜨는 문구가 있다)';
      console.log(`  - ${f.file} :: "${f.path}" ${marker}`);
      if (!f.sameValue) {
        console.log(`      값1(죽음): ${JSON.stringify(f.value1)}`);
        console.log(`      값2(활성): ${JSON.stringify(f.value2)}`);
      }
    }
    console.log('\n→ 중복 중 하나를 지워라(값이 다르면 어느 쪽이 정본인지 먼저 판정 — story #2395 참고).');
    process.exit(1);
  }

  console.log(`OK: ${LOCALE_FILES.join(', ')} 전부 sibling 중복 키 0건`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
