-- Canaux de notification hors navigateur (en plus de la cloche et du Web Push) : webhook Slack ou Discord, e-mail.
-- Un canal appartient soit à un projet (les notifications adressées à tous ses membres y sont relayées), soit à une
-- personne (tout ce qu'elle verrait dans sa cloche). `target` est chiffré (adresse du webhook ou e-mail) ;
-- `categories` : familles relayées (clés de PUSH_CATEGORIES, notifications/preferences.ts).
CREATE TABLE notification_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid REFERENCES projects (id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('slack', 'discord', 'email')),
  target        text NOT NULL,
  -- Version lisible et sans secret de la cible (hôte du webhook, adresse e-mail), pour l'affichage.
  target_hint   text NOT NULL,
  categories    text[] NOT NULL DEFAULT '{}',
  enabled       boolean NOT NULL DEFAULT true,
  last_sent_at  timestamptz,
  last_error    text,
  created_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((project_id IS NULL) <> (user_id IS NULL))
);
CREATE INDEX notification_channels_project_idx ON notification_channels (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX notification_channels_user_idx ON notification_channels (user_id) WHERE user_id IS NOT NULL;
