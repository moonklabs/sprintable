import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export const metadata = { title: 'Terms of Service — Sprintable' };

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-muted py-12">
      <div className="mx-auto max-w-2xl px-4">
        <div className="mb-8 flex items-center gap-3">
          <Link href="/">
            <SprintableLogo variant="mark" className="text-foreground" markClassName="h-8" />
          </Link>
          <h1 className="text-2xl font-bold text-foreground">Terms of Service</h1>
        </div>

        <div className="rounded-2xl bg-background p-8 shadow-sm space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p className="text-xs text-muted-foreground/60">Last updated: May 2026</p>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p>By accessing or using Sprintable, you agree to be bound by these Terms of Service. If you do not agree, do not use the service.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">2. Use of Service</h2>
            <p>Sprintable is an AI-powered sprint management platform. You may use the service for lawful purposes only and in accordance with these terms.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">3. User Accounts</h2>
            <p>You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">4. Intellectual Property</h2>
            <p>All content and functionality on Sprintable is the exclusive property of Moonklabs and is protected by applicable intellectual property laws.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">5. Limitation of Liability</h2>
            <p>Sprintable is provided &quot;as is&quot; without warranties of any kind. In no event shall Moonklabs be liable for any indirect, incidental, or consequential damages.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">6. Changes to Terms</h2>
            <p>We reserve the right to modify these terms at any time. Continued use of the service after changes constitutes acceptance of the new terms.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-foreground">7. Contact</h2>
            <p>For questions about these terms, contact us at <a href="mailto:legal@moonklabs.com" className="text-brand hover:underline">legal@moonklabs.com</a>.</p>
          </section>

          <p className="text-xs text-muted-foreground/60 pt-4 border-t border-border/50">
            This is a placeholder document. Full terms will be provided before public launch.
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link href="/privacy" className="text-brand hover:text-brand/80">Privacy Policy</Link>
          {' · '}
          <Link href="/register" className="text-brand hover:text-brand/80">Back to Sign Up</Link>
        </p>
      </div>
    </div>
  );
}
