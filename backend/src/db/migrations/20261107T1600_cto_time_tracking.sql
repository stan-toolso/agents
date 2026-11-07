-- Suivi automatique du temps CTO (facturation de la cellule).
-- Un utilisateur « CTO » (users.is_cto, accordé par un super administrateur) voit chacune de ses interventions sur une
-- session (instruction, lancement, arrêt, réponse à une demande…) ou une conversation (message d'un canal ou du fil
-- d'une tâche, réaction) comptée par tranches de 10 minutes : la première intervention d'une tranche l'inscrit, les
-- suivantes de la même tranche n'ajoutent rien (clé primaire personne + début de tranche).
-- Chaque fin de journée, les tranches de la veille sont consolidées en saisies cto_time_entries « auto » (une par
-- personne, jour et projet), facturées comme les saisies manuelles.
ALTER TABLE users ADD COLUMN is_cto boolean NOT NULL DEFAULT false;

CREATE TABLE cto_activity_slots (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Début de la tranche de 10 minutes (multiple de 10 min depuis l'époque Unix).
  slot_start       timestamptz NOT NULL,
  -- Première intervention de la tranche : projet (null pour l'espace personnel), cible et mutation.
  project_id       uuid REFERENCES projects (id) ON DELETE SET NULL,
  target_type      text NOT NULL,
  target_id        uuid,
  action           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Rempli par la consolidation de fin de journée.
  consolidated_at  timestamptz,
  PRIMARY KEY (user_id, slot_start)
);

CREATE INDEX cto_activity_slots_pending_idx ON cto_activity_slots (slot_start) WHERE consolidated_at IS NULL;

-- Saisies issues de la consolidation : source « auto », personne suivie et nombre de tranches.
ALTER TABLE cto_time_entries ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto'));
ALTER TABLE cto_time_entries ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE cto_time_entries ADD COLUMN slots integer;
