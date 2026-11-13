import { useMutation, useQuery } from '@apollo/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Spinner } from 'react-bootstrap';
import CodeMirror from '@uiw/react-codemirror';
import { keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { fileViewUrl } from '../apollo';
import { WORKSPACE_FILE, WRITE_WORKSPACE_FILE, type FileContent } from '../graphql/operations';
import { fileIcon, formatSize, type WorkspaceRef } from '../lib/files';
import { useTheme } from '../lib/theme';
import { darkAppTheme, lightAppTheme } from '../lib/codemirrorTheme';
import PageLoading from './PageLoading';
import PublishPageModal from './pages/PublishPageModal';

const fmtDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const isHtml = (name: string) => /\.html?$/i.test(name);
const isSvg = (name: string) => /\.svg$/i.test(name);
/** Fichiers binaires que le navigateur sait afficher (servis avec leur type par /api/files/view). */
function mediaKind(name: string): 'image' | 'video' | 'audio' | null {
  if (/\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(name)) return 'image';
  if (/\.(mp4|webm|mov)$/i.test(name)) return 'video';
  if (/\.(mp3|wav|ogg|m4a)$/i.test(name)) return 'audio';
  return null;
}

interface Props {
  wsRef: WorkspaceRef;
  path: string;
  /** Le fichier a des modifications non enregistrées (pour marquer l'onglet). */
  onDirty?: (dirty: boolean) => void;
  /** Signal de rechargement externe (bouton Actualiser de l'explorateur). */
  refreshKey?: number;
}

/** Éditeur d'un fichier du dossier de travail : CodeMirror, enregistrement (⌘S) avec détection de conflit, aperçu HTML, téléchargement, publication. */
export default function FileEditor({ wsRef, path, onDirty, refreshKey = 0 }: Props) {
  const uiTheme = useTheme();
  const { data, loading, error, refetch } = useQuery<{ workspaceFile: FileContent }>(WORKSPACE_FILE, { variables: { ...wsRef, path }, fetchPolicy: 'network-only' });
  const file = data?.workspaceFile;
  const name = path.split('/').pop() ?? path;
  const [doc, setDoc] = useState('');
  const [saved, setSaved] = useState('');
  const [modifiedAt, setModifiedAt] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [language, setLanguage] = useState<Extension | null>(null);
  const [preview, setPreview] = useState(() => isHtml(name) || isSvg(name));
  const [previewKey, setPreviewKey] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const dirty = doc !== saved;
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);

  useEffect(() => {
    if (!file || file.binary || file.content === null) return;
    setDoc(file.content);
    setSaved(file.content);
    setModifiedAt(file.modifiedAt);
    setSize(file.size);
    setConflict(false);
  }, [file]);
  // Actualisation demandée depuis l'explorateur : sans modifications en cours seulement.
  const firstRefresh = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstRefresh.current) return;
    firstRefresh.current = refreshKey;
    if (!dirty) void refetch();
    setPreviewKey((k) => k + 1);
  }, [refreshKey, dirty, refetch]);

  useEffect(() => {
    let cancelled = false;
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) {
      setLanguage(null);
      return;
    }
    desc.load().then((support) => {
      if (!cancelled) setLanguage(support);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const [write, { loading: saving }] = useMutation<{ writeWorkspaceFile: FileContent }>(WRITE_WORKSPACE_FILE);
  const docRef = useRef(doc);
  docRef.current = doc;
  const save = useCallback(
    async (force = false) => {
      if (saving) return;
      setSaveError(null);
      const content = docRef.current;
      try {
        const res = await write({ variables: { ...wsRef, path, content, expectedModifiedAt: force ? null : modifiedAt } });
        const written = res.data?.writeWorkspaceFile;
        if (written) {
          setSaved(content);
          setModifiedAt(written.modifiedAt);
          setSize(written.size);
          setConflict(false);
          setSavedFlash(true);
          setPreviewKey((k) => k + 1);
          setTimeout(() => setSavedFlash(false), 1500);
        }
      } catch (err) {
        const e = err as { graphQLErrors?: { extensions?: { code?: string } }[]; message: string };
        if (e.graphQLErrors?.some((g) => g.extensions?.code === 'FILE_CONFLICT')) setConflict(true);
        else setSaveError(e.message);
      }
    },
    [wsRef, saving, write, path, modifiedAt],
  );

  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [
      uiTheme === 'light' ? lightAppTheme : darkAppTheme,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void save();
              return true;
            },
          },
        ]),
      ),
    ];
    if (language) list.push(language);
    return list;
  }, [language, save, uiTheme]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (loading && !file) return <PageLoading className="p-3" />;
  if (error) return <Alert variant="danger" className="m-3">{error.message}</Alert>;
  if (!file) return null;
  const html = isHtml(file.name);
  const svg = isSvg(file.name);
  const media = file.binary ? mediaKind(file.name) : null;
  const viewUrl = fileViewUrl(wsRef.projectId, wsRef.worksessionId, path);
  // Le paramètre v force le rechargement de l'image après Actualiser ou Enregistrer (la route l'ignore).
  const mediaUrl = `${viewUrl}?v=${previewKey}`;
  return (
    <div className="fe-page">
      <div className="fe-header">
        <div className="fe-path" title={file.path}>
          <i className={`bi ${fileIcon(file.name, 'file')} me-1`} />
          <span className="fe-name">{file.path}</span>
          {dirty && <span className="fe-dirty" title="Modifications non enregistrées">●</span>}
        </div>
        <div className="fe-meta">
          <span className="fx-muted">
            {formatSize(size ?? file.size)}
            {modifiedAt ? ` · ${fmtDate(modifiedAt)}` : ''}
          </span>
          {savedFlash && (
            <span className="text-success">
              <i className="bi bi-check2 me-1" />
              Enregistré
            </span>
          )}
          {(html || svg) && (
            <div className="btn-group btn-group-sm" role="group">
              <Button size="sm" variant={preview ? 'secondary' : 'outline-secondary'} onClick={() => setPreview(true)} title={html ? 'Aperçu rendu (bac à sable)' : 'Aperçu de l’image'}>
                Aperçu
              </Button>
              <Button size="sm" variant={!preview ? 'secondary' : 'outline-secondary'} onClick={() => setPreview(false)}>
                Code
              </Button>
            </div>
          )}
          <a className="btn btn-sm btn-outline-secondary" href={fileViewUrl(wsRef.projectId, wsRef.worksessionId, path, true)} title="Télécharger le fichier tel qu'enregistré">
            <i className="bi bi-download" />
          </a>
          {html && (
            <Button size="sm" variant="outline-secondary" onClick={() => setPublishing(true)} title="Publier comme page partagée">
              <i className="bi bi-share me-1" /> Publier
            </Button>
          )}
          <Button size="sm" variant="outline-secondary" onClick={() => void refetch().then(() => setPreviewKey((k) => k + 1))} disabled={loading} title="Recharger depuis le serveur">
            <i className="bi bi-arrow-clockwise" />
          </Button>
          {!file.binary && (
            <Button size="sm" onClick={() => save()} disabled={!dirty || saving} title="Enregistrer (Ctrl/Cmd + S)">
              {saving ? (
                <Spinner size="sm" />
              ) : (
                <>
                  <i className="bi bi-save me-1" /> Enregistrer
                </>
              )}
            </Button>
          )}
        </div>
      </div>
      {conflict && (
        <Alert variant="warning" className="fe-alert">
          Le fichier a été modifié sur le serveur depuis son ouverture (par un agent ou un autre onglet).{' '}
          <Button size="sm" variant="outline-secondary" className="ms-2" onClick={() => refetch()}>
            Recharger (perdre mes modifications)
          </Button>{' '}
          <Button size="sm" variant="warning" className="ms-1" onClick={() => save(true)}>
            Écraser avec ma version
          </Button>
        </Alert>
      )}
      {saveError && (
        <Alert variant="danger" className="fe-alert" dismissible onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}
      {media ? (
        <MediaView kind={media} src={mediaUrl} name={file.name} />
      ) : svg && preview ? (
        <MediaView kind="image" src={mediaUrl} name={file.name} />
      ) : file.binary ? (
        <div className="p-3 fx-muted">
          Fichier binaire ({formatSize(file.size)}) : pas d'aperçu.{' '}
          <a href={fileViewUrl(wsRef.projectId, wsRef.worksessionId, path, true)}>Télécharger</a>
        </div>
      ) : html && preview ? (
        <iframe key={previewKey} className="preview-frame" title={file.name} src={viewUrl} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" />
      ) : (
        <div className="fe-editor">
          <CodeMirror
            value={doc}
            height="100%"
            theme={uiTheme === 'light' ? 'light' : oneDark}
            extensions={extensions}
            onChange={(value) => setDoc(value)}
            basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, bracketMatching: true, autocompletion: false, tabSize: 2 }}
          />
        </div>
      )}
      {publishing && <PublishPageModal projectId={wsRef.projectId} worksessionId={wsRef.worksessionId} path={path} html={saved} onClose={() => setPublishing(false)} />}
    </div>
  );
}

