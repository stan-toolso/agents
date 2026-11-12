-- ---- Cockpit configurable : agencements des tableaux de bord --------------------------------------------------------
-- Un agencement par portée (« home » d'une personne, tableau de bord d'un projet…) : la liste des blocs (natifs ou
-- artefacts) par région, validée par le serveur (cockpit/layout.ts). `layout` NULL = agencement par défaut (code),
-- après une réinitialisation ; la ligne garde alors son compteur de versions. Chaque enregistrement fige la nouvelle
-- version dans cockpit_layout_versions (petits documents) pour l'historique et la restauration.
CREATE TABLE cockpit_layouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'home' (avec user_id), 'project:<id>', 'project:<id>:tasks', 'agent:<id>', 'project:<id>:page:<slug>'
  scope       text NOT NULL,
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects (id) ON DELETE CASCADE,
  layout      jsonb,
  version     int  NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Une portée partagée n'a qu'un agencement ; la portée « home » en a un par personne.
CREATE UNIQUE INDEX cockpit_layouts_shared_idx ON cockpit_layouts (scope) WHERE user_id IS NULL;
CREATE UNIQUE INDEX cockpit_layouts_user_idx ON cockpit_layouts (scope, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX cockpit_layouts_project_idx ON cockpit_layouts (project_id);

CREATE TABLE cockpit_layout_versions (
  layout_id   uuid NOT NULL REFERENCES cockpit_layouts (id) ON DELETE CASCADE,
  version     int  NOT NULL,
  layout      jsonb NOT NULL,
  -- Réinitialisation : la version enregistre l'agencement par défaut du moment.
  reset       boolean NOT NULL DEFAULT false,
  author_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id  uuid REFERENCES sessions (id) ON DELETE SET NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (layout_id, version)
);
