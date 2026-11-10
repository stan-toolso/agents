import { registerSW } from 'virtual:pwa-register';

/** Événement Chrome/Android proposant l'installation ; on le garde pour le déclencher depuis un bouton. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((l) => l());
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  listeners.forEach((l) => l());
  return outcome === 'accepted';
}

export function onInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const updateListeners = new Set<() => void>();
let updateReady: (() => Promise<void>) | null = null;
let swRegistration: ServiceWorkerRegistration | null = null;

/** Enregistre le service worker ; une nouvelle version attend que l'utilisateur demande le rechargement. */
export function setupServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateReady = () => update(true);
      updateListeners.forEach((l) => l());
    },
    onRegisteredSW(_url, registration) {
      // Vérification horaire et au retour sur l'onglet.
      if (!registration) return;
      swRegistration = registration;
      setInterval(() => void registration.update(), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update();
      });
    },
  });
  // Navigation demandée par une notification système (service worker).
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; link?: string }>) => {
    if (e.data?.type === 'skipper:navigate' && typeof e.data.link === 'string') navigateListeners.forEach((l) => l(e.data.link!));
  });
}

export function onUpdateAvailable(listener: () => void): () => void {
  updateListeners.add(listener);
  if (updateReady) listener();
  return () => updateListeners.delete(listener);
}

/** Délai au-delà duquel on recharge même si le nouveau service worker n'a pas encore pris la main. */
export const RELOAD_FALLBACK_MS = 3000;
let reloading = false;

/**
 * Applique la nouvelle version et recharge la page, toujours. On ne s'en remet pas seulement à l'événement
 * « controlling » de workbox-window : il ne vient pas quand le worker en attente a déjà été activé par un
 * autre onglet, quand un déploiement suivant l'a remplacé, ou quand son activation traîne ; le clic restait alors
 * sans effet. Ici : message SKIP_WAITING au worker en attente (celui du moment), attente bornée du changement de
 * contrôleur, puis rechargement.
 */
export async function reloadForUpdate(): Promise<void> {
  if (reloading) return;
  reloading = true;
  const reload = () => window.location.reload();
  if (!('serviceWorker' in navigator)) return reload();
  const changed = new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
  });
  try {
    const registration = swRegistration ?? (await navigator.serviceWorker.getRegistration()) ?? null;
    const waiting = registration?.waiting ?? null;
    if (!waiting) return reload();
    waiting.postMessage({ type: 'SKIP_WAITING' });
  } catch {
    return reload();
  }
  await Promise.race([changed, new Promise<void>((resolve) => setTimeout(resolve, RELOAD_FALLBACK_MS))]);
  reload();
}

const navigateListeners = new Set<(link: string) => void>();
export function onPushNavigate(listener: (link: string) => void): () => void {
  navigateListeners.add(listener);
  return () => navigateListeners.delete(listener);
}
