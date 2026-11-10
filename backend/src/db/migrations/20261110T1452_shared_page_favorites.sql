-- Artefacts en favori : chaque personne épingle les artefacts qu'elle veut garder sous la main ; leur lien reste dans
-- la sidebar (section « Favoris »). Un favori ne donne aucun droit : la liste ne montre que les artefacts que la
-- personne peut encore voir. Migration additive (bleu/vert) : l'ancienne instance ignore la table.
CREATE TABLE shared_page_favorites (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  page_id    uuid NOT NULL REFERENCES shared_pages (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);

CREATE INDEX shared_page_favorites_page_idx ON shared_page_favorites (page_id);

-- Artefacts d'un projet (onglet Artefacts du projet).
CREATE INDEX IF NOT EXISTS shared_pages_project_idx ON shared_pages (project_id, updated_at DESC) WHERE project_id IS NOT NULL;
