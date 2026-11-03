import type { ConfigField, TaskModels, TaskPriority } from '../graphql/operations';

/** Libellé court d'un modèle : « sonnet 5.5 » pour claude-sonnet-5-5(-20261001), « sonnet » pour l'alias. */
export const shortModel = (model: string | null | undefined): string | null =>
  model
    ? model
        .replace(/^claude-/, '')
        .replace(/-\d{8}$/, '')
        .replace(/-(\d)-(\d)$/, ' $1.$2')
        .replace(/-(\d)$/, ' $1')
    : null;

/** Modèle de la famille Opus (le plus coûteux) : la sidebar ne signale que les autres. */
export const isOpus = (model: string | null | undefined): boolean => /opus/i.test(model ?? '');

/** Libellés des priorités, dans l'ordre du formulaire du projet. */
export const PRIORITY_MODEL_KEYS: { key: keyof TaskModels; label: string }[] = [
  { key: 'low', label: 'Basse' },
  { key: 'medium', label: 'Moyenne' },
  { key: 'high', label: 'Haute' },
  { key: 'urgent', label: 'Urgente' },
];

/** Modèle que le projet propose pour une tâche : celui de sa priorité, sinon le défaut du projet ; null : aucun. */
export function projectModelForTask(project: { defaultModel: string | null; taskModels: TaskModels | null } | null | undefined, priority: TaskPriority | null | undefined): string | null {
  if (!project) return null;
  const key = priority ? (priority.toLowerCase() as keyof TaskModels) : null;
  return (key ? project.taskModels?.[key] : null) || project.defaultModel || null;
}

/** Modèles proposables (options du champ « model » du provider Claude, sans l'option vide « par défaut »). */
export function modelOptions(fields: ConfigField[] | undefined): { value: string; label: string }[] {
  const field = fields?.find((f) => f.key === 'model');
  return (field?.options ?? []).filter((o) => o.value).map((o) => ({ value: o.value, label: o.label }));
}

/** Modèles par priorité nettoyés pour l'envoi : valeurs vides retirées, null quand rien n'est réglé. */
export function cleanTaskModels(models: TaskModels): TaskModels | null {
  const out: TaskModels = {};
  for (const { key } of PRIORITY_MODEL_KEYS) if (models[key]?.trim()) out[key] = models[key]!.trim();
  return Object.keys(out).length ? out : null;
}
