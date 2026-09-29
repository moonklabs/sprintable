'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import {
  canDisconnect, canManageDevices, deviceAgentCount, deviceDateOptions, markDisconnected, orderDevices, readDevices,
  type DesktopDevice,
} from '@/lib/desktop-devices';

/**
 * story #4424 — «연결된 기기» on /desktop (Yuna 0ebe65ef · PO adopted 15:42Z; its copy table is the source for every string).
 * An org owner/admin sees the org's devices and «연결 끊기», which revokes every key that setup handed out and only those
 * (4424 AC5 from the screen). A member sees the heading and one line — the list is asked for only after the role says owner/admin
 * (no 403, no error screen). No org column: the list is this org's only.
 */
export function DesktopDevices() {
  const t = useTranslations('desktop.devices');
  const tDesktop = useTranslations('desktop');
  const { orgId, orgMemberships, userName } = useDashboardContext();
  const manage = canManageDevices(orgMemberships.find((o) => o.orgId === orgId)?.role);
  const [devices, setDevices] = useState<DesktopDevice[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [asking, setAsking] = useState<DesktopDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setLoadFailed(false);
    setDevices(null);
    let alive = true;
    fetchWithAuth('/api/desktop/setups')
      .then(readDevices)
      .catch(() => null)
      .then((list) => {
        if (!alive) return;
        if (list) setDevices(list);
        else setLoadFailed(true);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => (manage ? load() : undefined), [manage, load]);

  const disconnect = async (device: DesktopDevice) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchWithAuth(`/api/desktop/setups/${device.setup_id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      setDevices((list) => (list ? markDisconnected(list, device.setup_id, new Date().toISOString(), userName ?? null) : list));
      setDone(device.device_name);
      setAsking(null);
      headingRef.current?.focus(); // the pressed button is gone — focus goes to the list heading
    } catch {
      setFailed(true); // said inside the dialog, which stays open
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="desktop-devices" aria-labelledby="desktop-devices-heading">
      <h2 id="desktop-devices-heading" ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-foreground outline-none">
        {t('title')}
      </h2>
      {!manage ? (
        <p className="text-xs text-muted-foreground" data-testid="desktop-devices-member">{t('member')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
          <p aria-live="polite" className="text-xs text-foreground" data-testid="desktop-devices-done">
            {done ? t('done', { device: done }) : null}
          </p>
          {loadFailed ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="desktop-devices-load-failed">
              {t('loadFailed')}
              <Button variant="outline" size="sm" onClick={load}>{t('retry')}</Button>
            </p>
          ) : devices === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {tDesktop('loading')}
            </p>
          ) : devices.length === 0 ? (
            <Card className="border-dashed px-4 py-5" data-testid="desktop-devices-empty">
              <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('emptyBody')}</p>
            </Card>
          ) : (
            <Card className="overflow-hidden p-0">
              <ul className="divide-y divide-border">
                {orderDevices(devices).map((d) => <DeviceRow key={d.setup_id} device={d} onDisconnect={() => { setFailed(false); setAsking(d); }} />)}
              </ul>
            </Card>
          )}
        </>
      )}
      <Dialog open={asking !== null} onOpenChange={(open) => { if (!open && !busy) setAsking(null); }}>
        <DialogContent showCloseButton={false} initialFocus={cancelRef}>
          <DialogHeader>
            <DialogTitle className="truncate" title={asking?.device_name}>{t('confirmTitle', { device: asking?.device_name ?? '' })}</DialogTitle>
            <DialogDescription>{t('confirmBody', { agents: t('agents', { count: asking ? deviceAgentCount(asking) : 0 }) })}</DialogDescription>
          </DialogHeader>
          {failed ? <p role="alert" className="text-sm text-destructive" data-testid="desktop-devices-failed">{t('failed')}</p> : null}
          <DialogFooter>
            <Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => setAsking(null)}>{t('cancel')}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => { if (asking) void disconnect(asking); }} data-testid="desktop-devices-confirm">
              {busy ? t('disconnecting') : t('disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DeviceRow({ device, onDisconnect }: { device: DesktopDevice; onDisconnect: () => void }) {
  const t = useTranslations('desktop.devices');
  const format = useFormatter();
  const off = device.state === 'disconnected';
  const count = deviceAgentCount(device);
  const at = off ? device.revoked_at : device.confirmed_at;
  const who = off ? device.revoked_by_name : device.confirmed_by_name;
  const date = at ? format.dateTime(new Date(at), deviceDateOptions(at)) : null;
  const stateLabel = device.state === 'handed_over' ? t('state.handed_over')
    : device.state === 'waiting_for_app' ? t('state.waiting_for_app')
    : device.state === 'not_handed_over' ? t('state.not_handed_over')
    : t('state.disconnected');
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3" data-testid="desktop-device-row" data-state={device.state}>
      <div className="min-w-0">
        <p className={`flex flex-wrap items-center gap-2 text-sm ${off ? 'font-medium text-muted-foreground' : 'font-semibold text-foreground'}`}>
          <span className="truncate" data-testid="desktop-device-name">{device.device_name}</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="desktop-device-state">
            <StateDot state={device.state} />
            <span className={device.state === 'handed_over' ? 'text-success' : undefined}>{stateLabel}</span>
          </span>
        </p>
        {device.state === 'not_handed_over' ? <p className="mt-0.5 break-keep text-xs text-muted-foreground">{t('notHandedOverWhy')}</p> : null}
        <p className="mt-0.5 break-keep text-xs text-muted-foreground" data-testid="desktop-device-meta">
          {t('agents', { count })}
          {date ? <>{' · '}{t(off ? 'disconnectedOn' : 'connectedOn', { date })}</> : null}
          {who ? <>{' · '}{t(off ? 'disconnectedBy' : 'connectedBy', { name: who })}</> : null}
        </p>
      </div>
      {canDisconnect(device) ? (
        <Button variant="outline" size="sm" onClick={onDisconnect} aria-label={t('disconnectAria', { device: device.device_name })} data-testid="desktop-device-disconnect">
          {t('disconnect')}
        </Button>
      ) : null}
    </li>
  );
}

function StateDot({ state }: { state: DesktopDevice['state'] }) {
  if (state === 'disconnected') return null;
  if (state === 'waiting_for_app') return <span aria-hidden className="inline-block size-1.5 rounded-full border border-muted-foreground" />;
  return <span aria-hidden className={`inline-block size-1.5 rounded-full ${state === 'handed_over' ? 'bg-success' : 'bg-muted-foreground'}`} />;
}
