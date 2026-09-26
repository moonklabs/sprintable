// [SID:4345] 부류 가드 — 호버로 드러나는 조작 요소(`group-hover:opacity-100` · `group-hover:block` 등)가
//   ① 호버 없는 기기(터치)에서 숨거나(숨김 토큰에 `pointer-fine:`이 없음 — 맨 `opacity-0` · 폭 기준 `sm:opacity-0` 등)
//   ② 키보드 초점에서 안 보이거나(초점 드러냄 `focus-within` · `focus-visible` · `group-focus-within`이 없음)
//   ③ `hidden` · `invisible`로 숨어 탭 순서에서 빠지면(드러냄이 display · visibility) RED다.
// 올바른 모양은 `lib/hover-reveal.ts`의 HOVER_REVEAL(4277 storage 선례와 같은 모양)이다.
// 원천 글자 스캔이라 한 줄 문자열 조각 단위로 본다: 숨김 · 드러냄 토큰을 서로 다른 조각으로 나눠 cn()에 넣은 모양은 못 본다(한계 — PR 본문 전수 표로 메움).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const PIECE = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g;
const B = String.raw`(?:^|[\s"'\x60])`; // 토큰 앞 경계(공백 · 따옴표)
const E = String.raw`(?=[\s"'\x60]|$)`; // 토큰 뒤 경계
const CHAIN = String.raw`((?:[^\s"'\x60:]+:)*)`; // 변형 사슬(`pointer-fine:sm:` 등)
const REVEAL = new RegExp(`${B}${CHAIN}(?:group-hover|peer-hover)(?:/[\\w-]+)?:(opacity-100|visible|block|flex|inline-flex|inline-block|grid)${E}`, 'g');
const HIDE = new RegExp(`${B}${CHAIN}(opacity-0|hidden|invisible)${E}`, 'g');
const FOCUS = new RegExp(`${B}${CHAIN}(?:group-)?focus(?:-visible|-within)(?:/[\\w-]+)?:opacity-100${E}`);

/** 한 문자열 조각의 판정 — 문제 없으면 null, 있으면 까닭. */
export function hoverRevealProblem(piece: string): string | null {
  const reveals = [...piece.matchAll(REVEAL)];
  if (!reveals.length) return null;
  if (reveals.some((m) => m[2] !== 'opacity-100')) return '숨김형(display · visibility) — 탭 순서에서 빠진다';
  const hides = [...piece.matchAll(HIDE)];
  if (!hides.length) return null; // 숨지 않는다(흐리게만 · 강조만)
  if (hides.some((m) => m[2] !== 'opacity-0')) return '숨김형(display · visibility) — 탭 순서에서 빠진다';
  if (hides.some((m) => !m[1].split(':').includes('pointer-fine'))) return '호버 없는 기기에서 숨는다(pointer-fine 아닌 숨김)';
  if (!FOCUS.test(piece)) return '키보드 초점에서 안 보인다(초점 드러냄 없음)';
  return null;
}

// 이유가 있는 제외 — 자리마다 조각 안 글자(needle)로 짚고, 짚은 자리가 사라지면(낡음) RED.
const EXEMPT: { file: string; needle: string; reason: string }[] = [
  {
    file: 'components/docs/doc-tree.tsx',
    needle: 'cursor-grab touch-none opacity-0',
    reason: '끌기 손잡이 = 마우스 전용: 센서가 터치를 안 받고(#1988) 키보드 센서도 없다 → tabIndex -1 · aria-hidden(PO 08:45Z · 렌더 테스트가 핀)',
  },
  {
    file: 'app/(authenticated)/chats/[conversation_id]/page.tsx',
    needle: 'group-hover/title:opacity-100',
    reason: '장식(aria-hidden 연필) — 조작은 늘 보이는 방 이름 버튼(aria-label «방 이름 바꾸기»)',
  },
  {
    file: 'components/kanban/story-detail-panel.tsx',
    needle: 'mt-1 shrink-0 text-xs text-muted-foreground opacity-0',
    reason: '장식(✎ 글리프) — 조작은 늘 보이는 제목 Button',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p, out); }
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

describe('호버 전용 조작 요소 부류 가드([SID:4345])', () => {
  it('양성 대조 — 옛 모양은 모두 RED', () => {
    const bad: [string, RegExp][] = [
      // 문서 트리 «⋮»(develop) — 맨 opacity-0
      ['absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition group-hover:opacity-100', /호버 없는 기기/],
      // 스토리 카드(develop) — 폭 기준(sm:) 숨김은 640 이상 터치에서 숨는다
      ['flex items-center gap-1.5 opacity-100 transition focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100', /호버 없는 기기/],
      // 문서 주소 칩(develop) — 초점은 있으나 터치에서 숨는다
      ['rounded opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100', /호버 없는 기기/],
      // 스토리 상세 의존 지우기(develop) — display:none
      ['h-auto min-h-0 min-w-0 hidden shrink-0 rounded p-0.5 hover:bg-muted group-hover:block', /숨김형/],
      ['hidden group-hover:flex items-center justify-center rounded-md p-1', /숨김형/],
      ['invisible group-hover:visible', /숨김형/],
      // pointer-fine로 숨겼어도 초점 드러냄이 없으면
      ['opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100', /키보드 초점/],
      // 이름 붙은 group도
      ['size-3 opacity-0 group-hover/title:opacity-100', /호버 없는 기기/],
    ];
    for (const [s, why] of bad) expect(hoverRevealProblem(`"${s}"`), s).toMatch(why);
    const ok = [
      // HOVER_REVEAL · storage 선례 · shadcn 사이드바(고친 뒤)
      'opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-fine:focus-within:opacity-100',
      'grid size-[26px] opacity-100 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100 data-[popup-open]:opacity-100',
      'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 aria-expanded:opacity-100 pointer-fine:lg:opacity-0',
      // 숨지 않음(흐리게 · 강조만)
      'absolute right-1 top-1 rounded p-1 opacity-60 transition hover:bg-black/10 group-hover/code:opacity-100',
    ];
    for (const s of ok) expect(hoverRevealProblem(`"${s}"`), s).toBeNull();
  });

  it('src 전체 .ts/.tsx에 호버 전용 조작 요소 0곳(이유 있는 제외만)', () => {
    const files = walk(SRC);
    expect(files.length, '스캔 재료가 비지 않았다(조용한 0 방지)').toBeGreaterThan(300);
    const hits: string[] = [];
    const used = new Set<number>();
    for (const f of files) {
      const rel = path.relative(SRC, f);
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(PIECE)) {
        const why = hoverRevealProblem(m[0]);
        if (!why) continue;
        const ex = EXEMPT.findIndex((x) => x.file === rel && m[0].includes(x.needle));
        if (ex >= 0) { used.add(ex); continue; }
        hits.push(`${rel}:${src.slice(0, m.index).split('\n').length} — ${why}`);
      }
    }
    expect(hits).toEqual([]);
    expect(EXEMPT.filter((_, i) => !used.has(i)).map((x) => `${x.file} «${x.needle}» 낡은 제외`)).toEqual([]);
  });
});
