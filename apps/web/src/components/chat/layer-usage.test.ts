// 4906 — «화면 층 규칙»을 대화 방이 실제로 쓰는지 소스로 고정한다: 대화 방 바닥은 내용 칸 층, 글 줄은 층 토큰(옛 proof-*/muted 면으로 돌아가지 않는다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('대화 방은 화면 층 규칙의 토큰을 쓴다 (4906)', () => {
  it('⭐대화 방 바닥(ChatView 루트)은 바깥과 같은 바탕 LAYER.page 하나 — 방 안에만 따로 까는 판(LAYER.panel)이 없다(4916: 선생님 «채팅창 안에만 흰색 — 역겨움»)', () => {
    const src = read('chat-view.tsx');
    expect(src).toContain("import { LAYER } from '@/components/ds/layers'");
    expect(src).toContain('overflow-hidden ${LAYER.page}`');
    expect(src).not.toContain('overflow-hidden ${LAYER.panel}`'); // reverted to the white island → red
  });

  it('⭐말풍선: 남의 글 · 에이전트 글 = LAYER.rowOthers, 내 글 = LAYER.rowMine, 가림·삭제 말풍선도 글 줄 층 — 옛 proof 면 · bg-muted/50 0', () => {
    const src = read('chat-bubble.tsx');
    expect(src).toContain('${LAYER.rowMine}');
    expect(src).toContain('${LAYER.rowOthers}');
    for (const legacy of ['bg-proof-panel', 'bg-proof-blue-soft', 'rounded-tr-sm bg-muted/50', 'rounded-tl-sm bg-muted/50']) expect(src, legacy).not.toContain(legacy);
  });

  it('⭐말풍선 안 보조 글 · 링크 · 가림 글은 ds 글자 토큰(옛 muted-foreground/primary는 새 면 위에서 4.5:1 미달)', () => {
    const src = read('chat-bubble.tsx');
    expect(src).toContain("const muted = 'text-ds-ink-2'");
    expect(src).toContain('text-ds-action-text underline decoration-ds-action-text/40');
    expect(src).not.toMatch(/rounded-xl px-3\.5 py-2 text-sm italic text-muted-foreground/);
  });

  it('⭐스레드 칸: 바닥은 방과 같은 바탕 LAYER.page(따로 까는 판 · 옛 bg-background 0), 답글 줄(plainRow)도 글 줄 층 — 맨글로 바탕에 서지 않는다', () => {
    const thread = read('thread-panel.tsx');
    expect(thread).toContain("import { LAYER } from '@/components/ds/layers'");
    expect(thread).toContain('border-border ${LAYER.page}`}');
    expect(thread).not.toContain('border-border ${LAYER.panel}`}');
    expect(thread).not.toMatch(/border-l border-border bg-background/);
    const bubble = read('chat-bubble.tsx');
    expect(bubble).toContain('plainRow\n                ? `rounded-lg ${isMine ? LAYER.rowMine : LAYER.rowOthers} px-3 py-2`');
    expect(bubble).not.toContain("? 'py-0.5'\n                : isMine");
  });

  it('⭐에이전트 글은 맨글(py-0.5만)로 바탕에 서지 않는다 — 말풍선 분기에 층 클래스가 있다(plainRow만 맨글)', () => {
    const src = read('chat-bubble.tsx');
    expect(src).toMatch(/isAgent\s*\?\s*`rounded-lg rounded-tl-sm \$\{LAYER\.rowOthers\}/);
    expect(src).toContain("data-bubble={plainRow ? 'plain' : 'filled'}");
  });

  it('⭐입력칸 상자는 층 표의 입력칸(LAYER.field)을 쓴다 — 쪽 바탕 위에서 면 + line-control 경계가 함께 가른다(4916)', () => {
    const src = read('chat-input.tsx');
    expect(src).toContain("import { LAYER } from '@/components/ds/layers'");
    expect(src).toContain('border border-ds-line-control ${LAYER.field} px-0.5 py-1.5');
  });

  it('⭐읽기 패널 바닥도 같은 바탕(ds-background) — 방 · 스레드 · 읽기 패널이 한 면', () => {
    expect(read('reading-panel.tsx')).toContain('border-l border-border bg-ds-background');
  });
});
