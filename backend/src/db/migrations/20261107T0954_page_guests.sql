-- Invités des pages partagées : une personne invitée depuis le partage d'une page, sans projet ni autre droit. Elle se
-- connecte avec Google et ne voit que les pages partagées avec elle (garde GraphQL graphql/security.ts). Inviter cette
-- personne sur un projet ou dans l'application en fait une personne ordinaire (guest = false).
-- Compatible bleu/vert : colonne ajoutée avec une valeur par défaut, ignorée par l'ancienne version.
ALTER TABLE users ADD COLUMN IF NOT EXISTS guest boolean NOT NULL DEFAULT false;
