-- ---- Livraisons d'un projet : fusion sur la branche principale et mise en production -----------------------------------
-- Une livraison « merge » (bouton « Livrer » d'une session ou d'une tâche) fusionne la base dans la branche du dossier de
-- travail, pousse, ouvre ou reprend la pull request, attend que ses checks soient verts, puis la fusionne. Une livraison
-- « deploy » lance la commande de déploiement du projet (deploy_configs) sur un serveur SSH du coffre, seulement quand la
-- CI de la branche principale est verte, jamais deux à la fois (verrou par projet : une en cours au plus) ; les demandes
-- faites pendant un déploiement se regroupent en une seule en attente (un seul redémarrage par lot de livraisons).
CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('merge', 'deploy')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'conflict', 'cancelled')),
  requested_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Personnes qui ont rejoint un déploiement en attente (lot), en plus de celle qui l'a demandé.
  joined_by_ids uuid[] NOT NULL DEFAULT '{}',
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  worksession_id uuid REFERENCES worksessions(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  branch text,
  pr_number integer,
  pr_url text,
  -- Commit livré : tête de la branche fusionnée (merge), commit de la base déployé (deploy).
  sha text,
  -- Étapes horodatées [{ at, message, level }] (journal lisible de la livraison).
  steps jsonb NOT NULL DEFAULT '[]',
  -- Fin de la sortie de la commande de déploiement.
  output text,
  error text,
  -- Instance du backend qui mène la livraison (reprise si elle disparaît).
  instance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX deliveries_project_idx ON deliveries (project_id, created_at DESC);
CREATE INDEX deliveries_worksession_idx ON deliveries (worksession_id, created_at DESC);
CREATE INDEX deliveries_task_idx ON deliveries (task_id, created_at DESC);
-- Verrou : un déploiement en cours au plus par projet, et une seule demande en attente (le lot suivant).
CREATE UNIQUE INDEX deliveries_deploy_running_idx ON deliveries (project_id) WHERE kind = 'deploy' AND status = 'running';
CREATE UNIQUE INDEX deliveries_deploy_queued_idx ON deliveries (project_id) WHERE kind = 'deploy' AND status = 'queued';
-- Une livraison active au plus par dossier de travail.
CREATE UNIQUE INDEX deliveries_merge_active_idx ON deliveries (worksession_id) WHERE kind = 'merge' AND status IN ('queued', 'running');

-- Commande de déploiement d'un projet, lancée par le backend sur un serveur SSH du coffre (nom de l'élément).
CREATE TABLE deploy_configs (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  vault_item text NOT NULL,
  command text NOT NULL,
  -- Branche dont la CI doit être verte et dont le dernier commit est déployé (vide : branche principale du projet).
  branch text,
  timeout_minutes integer NOT NULL DEFAULT 30 CHECK (timeout_minutes BETWEEN 1 AND 120),
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
