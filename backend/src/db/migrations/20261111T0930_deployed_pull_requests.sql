-- ---- Déploiements : quelles pull requests sont parties en production --------------------------------------------------
-- Un déploiement réussi (lancé par Skipper, ou déclaré par une session qui a déployé autrement : outil tasks.deploy_record)
-- emporte les pull requests fusionnées dont le commit de fusion est contenu dans le commit déployé. Le lien est gardé ici :
-- une PR n'est annoncée qu'une fois (au premier déploiement qui la contient), et l'événement « déploiement » prévient les
-- agents qui le suivent (déclencheur `deployed`), qui mettent à jour les tâches selon les conventions du projet.
CREATE TABLE delivery_pull_requests (
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  PRIMARY KEY (delivery_id, pull_request_id)
);
CREATE INDEX delivery_pull_requests_pr_idx ON delivery_pull_requests (pull_request_id);
