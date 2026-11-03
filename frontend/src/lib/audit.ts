import { apiBaseUrl } from '../apollo';
import type { AuditActorKind, AuditEntry, AuditFilterInput } from '../graphql/audit';

/** Libellés des statuts de tâche tels que le backend les inscrit (minuscules). */
const TASK_STATUS: Record<string, string> = { todo: 'À faire', in_progress: 'En cours', done: 'Terminée', cancelled: 'Annulée' };

/** Noms des clés de détails les plus courantes. */
const KEY_LABELS: Record<string, string> = {
  status: 'statut', priority: 'priorité', fields: 'champs', paths: 'fichiers', path: 'chemin', enabled: 'activé', archived: 'archivé', email: 'e-mail',
  permission: 'permission', scope: 'portée', deleteBranch: 'branche supprimée', name: 'nom', title: 'titre', version: 'version', reason: 'raison',
};

const PRIORITY: Record<string, string> = { low: 'basse', medium: 'moyenne', high: 'haute', urgent: 'urgente' };

const short = (v: unknown, max = 120): string => {
  const s = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : typeof v === 'boolean' ? (v ? 'oui' : 'non') : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Résumé d'une ligne des détails d'une entrée (le détail complet reste dans l'infobulle et l'export CSV). */
export function auditDetailSummary(e: Pick<AuditEntry, 'action' | 'details'>): string {
  const d = e.details ?? {};
  switch (e.action) {
    case 'task.status':
      return `${TASK_STATUS[String(d.from)] ?? d.from} → ${TASK_STATUS[String(d.to)] ?? d.to}`;
    case 'request.answer': {
      if (d.decision) {
        const verdict = d.decision === 'allow' ? (d.always ? (d.scope === 'project' ? 'Autorisé pour le projet' : 'Autorisé pour la session') : 'Autorisé une fois') : 'Refusé';
        const rules = Array.isArray(d.rules) && d.rules.length ? ` : ${d.rules.join(', ')}` : '';
        return `${verdict}${rules}${d.message ? ` (« ${short(d.message, 80)} »)` : ''}`;
      }
      if (d.answers && typeof d.answers === 'object') return Object.values(d.answers as Record<string, unknown>).map((v) => short(v, 60)).join(' · ');
      return '';
    }
    case 'git.commit':
      return typeof d.message === 'string' ? `« ${short(d.message.split('\n')[0], 100)} »` : '';
    case 'git.checkout':
      return `${d.create ? 'nouvelle branche ' : ''}${d.branch ?? ''}`;
    case 'task.create':
      return [TASK_STATUS[String(d.status)], d.priority ? `priorité ${PRIORITY[String(d.priority)] ?? d.priority}` : null].filter(Boolean).join(' · ');
    case 'member.invite':
    case 'member.role':
      return d.role ? `rôle ${String(d.role).toLowerCase()}` : '';
  }
  const parts = Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${KEY_LABELS[k] ?? k} : ${short(v, 60)}`);
  return short(parts.join(' · '), 160);
}

/** Lien vers la cible, quand elle a une page. */
export function auditTargetLink(e: Pick<AuditEntry, 'targetType' | 'targetId' | 'action'>, projectId: string): string | null {
  if (!e.targetId || e.action.endsWith('.delete')) return null;
  switch (e.targetType) {
    case 'session':
      return `/sessions/${e.targetId}`;
    case 'task':
      return `/tasks/${e.targetId}`;
    case 'agent':
      return `/projects/${projectId}/agents/${e.targetId}`;
    case 'workflow':
      return `/workflows/${e.targetId}`;
    case 'page':
      return `/shared/${e.targetId}`;
    default:
      return null;
  }
}

/** Valeur du sélecteur « Acteur » : un type d'acteur (`kind:HUMAN`) ou une personne (`user:<id>`). */
export function actorFilter(value: string): Pick<AuditFilterInput, 'actorKind' | 'actorUserId'> {
  if (value.startsWith('kind:')) return { actorKind: value.slice(5) as AuditActorKind };
  if (value.startsWith('user:')) return { actorUserId: value.slice(5) };
  return {};
}

/** Période : début inclus (minuit du jour de début), fin exclue (lendemain du jour de fin), en heure locale. */
export function periodFilter(fromDay: string, toDay: string): Pick<AuditFilterInput, 'from' | 'to'> {
  const day = (s: string, plus = 0) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d + plus).toISOString();
  };
  return { from: fromDay ? day(fromDay) : null, to: toDay ? day(toDay, 1) : null };
}

/** URL de l'export CSV avec les mêmes filtres (route HTTP authentifiée par le cookie). */
export function auditCsvUrl(projectId: string, filter: AuditFilterInput): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) q.set(k, String(v));
  const qs = q.toString();
  return `${apiBaseUrl}/api/projects/${projectId}/audit.csv${qs ? `?${qs}` : ''}`;
}
