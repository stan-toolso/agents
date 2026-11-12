-- ---- Artefacts de données : sources « agent » (alimentées par une session) ----------------------------------------
-- Une source agent n'est pas une requête : à chaque rafraîchissement (planificateur ou bouton Rafraîchir), Skipper lance
-- une session (au nom du propriétaire de l'artefact, ou d'un agent du projet) avec la consigne de la source ; la session
-- écrit le résultat avec l'outil pages.set_data. `session_id` : la dernière session lancée pour la source ; `running` :
-- une session est en train de la calculer.
-- Additif (bleu/vert) : l'ancienne instance ne lance pas ces sources (elle les passe en erreur, les données restent).
ALTER TABLE shared_page_sources DROP CONSTRAINT IF EXISTS shared_page_sources_kind_check;
ALTER TABLE shared_page_sources ADD CONSTRAINT shared_page_sources_kind_check CHECK (kind IN ('sql', 'script', 'graphql', 'agent'));
ALTER TABLE shared_page_sources DROP CONSTRAINT IF EXISTS shared_page_sources_status_check;
ALTER TABLE shared_page_sources ADD CONSTRAINT shared_page_sources_status_check CHECK (status IN ('pending', 'ok', 'error', 'skipped', 'running'));
ALTER TABLE shared_page_sources ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;
