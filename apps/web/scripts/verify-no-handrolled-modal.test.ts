import { describe, expect, it } from 'vitest';
import { findHandrolledModals } from './verify-no-handrolled-modal';

describe('findHandrolledModals — story #2061 회귀가드', () => {
  it('접근성 표식이 전혀 없는 손수 fixed inset-0 모달을 잡는다', () => {
    const src = `
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-card p-6">
            <h3>삭제 확인</h3>
          </div>
        </div>
      );
    `;
    const violations = findHandrolledModals(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.snippet).toContain('fixed inset-0');
  });

  it('role="dialog" aria-modal이 있으면(useFocusTrap 배선) 안전으로 판정한다', () => {
    const src = `
      <div
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="fixed inset-0 z-50 outline-none"
      >
        {children}
      </div>
    `;
    expect(findHandrolledModals(src)).toHaveLength(0);
  });

  it('role="alertdialog"도 안전으로 판정한다', () => {
    const src = `
      <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4">
        content
      </div>
    `;
    expect(findHandrolledModals(src)).toHaveLength(0);
  });

  it('DialogPrimitive.Backdrop/Popup(base-ui 캐노니컬)은 role 리터럴이 없어도 안전으로 판정한다', () => {
    const src = `
      <DialogPrimitive.Root open={open}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40" />
          <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50">
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    `;
    expect(findHandrolledModals(src)).toHaveLength(0);
  });

  it('DialogOverlay/DialogContent(공용 Dialog 래퍼)도 안전으로 판정한다', () => {
    const src = `
      function DialogOverlay({ className, ...props }) {
        return (
          <DialogPrimitive.Backdrop
            className={cn("fixed inset-0 isolate z-50 bg-black/50", className)}
            {...props}
          />
        );
      }
    `;
    expect(findHandrolledModals(src)).toHaveLength(0);
  });

  it('aria-hidden="true" 장식 backdrop(click-catcher)은 안전으로 판정한다', () => {
    const src = `
      <div
        className="fixed inset-0 z-40 bg-overlay-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
    `;
    expect(findHandrolledModals(src)).toHaveLength(0);
  });

  it('absolute inset-0(부모 컨테이너 채움, 썸네일/스켈레톤 등)은 대상이 아니다', () => {
    const src = `
      <div className="absolute inset-0 animate-pulse bg-muted" aria-hidden />
    `;
    expect(findHandrolledModals(src)).toHaveLength(0);
  });

  it('한 파일에 여러 위반이 있으면 전부(라인 번호와 함께) 잡는다', () => {
    const src = [
      'function A() {',
      '  return <div className="fixed inset-0 z-50 p-4">first</div>;',
      '}',
      'function B() {',
      '  return <div className="fixed inset-0 z-50 p-4">second</div>;',
      '}',
    ].join('\n');
    const violations = findHandrolledModals(src);
    expect(violations).toHaveLength(2);
    expect(violations[0]!.line).toBe(2);
    expect(violations[1]!.line).toBe(5);
  });

  it('먼 곳(윈도우 밖)의 무관한 role="dialog"는 안전판정에 영향을 주지 않는다', () => {
    const lines = ['<div role="dialog" aria-modal="true">unrelated far above</div>'];
    for (let i = 0; i < 20; i++) lines.push(`  <span>filler {${i}}</span>`);
    lines.push('<div className="fixed inset-0 z-50 p-4">no accessibility here</div>');
    const violations = findHandrolledModals(lines.join('\n'));
    expect(violations).toHaveLength(1);
  });
});
