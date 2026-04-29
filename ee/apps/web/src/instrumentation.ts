/**
 * Next.js 16 instrumentation hook (SaaS overlay).
 *
 * Two responsibilities:
 *   1. Bootstrap SaaS-only Repository registry overrides before any
 *      route handler runs (OSS core never imports @moonklabs/storage-saas).
 *   2. Load .env.production from the process cwd for the Node.js SSR
 *      Lambda runtime — Next.js 16 `standalone` server.js does NOT
 *      auto-load .env.production, so env values dumped by amplify.yml
 *      preBuild would otherwise be invisible to process.env.
 *
 * OSS builds do not include this file (overlay only).
 */
import { registerSaasRepositories } from '@/lib/storage/saas-bootstrap';

export async function register(): Promise<void> {
  // dotenv side-effect must run in Node runtime only — Edge has no process.cwd
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const [{ default: path }, dotenv] = await Promise.all([
      import('node:path'),
      import('dotenv'),
    ]);
    // override:false so Lambda/container-injected env wins over file values
    dotenv.config({
      path: path.join(process.cwd(), '.next', '.env.production'),
      override: false,
    });
  }

  registerSaasRepositories();
}
