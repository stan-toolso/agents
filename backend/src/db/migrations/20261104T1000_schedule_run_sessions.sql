-- Chaque exécution d'une planification a désormais sa propre session (au lieu de renvoyer l'instruction à la
-- session de la planification). La session de la planification porte les réglages (provider, modèle, mode
-- d'autorisation, propriétaire) ; chaque exécution en crée une nouvelle, dans son propre dossier de travail.
-- Compatible bleu/vert : l'ancienne version ignore ces colonnes (run_session_id null = exécution dans la session
-- de la planification, comme avant).
ALTER TABLE session_schedule_runs ADD COLUMN IF NOT EXISTS run_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS session_schedule_runs_run_session_idx ON session_schedule_runs (run_session_id) WHERE run_session_id IS NOT NULL;

-- Archivage automatique des sessions d'exécution :
--   on_finish        archivée dès la fin de l'exécution
--   previous_on_run  les précédentes sont archivées au lancement d'une nouvelle exécution (défaut)
--   after_delay      archivée archive_after_minutes après la fin de l'exécution
--   never            jamais archivée d'office
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS archive_policy text NOT NULL DEFAULT 'previous_on_run';
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS archive_after_minutes integer;
