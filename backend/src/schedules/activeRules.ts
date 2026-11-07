import { log } from '../log.js';
import { scheduleRepository } from './repository.js';

/**
 * Outils pré-autorisés applicables maintenant à une session : ceux de sa planification si une exécution
 * planifiée est en cours, sinon null. Lu par les providers à chaque appel d'outil soumis à autorisation, d'où
 * un cache de quelques secondes. Module sans dépendance vers les sessions (les providers l'importent).
 */
const TTL_MS = 5_000;
const cache = new Map<string, { at: number; rules: string[] | null }>();

export async function activeScheduleRules(sessionId: string): Promise<string[] | null> {
  const cached = cache.get(sessionId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rules;
  let rules: string[] | null = null;
  try {
    const found = await scheduleRepository.activeRunRules(sessionId);
    rules = found?.length ? found : null;
  } catch (err) {
    log.error('[schedules] lecture des outils pré-autorisés', err);
  }
  cache.set(sessionId, { at: Date.now(), rules });
  if (cache.size > 1000) for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS) cache.delete(k);
  return rules;
}

/** Oublie le cache d'une session (exécution ouverte ou close) ; null : de toutes (planification modifiée). */
export function forgetScheduleRules(sessionId: string | null): void {
  if (sessionId === null) cache.clear();
  else cache.delete(sessionId);
}
