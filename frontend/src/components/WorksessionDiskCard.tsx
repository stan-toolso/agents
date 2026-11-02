import { gql, useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { usePollingQuery } from '../lib/usePollingQuery';
import { Alert, Badge, Button, Card, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useDialogs } from './Dialogs';
import { TaskStatusBadge } from './TaskBadges';
import { timeAgo } from '../lib/humanize';
import type { TaskStatus } from '../graphql/operations';

export const PROJECT_WORKSESSION_DISK = gql`
  query ProjectWorksessionDisk($id: ID!, $refresh: Boolean) {
    project(id: $id) {
      id
      worksessionDisk(refresh: $refresh) {
        computedAt
        measuring
        sharedBytes
        totalBytes
        prunable
        entries {
          name
          branch
          exists
          gitWorktree
          bytes
          aheadCount
          changes
          prMerged
          merged
          activeSessions
          busySessions
          lastActivityAt
          deps
          cleanable
          blocker
          worksession {
            id
            label
            archivedAt
            task {
              id
              title
              status
              statusTag
            }
          }
        }
      }
    }
  }
`;
const CLEAN_MERGED = gql`
  mutation CleanMergedWorksessions($projectId: ID!, $names: [String!]) {
    cleanMergedWorksessions(projectId: $projectId, names: $names) {
      removed
      freedBytes
      skipped {
        name
        reason
      }
    }
  }
`;
const SHARE_DEPS = gql`
  mutation ShareWorksessionDeps($projectId: ID!, $names: [String!]) {
    shareWorksessionDeps(projectId: $projectId, names: $names) {
      relinked
      skipped {
        name
        reason
      }
    }
  }
`;
const IMPORT_ORPHAN = gql`
  mutation ImportOrphanWorksession($projectId: ID!, $name: String!) {
    importOrphanWorksession(projectId: $projectId, name: $name) {
      id
    }
  }
`;
const DELETE_ORPHAN = gql`
  mutation DeleteOrphanWorksession($projectId: ID!, $name: String!) {
    deleteOrphanWorksession(projectId: $projectId, name: $name)
  }
`;

interface DiskEntry {
  name: string;
  branch: string | null;
  exists: boolean;
  gitWorktree: boolean;
  bytes: number | null;
  aheadCount: number | null;
  changes: number | null;
  prMerged: boolean;
  merged: boolean;
  activeSessions: number;
  busySessions: number;
  lastActivityAt: string | null;
  deps: 'LINKED' | 'COPY' | 'NO_SNAPSHOT' | null;
  cleanable: boolean;
  blocker: string | null;
  worksession: { id: string; label: string; archivedAt: string | null; task: { id: string; title: string; status: TaskStatus; statusTag: string | null } | null } | null;
}
interface DiskReport {
  computedAt: string | null;
  measuring: boolean;
  sharedBytes: number | null;
  totalBytes: number | null;
  prunable: string[];
  entries: DiskEntry[];
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Ko`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} Mo`;
  return `${(n / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
}

function MergeState({ e }: { e: DiskEntry }) {
  if (!e.gitWorktree) return <span className="text-secondary">—</span>;
  if (e.prMerged) return <Badge bg="success">PR fusionnée</Badge>;
  if (e.aheadCount === 0) return <span className="text-secondary">rien à fusionner</span>;
  if (e.aheadCount === null) return <span className="text-secondary">inconnu</span>;
  return (
    <span>
      {e.aheadCount} commit{e.aheadCount > 1 ? 's' : ''} non fusionné{e.aheadCount > 1 ? 's' : ''}
    </span>
  );
}

/**
 * Dossiers de travail du projet sur disque (page projet) : place occupée par chacun (les dépendances partagées par liens
 * physiques comptées une fois), fusion de la branche, tâche liée, dernière activité ; nettoyage des dossiers fusionnés,
 * import ou suppression des dossiers inconnus de Skipper.
 */
export default function WorksessionDiskCard({ projectId, canWrite, isAdmin }: { projectId: string; canWrite: boolean; isAdmin: boolean }) {
  const [refresh, setRefresh] = useState(false);
  // Une mesure des tailles tourne en arrière-plan (une vingtaine de secondes sur un gros projet) : on réinterroge jusqu'à sa fin.
  const [poll, setPoll] = useState(0);
  const { data, loading, error, refetch } = usePollingQuery<{ project: { id: string; worksessionDisk: DiskReport } | null }>(PROJECT_WORKSESSION_DISK, {
    variables: { id: projectId, refresh: false },
    pollInterval: poll,
  });
  const { confirm, alert, showError } = useDialogs();
  const [clean, { loading: cleaning }] = useMutation<{ cleanMergedWorksessions: { removed: string[]; freedBytes: number; skipped: { name: string; reason: string }[] } }>(CLEAN_MERGED);
  const [shareDeps, { loading: sharing }] = useMutation<{ shareWorksessionDeps: { relinked: string[]; skipped: { name: string; reason: string }[] } }>(SHARE_DEPS);
  const [importOrphan] = useMutation(IMPORT_ORPHAN);
  const [deleteOrphan] = useMutation(DELETE_ORPHAN);
  const report = data?.project?.worksessionDisk;
  useEffect(() => setPoll(report?.measuring ? 4000 : 0), [report?.measuring]);
  const cleanable = report?.entries.filter((e) => e.cleanable) ?? [];
  const orphans = report?.entries.filter((e) => !e.worksession) ?? [];
  const copies = report?.entries.filter((e) => e.deps === 'COPY') ?? [];
  const reload = async (fresh = false) => {
    setRefresh(fresh);
    try {
      await refetch({ id: projectId, refresh: fresh });
    } finally {
      setRefresh(false);
    }
  };

  const cleanMerged = async (names?: string[]) => {
    const targets = names ? cleanable.filter((e) => names.includes(e.name)) : cleanable;
    const freed = targets.reduce((s, e) => s + (e.bytes ?? 0), 0);
    const ok = await confirm({
      title: names ? 'Supprimer le dossier fusionné' : 'Nettoyer les dossiers fusionnés',
      message: `Supprimer ${targets.length === 1 ? `le dossier « ${targets[0].name} »` : `${targets.length} dossiers`} (environ ${formatBytes(freed)}) ? Leurs branches sont fusionnées et sans modification en attente ; leurs sessions sont archivées avec leur historique, les branches locales supprimées.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await clean({ variables: { projectId, names: names ?? targets.map((e) => e.name) } });
      const r = res.data?.cleanMergedWorksessions;
      if (r?.skipped.length) await alert({ title: 'Dossiers conservés', message: <ul className="mb-0">{r.skipped.map((s) => <li key={s.name}>{s.name} : {s.reason}</li>)}</ul> });
    } catch (err) {
      await showError(err);
    }
    await reload();
  };

  const shareAll = async () => {
    const ok = await confirm({
      title: 'Partager les dépendances',
      message: `Remplacer les node_modules installés à part dans ${copies.length === 1 ? 'un dossier' : `${copies.length} dossiers`} par l'instantané de même lockfile, lié (même contenu, aucune place en plus) ? Les dossiers où une session, un terminal, un aperçu ou une installation tourne sont laissés tels quels.`,
      confirmLabel: 'Partager',
    });
    if (!ok) return;
    try {
      const res = await shareDeps({ variables: { projectId, names: copies.map((e) => e.name) } });
      const r = res.data?.shareWorksessionDeps;
      if (r?.skipped.length) await alert({ title: 'Dossiers laissés tels quels', message: <ul className="mb-0">{r.skipped.map((x) => <li key={x.name}>{x.name} : {x.reason}</li>)}</ul> });
    } catch (err) {
      await showError(err);
    }
    await reload(true);
  };

  return (
    <Card className="mt-3">
      <Card.Header className="d-flex align-items-center gap-2 flex-wrap">
        <span className="me-auto">
          Dossiers de travail
          {report && (
            <span className="text-secondary small ms-2">
              {formatBytes(report.totalBytes)} au total{report.sharedBytes ? `, dont ${formatBytes(report.sharedBytes)} de dépendances partagées` : ''}
            </span>
          )}
        </span>
        {canWrite && copies.length > 0 && (
          <Button size="sm" variant="outline-primary" disabled={sharing} onClick={() => void shareAll()} title="Dossiers dont les node_modules sont une copie complète de l'instantané de même lockfile">
            <i className="bi bi-link-45deg me-1" />
            Partager les dépendances ({copies.length})
          </Button>
        )}
        {canWrite && cleanable.length > 0 && (
          <Button size="sm" variant="outline-danger" disabled={cleaning} onClick={() => void cleanMerged()}>
            <i className="bi bi-trash me-1" />
            Nettoyer les dossiers fusionnés ({cleanable.length}, {formatBytes(cleanable.reduce((s, e) => s + (e.bytes ?? 0), 0))})
          </Button>
        )}
        <Button size="sm" variant="outline-secondary" disabled={loading || report?.measuring} onClick={() => void reload(true)} title="Mesurer à nouveau (les tailles sont gardées 10 minutes) et mettre à jour les branches d'origin">
          {(loading && refresh) || report?.measuring ? <Spinner size="sm" animation="border" /> : <i className="bi bi-arrow-clockwise" />}
        </Button>
      </Card.Header>
      <Card.Body className="small">
        <p className="text-secondary mb-2">
          Chaque session travaille dans son dossier, à côté du checkout principal. Les dépendances (<code>node_modules</code>) installées une fois sont partagées par liens physiques entre dossiers de même lockfile : elles ne comptent qu'une fois, dans « dépendances partagées ». Un dossier aux dépendances installées à part (avant ce partage) peut recevoir l'instantané à leur place. Un dossier est nettoyable quand rien n'y tourne, qu'il n'a pas de modification non commitée et que sa branche est fusionnée.
        </p>
        {error && <Alert variant="danger">{error.message}</Alert>}
        {!report && loading && (
          <div className="text-secondary">
            <Spinner size="sm" animation="border" className="me-2" />
            Mesure de la place occupée…
          </div>
        )}
        {orphans.length > 0 && (
          <Alert variant="warning" className="py-2">
            {orphans.length === 1 ? 'Un dossier est inconnu' : `${orphans.length} dossiers sont inconnus`} de Skipper (créés à la main, ou dont la session a disparu) : importez-les pour y travailler depuis Skipper, ou supprimez-les.
          </Alert>
        )}
        {report && report.entries.length === 0 && <div className="text-secondary">Aucun dossier de travail.</div>}
        {report && report.entries.length > 0 && (
          <Table size="sm" hover className="align-middle mb-0 table-stack">
            <thead>
              <tr>
                <th>Branche</th>
                <th className="text-end">Taille</th>
                <th>Fusion</th>
                <th className="d-none d-lg-table-cell">Tâche</th>
                <th className="d-none d-md-table-cell">Activité</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.entries.map((e) => (
                <tr key={e.name}>
                  <td>
                    <span className="font-monospace" title={`Dossier ${e.name}`}>{e.branch ?? e.name}</span>
                    {!e.worksession && e.branch !== e.name && <div className="text-secondary">dossier {e.name}</div>}
                    <div>
                      {!e.worksession && (
                        <Badge bg="warning" text="dark" className="me-1">
                          inconnu de Skipper
                        </Badge>
                      )}
                      {e.worksession?.archivedAt && (
                        <Badge bg="secondary" className="me-1">
                          archivé
                        </Badge>
                      )}
                      {e.busySessions > 0 && (
                        <Badge bg="primary" className="me-1">
                          session en cours
                        </Badge>
                      )}
                      {!e.exists && <Badge bg="light" text="dark">absent du disque</Badge>}
                      {!!e.changes && (
                        <span className="text-warning">
                          {e.changes} fichier{e.changes > 1 ? 's' : ''} modifié{e.changes > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="text-end text-nowrap">
                    {formatBytes(e.bytes)}
                    {e.deps === 'COPY' && <div className="text-warning" title="node_modules installés à part : « Partager les dépendances » les remplace par l'instantané lié">dépendances copiées</div>}
                    {e.deps === 'LINKED' && <div className="text-secondary">dépendances partagées</div>}
                  </td>
                  <td>
                    <MergeState e={e} />
                  </td>
                  <td className="d-none d-lg-table-cell">
                    {e.worksession?.task ? (
                      <>
                        <Link to={`/tasks/${e.worksession.task.id}`} className="d-block text-truncate" style={{ maxWidth: '20rem' }} title={e.worksession.task.title}>
                          {e.worksession.task.title}
                        </Link>
                        <TaskStatusBadge status={e.worksession.task.status} statusTag={e.worksession.task.statusTag} />
                      </>
                    ) : (
                      <span className="text-secondary">—</span>
                    )}
                  </td>
                  <td className="d-none d-md-table-cell text-secondary text-nowrap">{e.lastActivityAt ? timeAgo(e.lastActivityAt) : '—'}</td>
                  <td className="text-end text-nowrap">
                    {e.worksession ? (
                      e.cleanable ? (
                        canWrite && (
                          <Button size="sm" variant="link" className="p-0 text-danger" disabled={cleaning} onClick={() => void cleanMerged([e.name])}>
                            Supprimer
                          </Button>
                        )
                      ) : (
                        <span className="text-secondary" title="Pourquoi ce dossier n'est pas nettoyé">
                          {e.blocker}
                        </span>
                      )
                    ) : (
                      <>
                        {canWrite && e.gitWorktree && e.branch && (
                          <Button
                            size="sm"
                            variant="link"
                            className="p-0 me-2"
                            onClick={async () => {
                              await importOrphan({ variables: { projectId, name: e.name } }).catch(showError);
                              await reload();
                            }}
                          >
                            Importer
                          </Button>
                        )}
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="link"
                            className="p-0 text-danger"
                            onClick={async () => {
                              const ok = await confirm({
                                title: 'Supprimer le dossier inconnu',
                                message: `Supprimer le dossier « ${e.name} »${e.changes ? `, avec ses ${e.changes} fichier(s) modifié(s)` : ''} ? ${e.gitWorktree ? 'Sa branche est conservée.' : "Ce n'est pas un git worktree : tout son contenu est perdu."}`,
                                confirmLabel: 'Supprimer',
                                danger: true,
                              });
                              if (!ok) return;
                              await deleteOrphan({ variables: { projectId, name: e.name } }).catch(showError);
                              await reload();
                            }}
                          >
                            Supprimer
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {report && (
          <div className="text-secondary mt-2">
            {report.measuring ? 'Mesure de la place occupée en cours…' : report.computedAt ? `Mesuré ${timeAgo(report.computedAt)}.` : ''}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
