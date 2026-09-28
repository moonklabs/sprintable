// story #4370 — 여러 줄 칸 초안 가드(유나 판정 (가) · 페드루 큐 «새 여러 줄 칸이 훅 없이 생기면 RED + 양성 대조»).
//
// 규칙: 여러 줄 칸(<textarea> · <OperatorTextarea> · <EntityAwareTextarea> · <Textarea> · <JsonField>)을 그리는 소스 파일은
// 셋 중 하나여야 한다 —
//   (1) 초안 훅(useFieldDraft / useJsonFieldDraft)을 직접 부른다,
//   (2) VIA: 초안을 가진 훅/파일에서 값을 받는다(그 출처가 실제로 초안 훅을 부르는지 · 이 파일이 출처를 import하는지 확인),
//   (3) EXEMPT: 닫히는 창 · 패널 밖(페이지 · 탭 · 인라인)이거나, 읽기 전용 표시이거나, 부품 정의 · 제어형 부품(값을 소유한 폼이 판단)이라 제외 — 사유와 함께.
// 새 파일이 여러 줄 칸을 그리는데 셋 다 아니면 RED — 초안을 달거나, 제외 사유를 EXEMPT에 적어 리뷰에서 판정받는다.
// 목록은 양방향: EXEMPT/VIA 항목이 사라졌거나 더는 여러 줄 칸을 안 그리거나(EXEMPT인데) 초안 훅을 부르게 되면 역시 RED(묵은 항목 제거).
// 확인 조작 제외(유나 규칙): 초안 키 surface 이름에 confirm · evidence · ack · consent가 들어가면 RED.
//
// 이 가드가 못 잡는 것(선언):
//   - 파일 단위다. 이미 초안 훅을 부르는 파일에 초안 없는 여러 줄 칸을 하나 더 넣어도 통과한다(표면별 4370 테스트가 그 몫).
//   - 제어형 부품(value/onChange를 부모가 줌)은 EXEMPT다. 새 창이 그 부품을 초안 없이 얹어도, 그 창 파일이 여러 줄 태그를 직접 그리지 않으면 못 잡는다.
//   - contentEditable · 리치 에디터(Tiptap 등)는 태그 목록에 없어 안 본다.
//   - «닫히는 창 안인가»는 판정하지 않는다 — 여러 줄 칸 전부를 대상으로 삼고, 창 밖인 것은 EXEMPT 사유로 사람이 가른다.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MULTILINE_TAG = /<(textarea|OperatorTextarea|EntityAwareTextarea|Textarea|JsonField)\b/u;
const DRAFT_CALL = /\buse(?:Json)?FieldDraft\s*[<(]/u;
const DRAFT_SURFACE = /surface:\s*['"]([^'"]+)['"]/gu;
const CONFIRM_LIKE = /confirm|evidence|\back|consent/iu;

/** 초안을 다른 파일(훅)에서 받는 파일 → 그 출처(src 기준 경로). */
const VIA: Record<string, { source: string; why: string }> = {
  'components/nav/context-switcher-chip.tsx': { source: 'hooks/use-unified-switcher.ts', why: '새 프로젝트 폼 초안은 useUnifiedSwitcher가 가진다' },
  'components/nav/unified-switcher.tsx': { source: 'hooks/use-unified-switcher.ts', why: '새 프로젝트 폼 초안은 useUnifiedSwitcher가 가진다' },
};

/** 초안 대상이 아닌 여러 줄 칸 파일 → 사유. */
const EXEMPT: Record<string, string> = {
  'app/(authenticated)/[ws]/[proj]/docs/[slug]/page.tsx': '페이지 본문 — 닫히는 창 · 패널 밖',
  'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx': '목표 상세 페이지 편집 폼 — 창 밖(파일의 창은 지우기 확인뿐)',
  'app/(authenticated)/[ws]/[proj]/retro/[id]/page.tsx': '회고 페이지 본문 — 창 밖',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx': '스탠드업 작성 페이지 폼 — 창 밖',
  'app/(authenticated)/channel/page.tsx': '페이지 본문 — 창 밖',
  'app/(authenticated)/content/[draftId]/page.tsx': '콘텐츠 초안 페이지 — 창 밖(서버 초안)',
  'app/(authenticated)/content/channel-posts/[draftId]/page.tsx': '채널 글 초안 페이지 — 창 밖(서버 초안)',
  'app/internal-dogfood/page.tsx': '내부 점검 페이지 — 창 밖',
  'app/onboarding/connect-step.tsx': '온보딩 단계 — 페이지 흐름, 창 밖',
  'app/onboarding/onboarding-form.tsx': '온보딩 폼 — 페이지 흐름, 창 밖',
  'components/agents/agent-api-key-manager.tsx': '읽기 전용 키 표시(readOnly) — 쓰는 칸 아님',
  'components/agents/agent-connection-settings-section.tsx': '에이전트 상세 페이지 섹션 — 창 밖',
  'components/chat/chat-input.tsx': '자체 보존(스레드 답글 localStorage) — 4370 인벤토리 19행 NO',
  'components/docs/doc-editor.tsx': '문서 편집기 — 페이지 본문, 창 밖',
  'components/epics/hypothesis-declaration-card.tsx': '제어형 부품 — 값을 소유한 폼(목표 만들기 초안)이 판단',
  'components/sprints/hypothesis-declaration-card.tsx': '제어형 부품 — 값을 소유한 폼(스프린트 만들기 · 빠른 선언 초안)이 판단',
  'components/hypotheses/hypothesis-form.tsx': '가설 섹션 인라인 폼 — 창 밖',
  'components/loops/variant-gallery.tsx': '루프 상세 페이지 인라인 — 창 밖',
  'components/organization/generation-connector-register-form.tsx': '연결 등록 페이지 폼 — 창 밖',
  'components/outcome/outcome-intent-fields.tsx': '제어형 부품 — 현재 JSX 소비처 없음(타입만 import)',
  'components/retro/sprint-close-cockpit.tsx': '회고 페이지 인라인 — 창 밖',
  'components/settings/workflow-line-editor-section.tsx': '설정 탭 섹션 — 창 밖',
  'components/shared/entity-aware-textarea.tsx': '부품 정의(여러 줄 칸 자체)',
  'components/ui/operator-control.tsx': '부품 정의(OperatorTextarea 자체)',
};

type Verdict = 'drafted' | 'via' | 'exempt' | 'undrafted' | 'none';

function classify(rel: string, source: string): Verdict {
  if (!MULTILINE_TAG.test(source)) return 'none';
  if (DRAFT_CALL.test(source)) return 'drafted';
  if (rel in VIA) return 'via';
  if (rel in EXEMPT) return 'exempt';
  return 'undrafted';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); continue; }
    if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((full) => ({ rel: path.relative(SRC, full).split(path.sep).join('/'), source: readFileSync(full, 'utf-8') }));

