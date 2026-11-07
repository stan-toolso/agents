-- Commentaires sur les pages partagées : généraux ou ancrés sur un élément de la page (anchor : sélecteur CSS,
-- extrait du texte, balise), chacun une micro-conversation (les réponses ont un parent_id) avec un état « traité »
-- (resolved_at sur le commentaire racine). Toute personne qui voit la page peut commenter.
-- Compatible bleu/vert : nouvelle table seulement, ignorée par l'ancienne version.
CREATE TABLE IF NOT EXISTS shared_page_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES shared_pages (id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES shared_page_comments (id) ON DELETE CASCADE,   -- réponse dans la micro-conversation
  author_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions (id) ON DELETE SET NULL,              -- posté par une session d'agent (outil pages.reply)
  body        text NOT NULL,
  anchor      jsonb,                                                          -- null : commentaire général
  version     integer NOT NULL,                                               -- version de la page au moment du commentaire
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shared_page_comments_page_idx ON shared_page_comments (page_id, created_at);
CREATE INDEX IF NOT EXISTS shared_page_comments_parent_idx ON shared_page_comments (parent_id) WHERE parent_id IS NOT NULL;
