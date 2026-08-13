import { describe, expect, it } from 'vitest';
import { scanContent } from './verify-cross-element-tint-text';

// 픽스처를 함수 본문으로 감싸 유효한 TSX로 만든다(scanContent는 파일 전체를 파싱).
const scan = (jsx: string) => scanContent(`function C(){return (${jsx})}`, 'fixture.tsx');
const count = (jsx: string) => scan(jsx).length;

describe('verify-cross-element-tint-text (story #2590 A — 교차-요소 정적 프리필터)', () => {
  // ── 측정규칙 ① text-warning + 조상 pale = 항상 결함(아이콘조차 라이트 <3.0) ──
  it('flags text-warning under a pale ancestor (부모 bg-tint / 자식 글자)', () => {
    expect(count(`<div className="bg-warning-tint"><p className="text-xs text-warning">경고</p></div>`)).toBe(1);
  });
  it('flags text-warning even as an icon (warning은 크기 무관 실패)', () => {
    expect(count(`<span className="bg-warning-tint"><Bot className="size-4 text-warning" /></span>`)).toBe(1);
  });

  // ── 측정규칙 ② success/info/destructive = «작은글자 + 강한-tint 조상»만 ──
  it('flags text-info small text under a strong-tint ancestor', () => {
    expect(count(`<div className="bg-info-tint"><span className="text-sm text-info">라벨</span></div>`)).toBe(1);
  });
  it('does NOT flag a success ICON on tint (아이콘 ≥3.0 통과)', () => {
    expect(count(`<div className="bg-success-tint"><Check className="size-4 text-success" /></div>`)).toBe(0);
  });
  it('does NOT flag on a faint bg-muted/N wrapper (실측 4.5+ 통과)', () => {
    expect(count(`<div className="bg-muted/40"><span className="text-xs text-info">정보</span></div>`)).toBe(0);
  });
  it('does NOT flag large text (≥18px) on tint (비텍스트 3.0 통과)', () => {
    expect(count(`<div className="bg-destructive-tint"><h2 className="text-[20px] text-destructive">헤더</h2></div>`)).toBe(0);
  });
  it('does NOT flag when there is no pale ancestor (bg-card 위)', () => {
    expect(count(`<div className="bg-card"><span className="text-xs text-info">정보</span></div>`)).toBe(0);
  });
  it('does NOT flag text-<X>-foreground (계열색 아님)', () => {
    expect(count(`<div className="bg-success-tint"><span className="text-xs text-success-foreground">ok</span></div>`)).toBe(0);
  });

  // ── AST 이점: ternary 양 branch가 둘 다 pale이면 «항상 pale»이므로 잡는다(regex는 못 잡던 것) ──
  it('flags when ancestor bg is a ternary with both branches pale (verdict-card형)', () => {
    expect(count(`<div className={verified ? "bg-success-tint" : "bg-info-tint"}><span className="text-sm text-success">판정</span></div>`)).toBe(1);
  });

  // ── same-element은 자매 same-literal 가드 소관 → 여기선 제외(중복 방지) ──
  it('does NOT flag same-element (자기 요소에 bg+글자 = verify-no-new-tint 소관)', () => {
    expect(count(`<span className="bg-info-tint text-xs text-info">x</span>`)).toBe(0);
  });

  // ── auditable suppress — 이유 있으면 통과, 이유 없으면 여전히 실패 ──
  it('suppresses with a reason (// tint-guard-ok: <reason>)', () => {
    const jsx = `<div className="bg-warning-tint">\n  {/* tint-guard-ok: 색이 데이터·PO 승인 #123 */}\n  <p className="text-xs text-warning">경고</p>\n</div>`;
    expect(count(jsx)).toBe(0);
  });
  it('does NOT suppress without a reason (이유 필수)', () => {
    const jsx = `<div className="bg-warning-tint">\n  {/* tint-guard-ok */}\n  <p className="text-xs text-warning">경고</p>\n</div>`;
    // 이유 없는 suppress는 «막힌 채로» 위반으로 남는다(밸브가 썩지 않게).
    expect(scan(jsx).some((v) => v.className.includes('suppress-without-reason'))).toBe(true);
  });
});
