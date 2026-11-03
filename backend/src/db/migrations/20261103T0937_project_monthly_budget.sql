-- Budget mensuel par projet (en plus du plafond mensuel de chaque personne) : au-delà, le projet ne lance plus de
-- session ni de tour (erreur BUDGET_EXCEEDED). Alerte par notification à 80 % puis à 100 %, une fois par mois et
-- par palier (budget_alert_month « AAAA-MM », budget_alert_level 80 ou 100).
ALTER TABLE projects ADD COLUMN monthly_budget_usd numeric(12, 2);
ALTER TABLE projects ADD COLUMN budget_alert_month text;
ALTER TABLE projects ADD COLUMN budget_alert_level integer;

-- Consommation d'un projet sur une période (budget, page Consommation).
CREATE INDEX usage_ledger_project_idx ON usage_ledger (project_id, recorded_at DESC);
