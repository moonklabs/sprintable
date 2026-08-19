import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { getCurrentLegalDocument } from '@/lib/legal-docs';
import { BusinessInfoBlock } from '@/components/legal/legal-footer';

export const metadata = { title: 'Refund Policy — Sprintable' };
export const revalidate = 300;

export default async function RefundPolicyPage() {
  const doc = await getCurrentLegalDocument('refund_policy');

  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="mx-auto max-w-2xl px-4">
        <div className="mb-8 flex items-center gap-3">
          <Link href="/">
            <SprintableLogo variant="mark" className="text-foreground" markClassName="h-8" />
          </Link>
          <h1 className="text-2xl font-bold text-foreground">환불정책</h1>
        </div>

        <div className="rounded-2xl bg-background p-8 shadow-sm">
          {doc ? (
            <>
              <p className="mb-6 text-xs text-muted-foreground">
                시행일: {new Date(doc.effectiveFrom).toLocaleDateString('ko-KR')}
              </p>
              <DocContentRenderer content={doc.content} contentFormat={doc.contentFormat} publicMode />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              환불정책을 준비 중입니다. 문의: <a href="mailto:legal@moonklabs.com" className="text-brand hover:underline">legal@moonklabs.com</a>
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link href="/terms" className="text-brand hover:text-brand/80">이용약관</Link>
          {' · '}
          <Link href="/privacy" className="text-brand hover:text-brand/80">개인정보처리방침</Link>
          {' · '}
          <Link href="/register" className="text-brand hover:text-brand/80">회원가입으로 돌아가기</Link>
        </p>

        <div className="mt-4 text-center text-xs text-muted-foreground">
          <BusinessInfoBlock className="justify-center" />
        </div>
      </div>
    </div>
  );
}
