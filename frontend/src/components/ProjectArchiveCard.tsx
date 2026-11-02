import { useMutation } from '@apollo/client';
import { useRef, useState } from 'react';
import { Alert, Button, Card, Form } from 'react-bootstrap';
import { IMPORT_PROJECT_ARCHIVE, PROJECT, type ProjectImportReport } from '../graphql/operations';
import { formatSize, readAsBase64 } from '../lib/attachments';
import { projectExportUrl } from '../lib/exports';
import { useDialogs } from './Dialogs';

/** Taille maximale d'une archive importée, alignée sur le backend (`MAX_IMPORT_BYTES`, exports/service.ts). */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Export du projet en archive tar.gz (contexte et versions, tâches et leur fil, connexions sans secrets, réglages) et
 * import d'une telle archive dans ce projet. Page de modification du projet (administrateurs).
 */
export default function ProjectArchiveCard({ projectId }: { projectId: string }) {
  const { confirm } = useDialogs();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [context, setContext] = useState(true);
  const [tasks, setTasks] = useState(true);
  const [settings, setSettings] = useState(false);
  const [report, setReport] = useState<ProjectImportReport | null>(null);
  const [importArchive, { loading, error, reset }] = useMutation<{ importProjectArchive: ProjectImportReport }>(IMPORT_PROJECT_ARCHIVE, {
    refetchQueries: [{ query: PROJECT, variables: { id: projectId } }],
  });

  const tooBig = Boolean(file && file.size > MAX_IMPORT_BYTES);
  const submit = async () => {
    if (!file || tooBig || !(context || tasks || settings)) return;
    if (
      settings &&
      !(await confirm({
        title: 'Remplacer les réglages',
        message: "Les instructions permanentes, les consignes des tâches et le mode d'autorisation de ce projet seront remplacés par ceux de l'archive ; ses règles d'autorisation s'ajoutent aux vôtres.",
        confirmLabel: 'Importer',
      }))
    )
      return;
    setReport(null);
    reset();
    const res = await importArchive({ variables: { projectId, archive: await readAsBase64(file), context, tasks, settings } }).catch(() => null);
    if (!res?.data) return;
    setReport(res.data.importProjectArchive);
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Card className="mt-3">
      <Card.Body>
        <h2 className="h6">Exporter ou importer</h2>
        <p className="small text-secondary mb-2">
          L'archive (tar.gz) contient le contexte du projet avec toutes les versions de ses instructions, les tâches et leur fil de discussion, les connexions du coffre <strong>sans leurs secrets</strong> et les réglages. Elle se lit sans Skipper (Markdown et JSON) et s'importe dans un autre projet.
        </p>
        <Button as="a" href={projectExportUrl(projectId)} download size="sm" variant="outline-secondary" className="mb-3">
          <i className="bi bi-download me-1" /> Exporter le projet
        </Button>

        <Form.Group className="mb-2">
          <Form.Label className="small mb-1">Importer une archive dans ce projet</Form.Label>
          <Form.Control
            ref={fileRef}
            type="file"
            size="sm"
            accept=".tar.gz,.tgz,application/gzip"
            onChange={(e) => {
              setFile((e.target as HTMLInputElement).files?.[0] ?? null);
              setReport(null);
            }}
          />
          {tooBig && <Form.Text className="text-danger">Archive trop volumineuse ({formatSize(file!.size)} ; {formatSize(MAX_IMPORT_BYTES)} au plus).</Form.Text>}
        </Form.Group>
        <div className="d-flex flex-wrap gap-3 mb-2 small">
          <Form.Check id="import-context" label="Contexte" checked={context} onChange={(e) => setContext(e.target.checked)} />
          <Form.Check id="import-tasks" label="Tâches" checked={tasks} onChange={(e) => setTasks(e.target.checked)} />
          <Form.Check id="import-settings" label="Réglages" checked={settings} onChange={(e) => setSettings(e.target.checked)} />
        </div>
        <Form.Text className="d-block mb-2">
          Les instructions déjà présentes au même chemin sont laissées telles quelles ; les tâches sont ajoutées sans prévenir personne ni lancer d'agent. Les connexions ne sont jamais recréées : leurs secrets ne sont pas dans l'archive.
        </Form.Text>
        <Button size="sm" disabled={!file || tooBig || loading || !(context || tasks || settings)} onClick={() => void submit()}>
          {loading ? 'Import…' : 'Importer'}
        </Button>

        {error && (
          <Alert variant="danger" className="mt-3 mb-0 py-2 small">
            {error.message}
          </Alert>
        )}
        {report && (
          <Alert variant="success" className="mt-3 mb-0 py-2 small">
            Import terminé : {plural(report.foldersCreated, 'dossier', 'dossiers')} et {plural(report.instructionsCreated, 'instruction', 'instructions')} de contexte,{' '}
            {plural(report.tasksCreated, 'tâche', 'tâches')} ({plural(report.commentsCreated, 'message', 'messages')}){report.settingsUpdated ? ', réglages' : ''}.
            {report.instructionsSkipped.length > 0 && (
              <div>
                Déjà présentes, laissées telles quelles : {report.instructionsSkipped.join(', ')}.
              </div>
            )}
            {report.connections.length > 0 && <div>Connexions à recréer dans le coffre si besoin : {report.connections.join(', ')}.</div>}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}
