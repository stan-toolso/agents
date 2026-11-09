import { useMutation, useQuery } from '@apollo/client';
import PageLoading from '../components/PageLoading';
import ProjectArchiveCard from '../components/ProjectArchiveCard';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Collapse, Form, Row, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { bypassConnectionsWarning, permissionModeLabels } from '../lib/humanize';
import ContextLimitField from '../components/ContextLimitField';
import { PRIORITY_MODEL_KEYS, cleanTaskModels, modelOptions } from '../lib/models';
import { NO_CONTEXT_LIMIT, cleanupFromLimit, limitFromCleanup, validLimit, type ContextLimit } from '../lib/contextLimit';
import { CREATE_PROJECT, evictProjectLists, GITHUB_REPOSITORIES, GITHUB_STATUS, GITLAB_REPOSITORIES, GITLAB_STATUS, PROJECT, PROVIDERS, UPDATE_PROJECT, type GithubAuthStatus, type GithubRepository, type GitlabAuthStatus, type GitlabRepository, type Project, type Provider, type TaskModels } from '../graphql/operations';

/** Modes proposés comme réglage de projet (même liste que le backend, projects/types.ts). */
const projectPermissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

/** Liste des dépôts GitHub de l'utilisateur connecté, pour remplir l'URL et la branche. */
function GithubRepoPicker({ onPick }: { onPick: (repo: GithubRepository) => void }) {
  const { data: statusData } = useQuery<{ settings: { github: GithubAuthStatus } }>(GITHUB_STATUS);
  const connected = statusData?.settings.github.connected ?? false;
  const [query, setQuery] = useState('');
  const { data, loading } = useQuery<{ githubRepositories: GithubRepository[] }>(GITHUB_REPOSITORIES, { variables: { query }, skip: !connected });
  if (!statusData) return null;
  if (!connected) {
    return (
      <Form.Text>
        Dépôt privé ? Connectez votre compte <Link to="/settings?section=github">GitHub</Link> ou <Link to="/settings?section=gitlab">GitLab</Link> pour le choisir dans une liste et l'utiliser sans clé de déploiement.
      </Form.Text>
    );
  }
  const repos = data?.githubRepositories ?? [];
  // Plusieurs comptes connectés : on dit lequel voit chaque dépôt.
  const several = (statusData?.settings.github.accounts.length ?? 0) > 1;
  return (
    <div className="border rounded p-2 mb-2">
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-github" />
        <Form.Control size="sm" placeholder="Rechercher un de vos dépôts GitHub…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {loading && <Spinner size="sm" />}
      </div>
      <div className="small" style={{ maxHeight: 160, overflow: 'auto' }}>
        {repos.slice(0, 30).map((r) => (
          <button key={r.fullName} type="button" className="btn btn-link btn-sm p-0 d-block text-start text-decoration-none" onClick={() => onPick(r)}>
            {r.fullName}
            {r.private && <span className="text-secondary"> · privé</span>}
            <span className="text-secondary"> · {r.defaultBranch}</span>
            {several && <span className="text-secondary"> · compte {r.account}</span>}
          </button>
        ))}
        {data && repos.length === 0 && <div className="text-secondary">Aucun dépôt ne correspond.</div>}
      </div>
    </div>
  );
}
/** Liste des dépôts GitLab de l'utilisateur connecté (toutes ses instances), pour remplir l'URL et la branche ; rien sans compte GitLab. */
function GitlabRepoPicker({ onPick }: { onPick: (repo: GitlabRepository) => void }) {
  const { data: statusData } = useQuery<{ settings: { gitlab: GitlabAuthStatus } }>(GITLAB_STATUS);
  const connected = statusData?.settings.gitlab.connected ?? false;
  const [query, setQuery] = useState('');
  const { data, loading } = useQuery<{ gitlabRepositories: GitlabRepository[] }>(GITLAB_REPOSITORIES, { variables: { query }, skip: !connected });
  if (!connected) return null;
  const repos = data?.gitlabRepositories ?? [];
  const accounts = statusData?.settings.gitlab.accounts ?? [];
  // Plusieurs comptes ou une instance auto-hébergée : on dit d'où vient chaque dépôt.
  const several = accounts.length > 1 || accounts.some((a) => a.host !== 'gitlab.com');
  return (
    <div className="border rounded p-2 mb-2">
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-gitlab" />
        <Form.Control size="sm" placeholder="Rechercher un de vos dépôts GitLab…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {loading && <Spinner size="sm" />}
      </div>
      <div className="small" style={{ maxHeight: 160, overflow: 'auto' }}>
        {repos.slice(0, 30).map((r) => (
          <button key={`${r.host}/${r.fullName}`} type="button" className="btn btn-link btn-sm p-0 d-block text-start text-decoration-none" onClick={() => onPick(r)}>
            {r.fullName}
            {r.private && <span className="text-secondary"> · privé</span>}
            {r.defaultBranch && <span className="text-secondary"> · {r.defaultBranch}</span>}
            {several && <span className="text-secondary"> · {r.account}@{r.host}</span>}
          </button>
        ))}
        {data && repos.length === 0 && <div className="text-secondary">Aucun dépôt ne correspond.</div>}
      </div>
    </div>
  );
}
import { useTabTitle } from '../workbench/TabsContext';
import { HOSTED_GIT_AVAILABLE } from '../graphql/repo';


