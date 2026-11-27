// story 5048 ④-② (PO 11-27) — 아이콘 크기는 «단계»(sm 16 · md 20 · lg 24)로만 준다. 키트는 24 하나(글 16 : 아이콘 24) — 우리 글 14에는 조작 안 20 · 촘촘한 줄 안(13~14 글 옆) 16 · 빈 화면 · 큰 머리 24.
// 12 · 10은 12 글자 옆 칩 · 배지 안에서만 — 숫자로 직접 둔다(정적 검사는 «어느 글자 옆인지» 모르므로 허용). 14 · 16 · 18 · 20 · 32 같은 직접 크기(`size-3.5` · `h-4 w-4` · `size-8` · `size-[17px]` · `<Icon size={14}>`)는 이 영역에선 0.
// 영역 PR마다 `icon-size-areas/`에 파일이 하나씩 늘어난다(채팅 → 칸반 → 문서 → …). 되돌리면(직접 크기로) RED. nav/*(민)는 경계라 끝까지 제외.
// 검사 대상 = lucide 가져온 이름 + 이름이 `Icon`(으로 끝나는 · `<x.Icon>` 객체 멤버 꼴 포함) 컴포넌트 태그(동적 아이콘 변수 `<Icon>` · `<KindIcon>` · `<EntityIcon>` 포함)의 className + `…Glyph(…, 'size-…')` 호출 인자.
// 태그는 따옴표 · 중괄호를 따라 끝을 찾는다(`[&>svg]:` 의 `>` 에 속지 않음).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
// 영역 목록 = `icon-size-areas/*.txt`(영역마다 파일 하나 · 한 줄에 폴더 하나 · `#`는 주석). 영역 PR은 «새 파일 하나»만 더하므로 서로 같은 줄을 안 만진다(story 5048 ④ PO 11-27 — 한 배열을 늘리던 때는 PR마다 rebase · 새 머리 · 판정 다시).
const AREAS_DIR = join(__dirname, 'icon-size-areas');
const AREA_FILES = readdirSync(AREAS_DIR).filter((n) => n.endsWith('.txt')).sort();
const DIRS = AREA_FILES.flatMap((n) => readFileSync(join(AREAS_DIR, n), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
const RAW = /(?<![\w:-])(?:size|h|w)-(?:3\.5|4|4\.5|5|6|8|\[\d+(?:\.\d+)?px\])(?![\w.-])/;
const RAW_ICON_PROP = /\bsize=\{(?:14|16|18|20|24|32)\}/;
// «토큰 밖이 맞는 곳» — `파일::태그 앞 부분` 정확히 일치만(같은 파일에 새 자리가 생기면 RED) · 사유 한 줄. 이 목록이 자라는 diff는 PO가 본다.
const ALLOWED: Record<string, string> = {
  'components/chat/room-head.tsx::<Icon name="person" size={14} />': '폰 방 막대의 «사람 N · 에이전트 N» 수 단추 — 숫자 옆 칩 크기 14(16으로 키우면 390에서 단추가 화면 밖으로 밀림 · e2e/chat-phone-bar.4887 «the people count is on the screen» 이 잡음)',
  'components/chat/room-head.tsx::<Icon name="smart_toy" size={14} />': '위와 같은 수 단추의 둘째 수',
};


function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === 'node_modules') continue; yield* sources(p); continue; }
    if (!/\.tsx$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

/** `<Name` 에서 시작해 그 여는 태그의 끝(`>` · `/>`)까지 — 문자열 · 템플릿 · 중괄호 안의 `>` 는 건너뛴다. */
function openingTag(text: string, start: number): string {
  let i = start; let brace = 0; let quote = '';
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '>' && brace <= 0) { i++; break; }
  }
  return text.slice(start, i);
}

describe('아이콘 크기는 단계로만 — 5048 ④-②', () => {
  it.each(DIRS)('⭐%s: 아이콘 태그에 직접 크기 클래스(size-3.5 · h-4 w-4 · size-5 · size-8 · size-[17px] …) 0 · ds Icon에 숫자 크기(14 · 16 · 18 · 20 · 24 · 32) 0', (dir) => {
    const hits: string[] = [];
    for (const file of /\.tsx$/.test(dir) ? [join(SRC, dir)] : sources(join(SRC, dir))) {
      const text = readFileSync(file, 'utf8');
      const rel = file.slice(SRC.length + 1);
      const lucide = new Set<string>();
      for (const g of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/g)) {
        for (const raw of g[1]!.split(',')) { const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim(); if (n && /^[A-Z]/.test(n)) lucide.add(n); }
      }
      for (const m of text.matchAll(/<((?:[a-z]\w*\.)*[A-Z][A-Za-z0-9]*)\b/g)) {
        const name = m[1]!.split('.').pop()!; // `<item.Icon …>` 처럼 객체 멤버로 쓴 아이콘도 본다(codex 지적)
        if (!(lucide.has(name) || /(?:Icon|Glyph)$/.test(name))) continue;
        const tag = openingTag(text, m.index!);
        const key = `${rel}::${tag.replace(/\s+/g, ' ').slice(0, 60)}`;
        const bad = RAW.test(tag.replace(/data-[\w-]+="[^"]*"/g, '')) || (name === 'Icon' && RAW_ICON_PROP.test(tag));
        if (!bad) continue;
        if (Object.keys(ALLOWED).some((k) => key.startsWith(k))) continue;
        hits.push(key);
      }
      for (const m of text.matchAll(/\w*Glyph\([^)]*['"`][^'"`]*\b(?:size|h|w)-(?:3\.5|4|5|6|8|\[\d+(?:\.\d+)?px\])(?![\w.-])/g)) hits.push(`${rel}::${m[0].slice(0, 60)}`);
    }
    expect(hits).toEqual([]);
  });

  it('⭐영역 목록: 파일이 있고 · 폴더는 중복 없이 실제로 있다(죽은 줄 0 — 폴더가 사라지면 목록도 줄인다)', () => {
    expect(AREA_FILES.length).toBeGreaterThan(0);
    for (const n of AREA_FILES) { // 빈 파일 · 주석뿐인 파일은 «아무것도 안 검사하는데 초록»이 된다 — 파일마다 폴더가 하나 이상
      const dirs = readFileSync(join(AREAS_DIR, n), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      expect(dirs.length, n).toBeGreaterThan(0);
    }
    expect(DIRS.length).toBeGreaterThan(0);
    expect(new Set(DIRS).size).toBe(DIRS.length);
    for (const d of DIRS) expect(statSync(join(SRC, d)).isDirectory() || /\.tsx$/.test(d), d).toBe(true); // 폴더 · 또는 공용 부품 한 파일(`.tsx`)
    for (const d of DIRS.filter((x) => /\.tsx$/.test(x))) expect(statSync(join(SRC, d)).isFile(), d).toBe(true);
  });

  it('⭐허용 목록의 자리는 실제로 그 파일에 있다(죽은 항목 0 — 지우면 목록도 줄인다)', () => {
    for (const k of Object.keys(ALLOWED)) {
      const [file, snippet] = k.split('::') as [string, string];
      expect(readFileSync(join(SRC, file), 'utf8').includes(snippet), k).toBe(true);
    }
  });
});