describe('여러 줄 칸 초안 가드(story #4370)', () => {
  it('양성 대조 — 창 안 여러 줄 칸에 초안 훅이 없으면 undrafted · 붙이면 drafted · 목록에 없는 새 파일도 잡는다', () => {
    const bare = `export function X() { return <Dialog open><DialogContent><textarea value={v} onChange={f} /></DialogContent></Dialog>; }`;
    const withDraft = `const [v, setV] = useFieldDraft({ surface: 's', targetId: null, field: 'f' }, '');\n${bare}`;
    const withJsonDraft = `const [f, setF] = useJsonFieldDraft<Form>({ surface: 's', targetId: null, field: 'form' }, EMPTY);\n${bare}`;
    expect(classify('components/new/new-dialog.tsx', bare)).toBe('undrafted');
    expect(classify('components/new/new-dialog.tsx', bare.replace('<textarea', '<OperatorTextarea'))).toBe('undrafted');
    expect(classify('components/new/new-dialog.tsx', withDraft)).toBe('drafted');
    expect(classify('components/new/new-dialog.tsx', withJsonDraft)).toBe('drafted');
    expect(classify('components/new/new-dialog.tsx', '<input value={v} />')).toBe('none');
  });

  it('⭐실제 소스 — 여러 줄 칸을 그리는 파일은 전부 초안 · VIA · EXEMPT 중 하나(아니면 RED)', () => {
    const undrafted = files.filter((f) => classify(f.rel, f.source) === 'undrafted').map((f) => f.rel);
    expect(
      undrafted,
      `여러 줄 칸이 초안 없이 생겼다: ${undrafted.join(', ')} — useFieldDraft/useJsonFieldDraft를 달거나(유나 판정 (가): 여러 줄 칸이 든 폼은 폼 전체), 창 밖 등 제외 사유를 EXEMPT에 적는다`,
    ).toEqual([]);
    // 하한 — 스캔이 비어서 통과하는 일이 없게(현재 초안 파일 16개 이상).
    expect(files.filter((f) => classify(f.rel, f.source) === 'drafted').length).toBeGreaterThanOrEqual(16);
  });

  it('목록 신선도 — EXEMPT는 아직 여러 줄 칸을 그리고 초안 훅을 안 부른다 · VIA는 출처가 초안 훅을 부르고 파일이 출처를 import한다', () => {
    const byRel = new Map(files.map((f) => [f.rel, f.source]));
    for (const [rel, why] of Object.entries(EXEMPT)) {
      const source = byRel.get(rel);
      expect(source, `EXEMPT 항목 파일이 없다(옮겨졌거나 지워짐): ${rel} — 목록에서 뺀다`).toBeDefined();
      expect(MULTILINE_TAG.test(source!), `EXEMPT ${rel}(${why})가 더는 여러 줄 칸을 안 그린다 — 목록에서 뺀다`).toBe(true);
      expect(DRAFT_CALL.test(source!), `EXEMPT ${rel}가 초안 훅을 부르게 됐다 — 목록에서 뺀다`).toBe(false);
    }
    for (const [rel, { source: from, why }] of Object.entries(VIA)) {
      const source = byRel.get(rel);
      expect(source, `VIA 항목 파일이 없다: ${rel}`).toBeDefined();
      expect(MULTILINE_TAG.test(source!), `VIA ${rel}(${why})가 더는 여러 줄 칸을 안 그린다 — 목록에서 뺀다`).toBe(true);
      const fromFull = path.join(SRC, from);
      expect(existsSync(fromFull), `VIA 출처가 없다: ${from}`).toBe(true);
      expect(DRAFT_CALL.test(readFileSync(fromFull, 'utf-8')), `VIA 출처 ${from}가 초안 훅을 안 부른다`).toBe(true);
      const importName = from.replace(/\.tsx?$/u, '');
      expect(source!.includes(`@/${importName}'`) || source!.includes(`@/${importName}"`), `VIA ${rel}가 출처 ${from}를 import하지 않는다`).toBe(true);
    }
  });

  it('확인 조작 제외(유나 규칙) — 초안 키 surface 이름에 confirm · evidence · ack · consent가 없다(양성 대조 포함)', () => {
    expect(CONFIRM_LIKE.test('delete-org-confirm')).toBe(true);
    expect(CONFIRM_LIKE.test('gate-evidence')).toBe(true);
    expect(CONFIRM_LIKE.test('risk-ack')).toBe(true);
    expect(CONFIRM_LIKE.test('gate-discuss')).toBe(false);
    expect(CONFIRM_LIKE.test('pin-authoring-feedback')).toBe(false);  // «back»이 든 낱말은 오탐 아님(낱말 경계)
    const surfaces = files.flatMap((f) => [...f.source.matchAll(DRAFT_SURFACE)].map((m) => `${f.rel}: ${m[1]}`));
    expect(surfaces.length).toBeGreaterThanOrEqual(16);
    const offending = surfaces.filter((s) => CONFIRM_LIKE.test(s.split(': ')[1]!));
    expect(offending, `확인 조작이 초안 키가 됐다: ${offending.join(', ')}`).toEqual([]);
  });
});