/** Création (sans id) ou édition (avec id) d'un projet. */
export default function ProjectFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const { data, loading, error } = useQuery<{ project: Project | null }>(PROJECT, { variables: { id }, skip: !isEdit });
  useTabTitle(isEdit ? (data?.project ? `Modifier · ${data.project.name}` : null) : 'Nouveau projet');
  const [createProject, { loading: creating, error: createError }] = useMutation<{ createProject: Project }>(CREATE_PROJECT, {
    // La liste des projets est en cache sous plusieurs jeux de variables (includePersonal pour la modale de
    // lancement, all pour les super-admins…) : on les oublie toutes, sinon le nouveau projet manque ailleurs.
    update: (cache) => evictProjectLists(cache),
    refetchQueries: ['Projects'],
    onCompleted: (res) => navigate(`/projects/${res.createProject.id}`),
  });
  const [updateProject, { loading: updating, error: updateError }] = useMutation<{ updateProject: Project }>(UPDATE_PROJECT, {
    onCompleted: (res) => navigate(`/projects/${res.updateProject.id}`),
  });

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [taskInstructions, setTaskInstructions] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  /** Aucun dépôt, dépôt hébergé par Skipper, ou dépôt distant (URL). */
  const [repoMode, setRepoMode] = useState<'none' | 'hosted' | 'remote'>('none');
  const hostedQ = useQuery<{ hostedGitAvailable: boolean }>(HOSTED_GIT_AVAILABLE);
  const hostedAvailable = Boolean(hostedQ.data?.hostedGitAvailable);
  const [runnerImage, setRunnerImage] = useState('');
  const [runnerMemory, setRunnerMemory] = useState('');
  const [runnerCpus, setRunnerCpus] = useState('');
  const [runnerBrowser, setRunnerBrowser] = useState(false);
  const [maxSessions, setMaxSessions] = useState('');
  const [permissionMode, setPermissionMode] = useState('default');
  const [contextLimit, setContextLimit] = useState<ContextLimit>(NO_CONTEXT_LIMIT);
  const [defaultModel, setDefaultModel] = useState('');
  const [taskModels, setTaskModels] = useState<TaskModels>({});
  // Modèles proposables : ceux de vos réglages Claude (bornés par vos modèles autorisés).
  const { data: providersData } = useQuery<{ providers: Provider[] }>(PROVIDERS);
  const models = modelOptions(providersData?.providers.find((p) => p.type === 'claude')?.configFields);
  const modelChoices = (current: string) => [...models, ...(current && !models.some((m) => m.value === current) ? [{ value: current, label: `${current} (hors de vos modèles autorisés)` }] : [])];
  const [showAdvanced, setShowAdvanced] = useState(isEdit);

  useEffect(() => {
    const p = data?.project;
    if (!p) return;
    setName(p.name);
    setSlug(p.slug);
    setDescription(p.description ?? '');
    setSystemPrompt(p.systemPrompt);
    setTaskInstructions(p.taskInstructions ?? '');
    setGitUrl(p.gitUrl ?? '');
    setGitBranch(p.gitBranch ?? '');
    setRepoMode(p.gitHosted ? 'hosted' : p.gitUrl ? 'remote' : 'none');
    setRunnerImage(p.runnerConfig?.image ?? '');
    setRunnerMemory(p.runnerConfig?.memory ?? '');
    setRunnerCpus(p.runnerConfig?.cpus ?? '');
    setRunnerBrowser(Boolean(p.runnerConfig?.browser));
    setMaxSessions(p.runnerConfig?.maxSessions ? String(p.runnerConfig.maxSessions) : '');
    setPermissionMode(p.defaultPermissionMode ?? 'default');
    setContextLimit(limitFromCleanup(p.defaultContextCleanup));
    setDefaultModel(p.defaultModel ?? '');
    setTaskModels(p.taskModels ?? {});
  }, [data]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validLimit(contextLimit)) return;
    const runnerConfig: Record<string, unknown> = Object.fromEntries(Object.entries({ image: runnerImage.trim(), memory: runnerMemory.trim(), cpus: runnerCpus.trim() }).filter(([, v]) => v));
    if (runnerBrowser) runnerConfig.browser = true;
    const max = Math.round(Number(maxSessions));
    if (max > 0) runnerConfig.maxSessions = max;
    const common = {
      name,
      description: description || null,
      systemPrompt,
      taskInstructions,
      gitUrl: repoMode === 'remote' && gitUrl.trim() ? gitUrl.trim() : null,
      gitHosted: repoMode === 'hosted',
      gitBranch: gitBranch || null,
      runnerConfig,
      defaultPermissionMode: permissionMode,
      defaultContextCleanup: cleanupFromLimit(contextLimit),
      defaultModel: defaultModel || null,
      taskModels: cleanTaskModels(taskModels),
    };
    if (isEdit) updateProject({ variables: { id, input: common } });
    else createProject({ variables: { input: { ...common, slug: slug || null } } });
  };

  if (loading) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (isEdit && !data?.project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const mutationError = createError ?? updateError;

  return (
    <>
      <Link to={isEdit ? `/projects/${id}` : '/projects'} className="small">
        ← Retour
      </Link>
      <h1 className="h3 mb-3">{isEdit ? `Modifier « ${data?.project?.name} »` : 'Nouveau projet'}</h1>
      <Card>
        <Card.Body>
          <Form onSubmit={submit}>
            <Form.Group className="mb-3">
              <Form.Label>Nom</Form.Label>
              <Form.Control value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ex. Site marketing" />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} placeholder="En une phrase, de quoi il s'agit (facultatif)" />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Instructions permanentes pour les agents</Form.Label>
              <Form.Control
                as="textarea"
                rows={8}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Ce que tout agent doit savoir sur ce projet : de quoi il s'agit, les conventions à respecter, ce qu'il ne faut pas faire…"
              />
              <Form.Text>Transmis à chaque session lancée dans ce projet, en plus de la tâche demandée.</Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Consignes des sessions de tâches</Form.Label>
              <Form.Control
                as="textarea"
                rows={4}
                value={taskInstructions}
                onChange={(e) => setTaskInstructions(e.target.value)}
                placeholder="Ex. : travaille sur une branche, ouvre une pull request à la fin, mets la tâche « en revue » et commente avec le lien de la PR."
              />
              <Form.Text>Ajoutées après le texte de la tâche dans l'instruction de toute session qui réalise une tâche du projet (« Confier à un agent », agents, workflows).</Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Check
                type="switch"
                id="runnerBrowser"
                label="Navigateur headless pour les agents (Playwright)"
                checked={runnerBrowser}
                onChange={(e) => setRunnerBrowser(e.target.checked)}
              />
              <Form.Text>
                Les agents peuvent ouvrir des pages, cliquer et remplir des formulaires dans un Chromium sans fenêtre, pour tester une interface web. Compte 300 à 500 Mo de mémoire en plus par session :
                prévoyez une limite mémoire de 1,5 Go pour le conteneur.
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Autorisations des agents par défaut</Form.Label>
              <Form.Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                {projectPermissionModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {permissionModeLabels[mode]}
                  </option>
                ))}
              </Form.Select>
              <Form.Text>
                Appliqué aux sessions lancées depuis une tâche et proposé par défaut dans le formulaire de nouvelle session (qui retient ensuite votre dernier choix). Modifiable à tout moment depuis la page d'une session.
              </Form.Text>
              {permissionMode === 'bypassPermissions' && bypassConnectionsWarning(data?.project?.approvalConnections ?? []) && (
                <Alert variant="warning" className="py-2 small mt-2 mb-0">
                  <i className="bi bi-exclamation-triangle me-1" />
                  {bypassConnectionsWarning(data?.project?.approvalConnections ?? [])}
                </Alert>
              )}
            </Form.Group>

            <ContextLimitField
              id="projectContextLimit"
              label="Contexte des nouvelles sessions"
              value={contextLimit}
              onChange={setContextLimit}
              hint="Présélectionné dans le formulaire de nouvelle session (qui retient ensuite votre dernier choix) et appliqué aux sessions lancées depuis une tâche ou par un agent. Les sessions existantes ne changent pas. Recommandé : compacter au-delà de 100 k tokens."
            />

            <Form.Group className="mb-3" controlId="projectDefaultModel">
              <Form.Label>Modèle des nouvelles sessions</Form.Label>
              <Form.Select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
                <option value="">Modèle par défaut de chacun (Paramètres → Claude)</option>
                {modelChoices(defaultModel).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Form.Select>
              <Form.Text>
                Appliqué aux nouvelles sessions qui ne choisissent pas de modèle : planifications, tâches, sessions lancées par un agent sans modèle propre. Ignoré pour une personne dont les réglages Claude n'autorisent pas ce modèle. Les sessions existantes ne changent pas.
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="mb-1">Modèle des tâches selon leur priorité</Form.Label>
              <Row className="g-2">
                {PRIORITY_MODEL_KEYS.map(({ key, label }) => (
                  <Col xs={6} md={3} key={key}>
                    <Form.Label htmlFor={`taskModel-${key}`} className="small text-secondary mb-0">
                      {label}
                    </Form.Label>
                    <Form.Select id={`taskModel-${key}`} size="sm" value={taskModels[key] ?? ''} onChange={(e) => setTaskModels((prev) => ({ ...prev, [key]: e.target.value }))}>
                      <option value="">Modèle du projet</option>
                      {modelChoices(taskModels[key] ?? '').map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                ))}
              </Row>
              <Form.Text>Prérempli dans « Confier à un agent » (modifiable) et appliqué aux tâches lancées automatiquement ; un agent qui a son propre modèle le garde.</Form.Text>
            </Form.Group>

            <div className="mb-3">
              <Button variant="link" size="sm" className="p-0 text-secondary" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
                <i className={`bi bi-chevron-${showAdvanced ? 'down' : 'right'} me-1`} />
                Options avancées
              </Button>
              <Collapse in={showAdvanced}>
                <div className="pt-2 ps-3 border-start">
                  <Form.Group className="mb-3">
                    <Form.Label>Identifiant (nom du dossier de travail)</Form.Label>
                    <Form.Control value={slug} onChange={(e) => setSlug(e.target.value)} disabled={isEdit} placeholder="généré à partir du nom si vide" pattern="[a-z0-9][a-z0-9-]*" />
                    <Form.Text>Minuscules, chiffres et tirets. {isEdit ? 'Non modifiable après création.' : 'Le dossier de travail portera ce nom.'}</Form.Text>
                  </Form.Group>
                  <Row className="g-2 mb-3">
                    <Col sm={6}>
                      <Form.Label className="small mb-1">Image Docker</Form.Label>
                      <Form.Control size="sm" value={runnerImage} onChange={(e) => setRunnerImage(e.target.value)} placeholder="skipper-runner:latest" />
                    </Col>
                    <Col sm={3}>
                      <Form.Label className="small mb-1">Mémoire</Form.Label>
                      <Form.Control size="sm" value={runnerMemory} onChange={(e) => setRunnerMemory(e.target.value)} placeholder="1g" />
                    </Col>
                    <Col sm={3}>
                      <Form.Label className="small mb-1">CPU</Form.Label>
                      <Form.Control size="sm" value={runnerCpus} onChange={(e) => setRunnerCpus(e.target.value)} placeholder="sans plafond" />
                    </Col>
                    <Form.Text>Vides : valeurs par défaut du serveur. Un changement d'image ou de limites s'applique après « Recréer » sur la page du projet.</Form.Text>
                  </Row>
                  <Form.Group className="mb-3">
                    <Form.Label className="small mb-1">Sessions simultanées au maximum dans ce projet</Form.Label>
                    <Form.Control size="sm" type="number" min={0} max={100} value={maxSessions} onChange={(e) => setMaxSessions(e.target.value)} placeholder="limite du serveur" style={{ maxWidth: 200 }} />
                    <Form.Text>Au-delà, les sessions du projet attendent en file qu'une place se libère. Vide : seule la limite du serveur (Paramètres → Serveur) s'applique.</Form.Text>
                  </Form.Group>
                </div>
              </Collapse>
            </div>

            <fieldset className="mb-3">
              <legend className="h6">Dépôt git</legend>
              {(() => {
                const wasHosted = Boolean(data?.project?.gitHosted);
                const hadRemote = Boolean(data?.project?.gitUrl) && !wasHosted;
                return (
                  <div className="mb-2">
                    <Form.Check type="radio" id="repo-none" name="repoMode" label="Aucun dépôt : un simple dossier de travail" checked={repoMode === 'none'} disabled={wasHosted} onChange={() => setRepoMode('none')} />
                    <Form.Check
                      type="radio"
                      id="repo-hosted"
                      name="repoMode"
                      label="Hébergé par Skipper : un dépôt dans la forge Forgejo du serveur (pull requests, revues), sauvegardé dans sa base"
                      checked={repoMode === 'hosted'}
                      disabled={hadRemote || (!wasHosted && !hostedAvailable)}
                      onChange={() => setRepoMode('hosted')}
                      title={hadRemote ? 'Un projet relié à un dépôt distant ne peut pas passer en dépôt hébergé' : !hostedAvailable && !wasHosted ? "L'hébergement de dépôts (Forgejo) n'est pas configuré sur ce serveur" : undefined}
                    />
                    <Form.Check type="radio" id="repo-remote" name="repoMode" label="Dépôt distant (GitHub, GitLab ou autre), par son adresse" checked={repoMode === 'remote'} disabled={wasHosted} onChange={() => setRepoMode('remote')} />
                    {wasHosted && <Form.Text>Le dépôt de ce projet est hébergé par Skipper ; l'hébergement ne se désactive pas.</Form.Text>}
                  </div>
                );
              })()}
              {repoMode === 'remote' && !isEdit && (
                <GithubRepoPicker
                  onPick={(r) => {
                    setGitUrl(r.cloneUrl);
                    setGitBranch(r.defaultBranch);
                    if (!name) setName(r.name);
                  }}
                />
              )}
              {repoMode === 'remote' && !isEdit && (
                <GitlabRepoPicker
                  onPick={(r) => {
                    setGitUrl(r.cloneUrl);
                    setGitBranch(r.defaultBranch ?? '');
                    if (!name) setName(r.name);
                  }}
                />
              )}
              {repoMode === 'remote' && (
                <Form.Group className="mb-2">
                  <Form.Label className="small mb-1">URL</Form.Label>
                  <Form.Control value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/org/repo.git, https://gitlab.com/groupe/repo.git ou git@…" />
                </Form.Group>
              )}
              {repoMode !== 'none' && (
                <Form.Group className="mb-2">
                  <Form.Label className="small mb-1">{repoMode === 'hosted' ? 'Branche principale' : 'Branche'}</Form.Label>
                  <Form.Control value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder={repoMode === 'hosted' ? 'main si vide' : 'défaut du dépôt si vide'} />
                </Form.Group>
              )}
              <Form.Text>
                {repoMode === 'hosted'
                  ? isEdit && !data?.project?.gitHosted
                    ? "À l'enregistrement, le dossier du projet (et ceux de ses sessions) sont importés dans le dépôt hébergé : leur contenu devient le premier commit de chaque branche. Ajoutez d'abord un .gitignore si certains fichiers (node_modules…) ne doivent pas y entrer."
                    : 'Le dépôt est créé dans Forgejo avec un premier commit ; les sessions y poussent leurs branches et y ouvrent leurs pull requests. Vous y êtes connecté avec votre compte Skipper (page Dépôt du projet).'
                  : repoMode === 'remote'
                    ? isEdit
                      ? "Modifier l'adresse n'affecte pas un dossier de travail déjà créé."
                      : 'Le code du dépôt est récupéré dans le dossier de travail à la création du projet.'
                    : 'Sans dépôt, les sessions travaillent dans de simples dossiers, sans branche ni historique. Vous pourrez héberger un dépôt plus tard.'}
              </Form.Text>
            </fieldset>

            {mutationError && <Alert variant="danger">{mutationError.message}</Alert>}

            <Button type="submit" disabled={creating || updating || !validLimit(contextLimit)}>
              {creating || updating ? 'Enregistrement…' : isEdit ? 'Enregistrer' : 'Créer le projet'}
            </Button>
          </Form>
        </Card.Body>
      </Card>
      {isEdit && id && data?.project?.myRole === 'ADMIN' && <ProjectArchiveCard projectId={id} />}
    </>
  );
}
