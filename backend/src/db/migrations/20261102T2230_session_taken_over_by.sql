-- ---- Prise en main d'une session d'agent par une personne ------------------------------------------------------------
-- Une personne (demandeur de la session, gestionnaire de l'agent, administrateur du projet) peut « prendre la main » sur
-- la session d'un agent : la session reste celle de l'agent (propriétaire, coût, transcript), mais tourne avec les
-- comptes et les droits de cette personne (Claude, GitHub, GitLab, coffre) tant qu'elle ne l'a pas rendue.
ALTER TABLE sessions ADD COLUMN taken_over_by_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN taken_over_at timestamptz;
