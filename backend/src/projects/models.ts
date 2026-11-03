import { AppError } from '../errors.js';
import { TASK_PRIORITIES, type TaskPriority } from '../tasks/types.js';

/** Modèle des sessions de tâches par priorité (`{ low: 'sonnet' }`) ; une priorité absente suit le modèle du projet. */
export type TaskModels = Partial<Record<TaskPriority, string>>;

/** Nom de modèle saisi : alias du CLI (« sonnet ») ou identifiant complet ; vide ou absent : null (aucun). */
export function normalizeModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AppError('Le modèle doit être une chaîne');
  const v = value.trim();
  if (!v) return null;
  if (v.length > 100 || !/^[A-Za-z0-9._:\-[\]]+$/.test(v)) throw new AppError(`Nom de modèle invalide : ${v}`);
  return v;
}

/** Modèles par priorité : priorités connues seulement, valeurs vides retirées ; null quand rien n'est réglé. */
export function normalizeTaskModels(value: unknown): TaskModels | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('Les modèles par priorité doivent être un objet { priorité: modèle }');
  const out: TaskModels = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!TASK_PRIORITIES.includes(key as TaskPriority)) throw new AppError(`Priorité inconnue : ${key}`);
    const model = normalizeModel(raw);
    if (model) out[key as TaskPriority] = model;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Modèle que le projet propose pour une nouvelle session : celui de la priorité de la tâche réalisée s'il est réglé,
 * sinon le modèle par défaut du projet ; null : le projet n'impose rien (modèle par défaut du propriétaire).
 */
export function projectModelFor(project: { defaultModel: string | null; taskModels: TaskModels | null }, priority?: TaskPriority | null): string | null {
  return (priority ? project.taskModels?.[priority] : null) ?? project.defaultModel ?? null;
}
