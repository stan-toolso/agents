import { AppError } from '../errors.js';
import { SCHEDULE_ARCHIVE_POLICIES, type ScheduleArchivePolicy, type SessionScheduleInput } from './types.js';

/** Délai d'archivage maximal (`after_delay`) : 90 jours. */
const MAX_ARCHIVE_DELAY_MIN = 90 * 24 * 60;

/** Archivage validé pour l'enregistrement ; undefined : inchangé. */
export function validArchive(input: Pick<SessionScheduleInput, 'archivePolicy' | 'archiveAfterMinutes'>): { policy: ScheduleArchivePolicy; afterMinutes: number | null } | undefined {
  if (input.archivePolicy === undefined || input.archivePolicy === null) return undefined;
  const policy = String(input.archivePolicy).toLowerCase() as ScheduleArchivePolicy;
  if (!SCHEDULE_ARCHIVE_POLICIES.includes(policy)) throw new AppError(`Archivage inconnu : ${input.archivePolicy}`);
  if (policy !== 'after_delay') return { policy, afterMinutes: null };
  const minutes = Math.round(Number(input.archiveAfterMinutes));
  if (!Number.isFinite(minutes) || minutes < 1) throw new AppError("Indiquez après combien de temps archiver la session d'une exécution terminée");
  if (minutes > MAX_ARCHIVE_DELAY_MIN) throw new AppError('Délai d’archivage trop long (90 jours au plus)');
  return { policy, afterMinutes: minutes };
}

/** Nom de la session d'une exécution : celui de la planification et la date (dans son fuseau). */
export function runSessionName(label: string, at: Date, timezone: string): string {
  let when: string;
  try {
    when = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);
  } catch {
    when = at.toISOString().slice(0, 16).replace('T', ' ');
  }
  return `${label} · ${when}`.slice(0, 120);
}

