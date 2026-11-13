-- Attente explicite d'une tâche en cours (« en attente » plutôt que « agent arrêté ») : date de réveil, ce qu'il faudra
-- vérifier, et date du dernier réveil traité (le réveil n'est fait qu'une fois par date posée). Migration d'ajout
-- seule : l'ancienne instance (bleu/vert) ignore ces colonnes.
ALTER TABLE tasks
  ADD COLUMN wake_at timestamptz,
  ADD COLUMN wake_note text,
  ADD COLUMN woken_at timestamptz;

CREATE INDEX tasks_wake_idx ON tasks (wake_at) WHERE wake_at IS NOT NULL AND status = 'in_progress';
