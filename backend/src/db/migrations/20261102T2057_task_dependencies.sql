-- ---- Dépendances entre tâches (« bloquée par ») et enchaînement automatique -------------------------------------
-- task_id dépend de depends_on_task_id : tant que celle-ci n'est pas terminée (une dépendance annulée bloque encore :
-- on la retire explicitement), task_id est bloquée et ne peut pas être confiée à un agent. Même projet, sans cycle.
CREATE TABLE task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX task_dependencies_depends_on_idx ON task_dependencies (depends_on_task_id);

-- « Lancer automatiquement quand débloquée » : quand la dernière dépendance se termine, la tâche est confiée à une
-- session (configuration par défaut du projet) au nom de la personne (ou de l'agent) qui a armé l'option. L'option
-- est consommée au lancement.
ALTER TABLE tasks ADD COLUMN auto_start_when_unblocked boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN auto_start_by_id uuid REFERENCES users (id) ON DELETE SET NULL;
