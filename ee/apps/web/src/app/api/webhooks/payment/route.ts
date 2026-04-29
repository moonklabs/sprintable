import { createClient } from '@supabase/supabase-js';
import { apiSuccess, apiError } from '@/lib/api-response';
import { getPaymentAdapter } from '@/lib/payment/factory';
import { SubscriptionService } from '@/services/subscription';

/**
 * POST /api/webhooks/payment
 * AC5+AC6: PG 웹훅 수신 → subscriptions 업데이트
 * AC8: Zod 검증 (어댑터 내부에서 서명 검증)
 */
export async function POST(request: Request) {
  try {
    // service_role — 웹훅은 인증 없이 PG에서 직접 호출
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const adapter = getPaymentAdapter();

    // 어댑터가 서명 검증 + 이벤트 파싱
    const event = await adapter.webhookHandler(request);

    // 구독 서비스로 이벤트 처리
    const service = new SubscriptionService(supabase);
    const result = await service.processWebhookEvent(event, adapter.provider);

    return apiSuccess(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Webhook processing failed';
    console.error('[payment-webhook]', msg);
    return apiError('WEBHOOK_ERROR', msg, 400);
  }
}
