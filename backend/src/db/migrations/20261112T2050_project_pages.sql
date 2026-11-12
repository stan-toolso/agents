-- ---- Cockpit configurable : pages personnalisées et onglets d'un projet -------------------------------------------------
-- Une page personnalisée est un onglet de plus dans l'en-tête du projet (/projects/<id>/p/<slug>), dont le contenu est
-- l'agencement de la portée project:<id>:page:<slug> (cockpit_layouts). `projects.tabs` garde les onglets natifs masqués
-- et l'ordre des onglets ({ "hidden": [...], "order": [...] }). Additif (bleu/vert) : l'ancienne instance ignore les deux.
CREATE TABLE project_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug        text NOT NULL,
  title       text NOT NULL,
  icon        text,
  position    integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);
ALTER TABLE projects ADD COLUMN tabs jsonb NOT NULL DEFAULT '{}'::jsonb;
