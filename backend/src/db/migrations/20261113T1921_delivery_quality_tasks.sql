-- ---- Tâches « qualité » rattachées aux livraisons (mesure des régressions) ---------------------------------------------
-- Une tâche portant une étiquette qualité (bug, regression, qualite… : réglable par projet) créée dans la fenêtre qui
-- suit une livraison réussie (48 h par défaut) est rattachée à la plus récente livraison terminée avant sa création :
-- un déploiement, ou une fusion « Livrer » pour un projet qui n'a jamais déployé par Skipper. Le rattachement est
-- calculé (source « auto ») à la création de la tâche, au changement de ses étiquettes et par rattrapage ; une personne
-- peut le corriger (source « manual » : autre livraison, ou aucune avec delivery_id NULL), et le calcul n'y touche plus.
CREATE TABLE delivery_tasks (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  delivery_id uuid REFERENCES deliveries(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('auto', 'manual')),
  linked_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (delivery_id IS NOT NULL OR source = 'manual')
);
CREATE INDEX delivery_tasks_delivery_idx ON delivery_tasks (delivery_id);

-- Réglages qualité d'un projet (absent : étiquettes et fenêtre par défaut).
CREATE TABLE delivery_quality_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tags text[] NOT NULL,
  window_hours integer NOT NULL DEFAULT 48 CHECK (window_hours BETWEEN 1 AND 720),
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