/**
 * Aperçu d'une image, d'une vidéo ou d'un son du dossier de travail. L'image tient dans la zone (clic : taille
 * réelle, et inversement) sur un damier qui laisse voir la transparence ; ses dimensions s'affichent dessous.
 * Une image SVG passe par <img> : ses scripts ne s'exécutent pas.
 */
function MediaView({ kind, src, name }: { kind: 'image' | 'video' | 'audio'; src: string; name: string }) {
  const [actual, setActual] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <div className="p-3 fx-muted">Le navigateur ne sait pas afficher ce fichier.</div>;
  if (kind === 'video')
    return (
      <div className="fe-media">
        <video src={src} controls className="fe-media-fit" onError={() => setFailed(true)} />
      </div>
    );
  if (kind === 'audio')
    return (
      <div className="fe-media">
        <audio src={src} controls onError={() => setFailed(true)} />
      </div>
    );
  return (
    <div className="fe-media-wrap">
      <div className={`fe-media fe-media-checker${actual ? ' actual' : ''}`}>
        <img
          src={src}
          alt={name}
          className={actual ? undefined : 'fe-media-fit'}
          onClick={() => setActual((a) => !a)}
          title={actual ? 'Ajuster à la zone' : 'Taille réelle'}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
      </div>
      {dims && (
        <div className="fe-media-dims">
          {dims.w} × {dims.h} px · {actual ? 'taille réelle' : 'ajustée'} (clic pour basculer)
        </div>
      )}
    </div>
  );
}
