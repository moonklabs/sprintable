import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { getCurrentLegalDocument } from '@/lib/legal-docs';
import { BusinessInfoBlock } from '@/components/legal/legal-footer';
// story #3493 — 시행일은 법률 문서의 고정 날짜("약속")다. 방금 시행됐다고 해서
// "3일 전"으로 decay하면 안 되므로(formatRelativeTime 오분류였다), §11-2 정본
// (formatScheduledAt)으로 절대 표기.
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

export const metadata = { title: 'Terms of Service — Sprintable' };
export const revalidate = 300;

export default async function TermsPage() {
  const doc = await getCurrentLegalDocument('terms');

  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="mx-auto max-w-2xl px-4">
        <div className="mb-8 flex items-center gap-3">
          <Link href="/">
            <SprintableLogo variant="mark" className="text-foreground" markClassName="h-8" />
          </Link>
          <h1 className="text-2xl font-bold text-foreground">이용약관</h1>
        </div>

        <div className="rounded-2xl bg-background p-8 shadow-sm">
          {doc ? (
            <>
              <p className="mb-6 text-xs text-muted-foreground">
                시행일: {formatScheduledAt(doc.effectiveFrom, resolveDisplayTimezone().tz).display}
              </p>
              <DocContentRenderer content={doc.content} contentFormat={doc.contentFormat} publicMode />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              이용약관을 준비 중입니다. 문의: <a href="mailto:legal@moonklabs.com" className="text-brand hover:underline">legal@moonklabs.com</a>
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link href="/privacy" className="text-brand hover:text-brand/80">개인정보처리방침</Link>
          {' · '}
          <Link href="/refund-policy" className="text-brand hover:text-brand/80">환불정책</Link>
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
