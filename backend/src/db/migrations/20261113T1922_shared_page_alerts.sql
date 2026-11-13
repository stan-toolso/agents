-- ---- Artefacts de données : alertes sur les sources ------------------------------------------------------------------
-- Une règle (chemin, opérateur, valeur) porte sur une source d'un artefact de données ; elle est évaluée à chaque
-- rafraîchissement et ne déclenche ses actions (notification, session) qu'au franchissement : `state` passe de `ok` à
-- `firing` (puis revient). `streak` : évaluations consécutives contraires à l'état courant (anti-rebond `for`).
-- `last_value` : dernières valeurs sélectionnées (affichage, opérateur `changed`). `session_id` / `session_at` : dernière
-- session lancée par l'alerte (une par heure au plus).
-- Les définitions sont versionnées avec la page : `shared_page_versions.alerts` (null : inconnues ou pas d'alerte).
-- Additif (bleu/vert) : l'ancienne instance ignore ces tables.
CREATE TABLE IF NOT EXISTS shared_page_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES shared_pages(id) ON DELETE CASCADE,
  name text NOT NULL,
  source text NOT NULL,
  config jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'ok', 'firing')),
  streak int NOT NULL DEFAULT 0,
  last_value jsonb,
  evaluated_at timestamptz,
  triggered_at timestamptz,
  resolved_at timestamptz,
  fire_count int NOT NULL DEFAULT 0,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  session_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, name)
);

ALTER TABLE shared_page_versions ADD COLUMN IF NOT EXISTS alerts jsonb;
