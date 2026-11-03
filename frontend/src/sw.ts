/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0] };

/**
 * Service worker de Skipper : coquille de l'application en cache (navigation hors ligne), mise à jour sur
 * demande, et notifications push (notifications système, badge de l'icône, clic qui ouvre la page concernée).
 */
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// /forge/ : la forge Forgejo des dépôts hébergés, servie par nginx sur le même domaine (pas l'application).
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/graphql/, /^\/terminals\//, /^\/browsers\//, /^\/auth\//, /^\/api\//, /^\/privacy\.html$/, /^\/forge(\/|$)/] }));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

interface PushPayload {
  id: string;
  title: string;
  body?: string | null;
  link?: string | null;
  tag?: string;
  /** Non-lues du destinataire ; -1 : inconnu. */
  unread?: number;
  /** Demande d'autorisation : boutons « Autoriser » / « Refuser » et jeton signé pour y répondre sans ouvrir Skipper. */
  actions?: { action: string; title: string }[];
  actionToken?: string;
}

interface NotificationData {
  link?: string;
  actionToken?: string;
}

/** Safari / iOS révoque un abonnement dont une notification n'affiche rien : on affiche toujours chez WebKit. */
const mustAlwaysShow = /AppleWebKit/.test(self.navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(self.navigator.userAgent);

self.addEventListener('push', (event) => {
  let payload: PushPayload | null = null;
  try {
    payload = event.data?.json() as PushPayload;
  } catch {
    payload = null;
  }
  if (!payload?.title) return;
  const p = payload;
  event.waitUntil(
    (async () => {
      try {
        if (typeof p.unread === 'number' && p.unread >= 0) {
          if (p.unread > 0) await self.navigator.setAppBadge?.(p.unread);
          else await self.navigator.clearAppBadge?.();
        }
      } catch {
        /* badge indisponible */
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = clients.some((c) => c.focused);
      // Une fenêtre au premier plan a déjà la cloche ; la notification système n'apporterait que du bruit.
      if (focused && p.id !== 'test' && !mustAlwaysShow) return;
      // Les boutons ne s'affichent que là où le navigateur les gère (Chrome, Edge, Android) ; ailleurs, le clic ouvre la demande.
      const maxActions = (Notification as unknown as { maxActions?: number }).maxActions ?? 2;
      const actions = p.actionToken && p.actions?.length ? p.actions.slice(0, maxActions) : [];
      await self.registration.showNotification(p.title, {
        body: p.body ?? undefined,
        tag: p.tag ?? `skipper-${p.id}`,
        icon: '/icon-192.png',
        data: { link: p.link ?? '/', ...(actions.length ? { actionToken: p.actionToken } : {}) } satisfies NotificationData,
        ...(actions.length ? { actions, requireInteraction: true } : {}),
      } as NotificationOptions);
    })(),
  );
});

/** Répond à la demande depuis la notification ; null si la réponse n'a pas pu partir (réseau). */
async function answerFromNotification(token: string, action: string): Promise<{ ok: boolean; message: string } | null> {
  try {
    const res = await fetch('/api/push/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, action }), credentials: 'omit' });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: res.ok, message: body.message ?? (res.ok ? 'Fait' : 'Réponse impossible') };
  } catch {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data as NotificationData | undefined) ?? {};
  const raw = data.link ?? '/';
  const link = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  event.waitUntil(
    (async () => {
      // Bouton « Autoriser » / « Refuser » : réponse sans ouvrir Skipper, accusé discret par une notification silencieuse.
      if ((event.action === 'allow' || event.action === 'deny') && data.actionToken) {
        const result = await answerFromNotification(data.actionToken, event.action);
        if (result) {
          await self.registration.showNotification(result.message, { body: event.notification.body, tag: event.notification.tag, icon: '/icon-192.png', silent: true, data: { link } });
          if (result.ok) return;
        }
        // Échec (demande déjà réglée, droits, réseau) : on ouvre la session pour que la personne voie où elle en est.
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = clients.find((c) => c.focused) ?? clients[0];
      if (target) {
        await target.focus();
        target.postMessage({ type: 'skipper:navigate', link });
      } else {
        await self.clients.openWindow(link);
      }
    })(),
  );
});
