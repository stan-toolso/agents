-- Budget par planification : plafond de coût d'une exécution (la session est arrêtée quand il est atteint) et budget
-- mensuel (au-delà, les échéances sont ignorées et notifiées). NULL : pas de plafond. Montants en USD.
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS max_run_usd numeric(12, 4);
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS monthly_budget_usd numeric(12, 2);

-- Consommation d'une session (coût d'une exécution, consommation du mois d'une planification).
CREATE INDEX IF NOT EXISTS usage_ledger_session_idx ON usage_ledger (session_id, recorded_at);
