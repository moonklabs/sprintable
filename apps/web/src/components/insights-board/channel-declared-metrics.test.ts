import { describe, expect, it } from 'vitest';
import { declaredMetricsForChannel } from './channel-declared-metrics';

// story #3697(Phase2·FE, 유나 § 確定 2026-09-08) — backend/app/services/channel_adapters.py::
// insight_metrics의 FE측 사본 회귀가드. BE 값이 갈리면 이 스토리의 핵심 규칙("선언 안 한
// 지표는 행 자체를 안 그린다")이 조용히 틀어진다.
describe('declaredMetricsForChannel — story #3697(BE channel_adapters.py 미러)', () => {
  it('hosted_site(블로그) — views·clicks만(channel_adapters.py:403)', () => {
    expect(declaredMetricsForChannel('hosted_site')).toEqual(['views', 'clicks']);
  });

  it('threads — views·engagements만(channel_adapters.py:177)', () => {
    expect(declaredMetricsForChannel('threads')).toEqual(['views', 'engagements']);
  });

  it('instagram — views·reach·engagements(channel_adapters.py:237)', () => {
    expect(declaredMetricsForChannel('instagram')).toEqual(['views', 'reach', 'engagements']);
  });

  it('facebook — impressions·reach·engagements·clicks·views(channel_adapters.py:326)', () => {
    expect(declaredMetricsForChannel('facebook')).toEqual(['impressions', 'reach', 'engagements', 'clicks', 'views']);
  });

  it('모르는 채널·wordpress·webhook — 빈 배열(지어내지 않는다, BE도 미선언)', () => {
    expect(declaredMetricsForChannel('wordpress')).toEqual([]);
    expect(declaredMetricsForChannel('webhook')).toEqual([]);
    expect(declaredMetricsForChannel('never-heard-of-this-channel')).toEqual([]);
  });

  it('hosted_site는 engagements를 선언하지 않는다(블로그에 그 개념 자체가 없음)', () => {
    expect(declaredMetricsForChannel('hosted_site')).not.toContain('engagements');
  });

  it('inflow_sessions/inflow_users는 어떤 채널에도 고정 선언되지 않는다(GA4 연결 여부는 row별 실측, 어댑터 고정값 아님)', () => {
    for (const channel of ['hosted_site', 'threads', 'instagram', 'facebook']) {
      expect(declaredMetricsForChannel(channel)).not.toContain('inflow_sessions');
      expect(declaredMetricsForChannel(channel)).not.toContain('inflow_users');
    }
  });

  it('stibee_sandbox — opens·delivered·clicks(channel_adapters.py:657, story #3813 PR3)', () => {
    expect(declaredMetricsForChannel('stibee_sandbox')).toEqual(['opens', 'delivered', 'clicks']);
  });

  it('실 stibee도 stibee_sandbox와 동형 3키 선언(story #3813 PR5-b, 실 클라이언트 착지)', () => {
    expect(declaredMetricsForChannel('stibee')).toEqual(['opens', 'delivered', 'clicks']);
  });
});
