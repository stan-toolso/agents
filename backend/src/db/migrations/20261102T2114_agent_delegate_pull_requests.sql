-- ---- Agents de projet : pull requests permises sur un compte git prêté en lecture seule --------------------------
-- Prêté en lecture seule, un compte GitHub ou GitLab ne pousse rien depuis les sessions de l'agent. Avec cette option,
-- l'agent peut quand même ouvrir une pull request (merge request) par `tasks.pr_open` : Skipper pousse sa branche de
-- travail (jamais la branche de base) et ouvre la PR ; un `git push` lancé par l'agent reste refusé.
ALTER TABLE agent_profiles ADD COLUMN github_delegate_pull_requests boolean NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN gitlab_delegate_pull_requests boolean NOT NULL DEFAULT false;
