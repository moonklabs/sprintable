import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export const metadata = { title: 'Privacy Policy — Sprintable' };

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="mx-auto max-w-2xl px-4">
        <div className="mb-8 flex items-center gap-3">
          <Link href="/">
            <SprintableLogo variant="mark" className="text-gray-900" markClassName="h-8" />
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-sm space-y-6 text-sm text-gray-700 leading-relaxed">
          <p className="text-xs text-gray-400">Last updated: May 2026</p>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">1. Information We Collect</h2>
            <p>We collect information you provide directly (e.g., email address, name) and information generated through your use of Sprintable (e.g., sprint data, activity logs).</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">2. How We Use Your Information</h2>
            <p>We use your information to provide and improve the Sprintable service, communicate with you, and ensure the security of your account.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">3. Data Sharing</h2>
            <p>We do not sell your personal information. We may share information with service providers who assist in operating our platform, subject to confidentiality agreements.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">4. Data Retention</h2>
            <p>We retain your data for as long as your account is active or as needed to provide services. You may request deletion of your data at any time.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">5. Security</h2>
            <p>We implement industry-standard security measures to protect your information. However, no method of transmission over the internet is 100% secure.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">6. Your Rights</h2>
            <p>Depending on your location, you may have rights to access, correct, or delete your personal information. Contact us to exercise these rights.</p>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold text-gray-900">7. Contact</h2>
            <p>For privacy inquiries, contact us at <a href="mailto:privacy@moonklabs.com" className="text-blue-600 hover:underline">privacy@moonklabs.com</a>.</p>
          </section>

          <p className="text-xs text-gray-400 pt-4 border-t border-gray-100">
            This is a placeholder document. Full privacy policy will be provided before public launch.
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          <Link href="/terms" className="text-blue-600 hover:text-blue-700">Terms of Service</Link>
          {' · '}
          <Link href="/register" className="text-blue-600 hover:text-blue-700">Back to Sign Up</Link>
        </p>
      </div>
    </div>
  );
}
