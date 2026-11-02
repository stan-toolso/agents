-- ---- Limite de contexte par défaut des nouvelles sessions d'un projet -------------------------------------------
-- Réglage de la conversation (`sessions.cleanup` : contextAction « compact » ou « reset » et contextMaxTokens) donné
-- aux nouvelles sessions du projet qui n'en choisissent pas (sessions de tâches, sessions lancées par un agent) et
-- présélectionné dans le formulaire de lancement. Null : aucune limite, l'interface propose au-delà du seuil de
-- signalement (comportement d'avant). Les sessions existantes ne sont pas touchées.
ALTER TABLE projects ADD COLUMN default_context_cleanup jsonb;
