-- Crédits : seuls comptent les tours servis par le compte Claude de la cellule, ou par le compte d'un CTO Skipper.
-- (users.is_cto, profil CTO, vient de 20261107T1600_cto_time_tracking : ses sessions restent comptées même sur son
-- propre compte Claude.)
-- - usage_ledger.billable : le tour compte-t-il dans la consommation (crédits, budgets, relevé) ? Fixé à l'inscription
--   (billing/billable.ts) ; les lignes existantes restent comptées ;
-- - sessions.billed_cost_usd : cumul des seuls tours comptés, affiché comme coût de la session (cost_usd reste le
--   dernier total rapporté par le SDK, base des deltas).
-- Compatible bleu/vert : colonnes avec valeur par défaut, ignorées par l'ancienne version (ses tours restent comptés).
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS billable boolean NOT NULL DEFAULT true;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS billed_cost_usd numeric(12, 6);
UPDATE sessions SET billed_cost_usd = cost_usd WHERE billed_cost_usd IS NULL;
ALTER TABLE sessions ALTER COLUMN billed_cost_usd SET DEFAULT 0;
ALTER TABLE sessions ALTER COLUMN billed_cost_usd SET NOT NULL;
