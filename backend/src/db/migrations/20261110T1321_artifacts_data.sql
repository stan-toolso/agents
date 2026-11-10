-- Artefacts : les pages partagées deviennent des artefacts typés. « page » : page HTML (comme avant) ; « data » :
-- page HTML alimentée par des sources de données (requête SQL d'un élément du coffre, script lancé dans
-- l'environnement du projet) que Skipper rafraîchit tout seul. Migration additive (bleu/vert) : l'ancienne
-- instance ignore les nouvelles colonnes.
ALTER TABLE shared_pages
  ADD COLUMN kind text NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'data')),
  -- Intervalle du rafraîchissement automatique (minutes) ; null : à la demande seulement.
  ADD COLUMN refresh_minutes integer CHECK (refresh_minutes IS NULL OR refresh_minutes BETWEEN 5 AND 10080),
  -- Dernière tentative de rafraîchissement (réussie ou non) : base de la prochaine échéance.
  ADD COLUMN data_refreshed_at timestamptz,
  -- Dernière ouverture (au plus une écriture toutes les 10 minutes) : sans lecteur depuis 14 jours, le rafraîchissement automatique se met en veille.
  ADD COLUMN viewed_at timestamptz;

CREATE INDEX shared_pages_data_due_idx ON shared_pages (data_refreshed_at) WHERE kind = 'data' AND refresh_minutes IS NOT NULL;

CREATE TABLE shared_page_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      uuid NOT NULL REFERENCES shared_pages (id) ON DELETE CASCADE,
  -- Identifiant de la source dans la page (Skipper.data.<name>).
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sql', 'script')),
  -- sql : { item, database?, query } ; script : { interpreter, code, timeoutSeconds }.
  config       jsonb NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  -- Dernier résultat réussi (gardé quand une actualisation échoue) : sql { columns, rows }, script : le JSON produit.
  data         jsonb,
  row_count    integer,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error', 'skipped')),
  error        text,
  duration_ms  integer,
  refreshed_at timestamptz,   -- dernier succès
  attempted_at timestamptz,   -- dernière tentative
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, name)
);
