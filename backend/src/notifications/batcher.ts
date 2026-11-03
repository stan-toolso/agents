/**
 * Anti-rafale des canaux de notification (Slack, Discord, e-mail) : par canal, la première notification part tout
 * de suite ; celles qui suivent dans la fenêtre (une minute) sont gardées et envoyées ensemble à sa fin, en un seul
 * message. Une notification urgente (demande d'un agent) part toujours aussitôt, sans attendre le regroupement.
 * Mémoire de l'instance seulement : `flushAll` vide tout à l'arrêt.
 */

export interface BatcherOptions<T> {
  windowMs: number;
  send: (key: string, items: T[]) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Slot<T> {
  lastSentAt: number;
  pending: T[];
  timer: unknown;
}

export interface Batcher<T> {
  push(key: string, item: T, urgent?: boolean): void;
  /** Envoie tout ce qui attend (arrêt du serveur) ; résout quand les envois sont partis. */
  flushAll(): Promise<void>;
  /** Nombre d'éléments en attente (tests). */
  pendingCount(key: string): number;
}

export function createBatcher<T>(opts: BatcherOptions<T>): Batcher<T> {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const slots = new Map<string, Slot<T>>();

  const emit = (key: string, items: T[]): Promise<void> => opts.send(key, items).catch(() => undefined);

  const flush = (key: string): Promise<void> => {
    const slot = slots.get(key);
    if (!slot) return Promise.resolve();
    if (slot.timer !== null) clearTimer(slot.timer);
    slot.timer = null;
    const items = slot.pending;
    slot.pending = [];
    if (!items.length) return Promise.resolve();
    slot.lastSentAt = now();
    return emit(key, items);
  };

  return {
    push(key, item, urgent = false) {
      let slot = slots.get(key);
      if (!slot) {
        slot = { lastSentAt: -Infinity, pending: [], timer: null };
        slots.set(key, slot);
      }
      const t = now();
      if (urgent || (slot.timer === null && t - slot.lastSentAt >= opts.windowMs)) {
        if (!urgent) slot.lastSentAt = t;
        void emit(key, [item]);
        return;
      }
      slot.pending.push(item);
      if (slot.timer === null) slot.timer = setTimer(() => void flush(key), Math.max(0, slot.lastSentAt + opts.windowMs - t));
    },
    async flushAll() {
      await Promise.all([...slots.keys()].map((k) => flush(k)));
    },
    pendingCount: (key) => slots.get(key)?.pending.length ?? 0,
  };
}
