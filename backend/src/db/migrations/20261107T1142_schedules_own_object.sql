-- La planification devient un objet à part entière, distinct des sessions : elle porte elle-même ses réglages
-- (projet, propriétaire, provider, modèle, mode d'autorisation) et chaque exécution lance une session indépendante.
-- Jusqu'ici, une « session de la planification » portait ces réglages sans jamais rien exécuter (et encombrait la
-- sidebar). Ses réglages sont recopiés ici ; elle est archivée au démarrage de la nouvelle version si elle n'a
-- jamais servi d'exécution.
--
-- Compatible bleu/vert (phase « expand ») : `session_id` reste, facultatif et unique, pour la version précédente
-- (ON CONFLICT (session_id), lectures par session) ; des déclencheurs complètent les nouvelles colonnes quand elle
-- écrit. Une migration ultérieure retirera `session_id` des deux tables et ces déclencheurs.

ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects (id) ON DELETE CASCADE;
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS requested_by_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'claude';
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Réglages repris de la session qui portait la planification ; son nom devient celui de la planification.
UPDATE session_schedules sc SET
  project_id = s.project_id,
  owner_id = s.owner_id,
  requested_by_id = s.requested_by_id,
  provider = COALESCE(s.provider, 'claude'),
  config = COALESCE(s.config, '{}'::jsonb),
  name = COALESCE(NULLIF(btrim(sc.name), ''), NULLIF(btrim(s.name), 'Session'))
FROM sessions s
WHERE s.id = sc.session_id AND sc.project_id IS NULL;

ALTER TABLE session_schedules ALTER COLUMN project_id SET NOT NULL;

-- Clé propre ; la session d'origine devient une simple référence (supprimer la session ne supprime plus la planification).
DO $$
BEGIN
  -- Seulement si la clé est encore session_id (migration rejouable).
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'session_schedules'::regclass AND c.contype = 'p' AND a.attname = 'session_id'
  ) THEN
    ALTER TABLE session_schedules DROP CONSTRAINT session_schedules_pkey;
    ALTER TABLE session_schedules ADD PRIMARY KEY (id);
  END IF;
END
$$;
ALTER TABLE session_schedules ALTER COLUMN session_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS session_schedules_session_uidx ON session_schedules (session_id);
ALTER TABLE session_schedules DROP CONSTRAINT IF EXISTS session_schedules_session_id_fkey;
ALTER TABLE session_schedules ADD CONSTRAINT session_schedules_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS session_schedules_project_idx ON session_schedules (project_id);

-- Historique : rattaché à la planification.
ALTER TABLE session_schedule_runs ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES session_schedules (id) ON DELETE CASCADE;
UPDATE session_schedule_runs r SET schedule_id = sc.id FROM session_schedules sc WHERE sc.session_id = r.session_id AND r.schedule_id IS NULL;
-- Exécutions d'avant la PR #194, jouées dans la session de la planification : c'était leur session d'exécution.
UPDATE session_schedule_runs SET run_session_id = session_id
WHERE run_session_id IS NULL AND session_id IS NOT NULL AND status NOT IN ('skipped', 'missed');
ALTER TABLE session_schedule_runs ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE session_schedule_runs DROP CONSTRAINT IF EXISTS session_schedule_runs_session_id_fkey;
ALTER TABLE session_schedule_runs ADD CONSTRAINT session_schedule_runs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS session_schedule_runs_schedule_idx ON session_schedule_runs (schedule_id, started_at DESC);

-- Écritures de la version précédente (bleu/vert) : elle ne connaît que session_id.
CREATE OR REPLACE FUNCTION session_schedules_fill_legacy() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NULL AND NEW.session_id IS NOT NULL THEN
    SELECT s.project_id, s.owner_id, s.requested_by_id, COALESCE(s.provider, 'claude'), COALESCE(s.config, '{}'::jsonb)
      INTO NEW.project_id, NEW.owner_id, NEW.requested_by_id, NEW.provider, NEW.config
      FROM sessions s WHERE s.id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_schedules_fill_legacy ON session_schedules;
CREATE TRIGGER session_schedules_fill_legacy BEFORE INSERT ON session_schedules FOR EACH ROW EXECUTE FUNCTION session_schedules_fill_legacy();

CREATE OR REPLACE FUNCTION session_schedule_runs_fill_legacy() RETURNS trigger AS $$
BEGIN
  IF NEW.schedule_id IS NULL AND NEW.session_id IS NOT NULL THEN
    SELECT sc.id INTO NEW.schedule_id FROM session_schedules sc WHERE sc.session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_schedule_runs_fill_legacy ON session_schedule_runs;
CREATE TRIGGER session_schedule_runs_fill_legacy BEFORE INSERT ON session_schedule_runs FOR EACH ROW EXECUTE FUNCTION session_schedule_runs_fill_legacy();
