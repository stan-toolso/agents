import { Link } from 'react-router-dom';
import type { TaskPerson, TaskPriority, TaskRef, TaskStatus } from '../graphql/operations';

const STATUS: Record<TaskStatus, string> = { TODO: 'À faire', IN_PROGRESS: 'En cours', DONE: 'Terminée', CANCELLED: 'Annulée' };
const PRIORITY: Record<TaskPriority, { label: string; icon: string }> = {
  URGENT: { label: 'Urgente', icon: 'bi-chevron-double-up' },
  HIGH: { label: 'Haute', icon: 'bi-chevron-up' },
  MEDIUM: { label: 'Moyenne', icon: 'bi-dash' },
  LOW: { label: 'Basse', icon: 'bi-chevron-down' },
};

/**
 * Statut d'une tâche : une pastille par étape (à faire gris, en cours bleu, terminée vert, annulée barrée) ; son
 * étiquette d'état (où en est le travail : « en revue », « bloquée »…), quand elle existe, suit dans la même pastille.
 */
export function TaskStatusBadge({ status, statusTag, className = '' }: { status: TaskStatus; statusTag?: string | null; className?: string }) {
  const label = STATUS[status];
  return (
    <span className={`task-status task-status-${status.toLowerCase()} ${className}`} title={statusTag ? `${label} · ${statusTag}` : undefined}>
      {label}
      {statusTag && <span className="task-status-tag">{statusTag}</span>}
    </span>
  );
}

/** Étiquettes d'une tâche en petites puces ; avec `onSelect`, ce sont des boutons (filtrer par étiquette). */
export function TaskTags({ tags, onSelect, className = '' }: { tags: string[]; onSelect?: (tag: string) => void; className?: string }) {
  if (tags.length === 0) return null;
  return (
    <span className={`task-tags ${className}`}>
      {tags.map((tag) =>
        onSelect ? (
          <button
            key={tag}
            type="button"
            className="task-tag"
            title={`Voir les tâches étiquetées « ${tag} »`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(tag);
            }}
          >
            {tag}
          </button>
        ) : (
          <span key={tag} className="task-tag">
            {tag}
          </span>
        ),
      )}
    </span>
  );
}

export function TaskPriorityBadge({ priority, short = false }: { priority: TaskPriority; short?: boolean }) {
  const p = PRIORITY[priority];
  return (
    <span className={`task-priority task-priority-${priority.toLowerCase()}`} title={`Priorité ${p.label.toLowerCase()}`}>
      <i className={`bi ${p.icon}`} />
      {!short && ` ${p.label}`}
    </span>
  );
}

/** « Nom <e-mail> », ou ce qui est renseigné. */
export function formatPerson(p: TaskPerson | null | undefined): string {
  if (!p) return '';
  if (p.name && p.email) return `${p.name} <${p.email}>`;
  return p.name ?? p.email ?? '';
}

export function PersonChip({ person, icon = 'bi-person-check' }: { person: TaskPerson | null | undefined; icon?: string }) {
  if (!person) return null;
  return (
    <span title={formatPerson(person)}>
      <i className={`bi ${icon} me-1`} />
      {person.name ?? person.email}
    </span>
  );
}

/** Texte avec les liens http(s) rendus cliquables. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>)]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export const isOverdue = (t: { dueDate: string | null; status: TaskStatus }) => Boolean(t.dueDate) && t.status !== 'DONE' && t.status !== 'CANCELLED' && t.dueDate! < new Date().toISOString().slice(0, 10);

/**
 * « Bloquée » : la tâche attend des dépendances non terminées (elle ne peut pas être confiée à un agent avant) ; le
 * cadenas s'accompagne d'un éclair quand elle sera lancée automatiquement une fois débloquée.
 */
export function TaskBlockedBadge({ task, short = false, className = '' }: { task: { blockedBy: TaskRef[]; autoStartWhenUnblocked: boolean }; short?: boolean; className?: string }) {
  if (!task.blockedBy.length) return null;
  const title = `Bloquée par ${task.blockedBy.map((t) => `« ${t.title} » (${STATUS[t.status].toLowerCase()})`).join(', ')}${task.autoStartWhenUnblocked ? ' · lancée automatiquement une fois débloquée' : ''}`;
  return (
    <span className={`task-blocked ${className}`} title={title}>
      <i className="bi bi-lock" aria-label={short ? 'bloquée' : undefined} />
      {!short && ` bloquée${task.blockedBy.length > 1 ? ` (${task.blockedBy.length})` : ''}`}
      {task.autoStartWhenUnblocked && <i className="bi bi-lightning-charge ms-1" aria-label="lancement automatique" />}
    </span>
  );
}

/** Liste de tâches liées (dépendances, tâches qui en dépendent), chacune avec son statut et un lien vers sa page. */
export function TaskRefList({ tasks }: { tasks: TaskRef[] }) {
  return (
    <ul className="task-ref-list">
      {tasks.map((t) => (
        <li key={t.id}>
          <TaskStatusBadge status={t.status} /> <Link to={`/tasks/${t.id}`}>{t.title}</Link>
        </li>
      ))}
    </ul>
  );
}
