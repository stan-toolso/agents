-- Dates de cycle des tâches pour la vue pilotage (cycle time, vieillissement des tâches en cours, flux cumulé).
-- started_at : passage en cours (posé au premier passage en in_progress, ou en done sans être passée par en cours ;
-- effacé si la tâche revient à « à faire »). cancelled_at : passage en annulée (effacé à la réouverture).
-- Maintenues par taskRepository.create / update, comme completed_at.
ALTER TABLE tasks ADD COLUMN started_at timestamptz;
ALTER TABLE tasks ADD COLUMN cancelled_at timestamptz;

-- Reprise de l'existant, faute d'historique : le premier passage d'une session par la tâche (souvent sa prise),
-- sinon la création ; jamais après la fin.
UPDATE tasks t
   SET started_at = LEAST(
         COALESCE((SELECT min(ts.linked_at) FROM task_sessions ts WHERE ts.task_id = t.id), t.created_at),
         COALESCE(t.completed_at, 'infinity'::timestamptz))
 WHERE t.status IN ('in_progress', 'done');

-- Annulées : démarrées seulement si une session y est passée ; date d'annulation approchée par la dernière mise à jour.
UPDATE tasks t
   SET cancelled_at = t.updated_at,
       started_at = (SELECT LEAST(min(ts.linked_at), t.updated_at) FROM task_sessions ts WHERE ts.task_id = t.id)
 WHERE t.status = 'cancelled';
