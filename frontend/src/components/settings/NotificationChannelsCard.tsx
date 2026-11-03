import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Form, InputGroup, Spinner } from 'react-bootstrap';
import {
  CREATE_NOTIFICATION_CHANNEL,
  DELETE_NOTIFICATION_CHANNEL,
  MY_NOTIFICATION_CHANNELS,
  PROJECT_NOTIFICATION_CHANNELS,
  PUSH_PREFERENCES,
  TEST_NOTIFICATION_CHANNEL,
  UPDATE_NOTIFICATION_CHANNEL,
  type NotificationChannel,
  type PushCategory,
} from '../../graphql/misc';
import { timeAgo } from '../../lib/humanize';
import { useDialogs } from '../Dialogs';

type Kind = NotificationChannel['kind'];

const KINDS: {
  kind: Kind;
  label: string;
  icon: string;
  placeholder: string;
}[] = [
  {
    kind: 'slack',
    label: 'Slack',
    icon: 'bi-slack',
    placeholder: 'https://hooks.slack.com/services/…',
  },
  {
    kind: 'discord',
    label: 'Discord',
    icon: 'bi-discord',
    placeholder: 'https://discord.com/api/webhooks/…',
  },
  {
    kind: 'email',
    label: 'E-mail',
    icon: 'bi-envelope',
    placeholder: 'adresse@exemple.fr',
  },
];
const kindOf = (k: Kind) => KINDS.find((x) => x.kind === k) ?? KINDS[0];

/** Familles cochées par défaut à l'ajout d'un canal (comme le serveur). */
const DEFAULT_CATEGORIES = ['requests', 'sessions', 'tasks', 'budget'];

function CategoryChecks({
  categories,
  value,
  onChange,
  idPrefix,
  disabled,
}: {
  categories: PushCategory[];
  value: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  return (
    <div className="d-flex flex-wrap gap-3">
      {categories.map((c) => (
        <Form.Check
          key={c.key}
          id={`${idPrefix}-${c.key}`}
          type="checkbox"
          label={c.label}
          title={c.description}
          checked={value.includes(c.key)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? [...value, c.key] : value.filter((k) => k !== c.key))}
        />
      ))}
    </div>
  );
}

/**
 * Canaux de notification hors navigateur (webhook Slack ou Discord, e-mail) : ceux d'un projet (`projectId`, réglés
 * par ses administrateurs) ou ceux de la personne connectée. Les notifications des familles cochées y sont relayées,
 * regroupées sur une minute (les demandes d'un agent partent aussitôt), avec un lien vers la page concernée.
 */
export default function NotificationChannelsCard({ projectId, canManage = true }: { projectId?: string; canManage?: boolean }) {
  const { confirm, showError } = useDialogs();
  const query = projectId ? PROJECT_NOTIFICATION_CHANNELS : MY_NOTIFICATION_CHANNELS;
  const variables = projectId ? { projectId } : undefined;
  const { data, loading, error } = useQuery<{
    projectNotificationChannels?: NotificationChannel[];
    myNotificationChannels?: NotificationChannel[];
    emailNotificationsAvailable: boolean;
  }>(query, {
    variables,
    fetchPolicy: 'cache-and-network',
  });
  const { data: prefs } = useQuery<{ pushPreferences: PushCategory[] }>(PUSH_PREFERENCES, { fetchPolicy: 'cache-first' });
  // Un canal de projet ne relaie pas les alertes réservées aux administrateurs de l'application.
  const categories = (prefs?.pushPreferences ?? []).filter((c) => !projectId || !c.adminsOnly);
  const channels = (projectId ? data?.projectNotificationChannels : data?.myNotificationChannels) ?? [];
  const emailAvailable = data?.emailNotificationsAvailable ?? false;
  const refetchQueries = [{ query, variables }];

  const [kind, setKind] = useState<Kind>('slack');
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<string[]>(DEFAULT_CATEGORIES);
  const [editing, setEditing] = useState<string | null>(null);
  const [testedId, setTestedId] = useState<string | null>(null);

  const [create, { loading: creating, error: createError }] = useMutation(CREATE_NOTIFICATION_CHANNEL, { refetchQueries });
  const [update] = useMutation(UPDATE_NOTIFICATION_CHANNEL);
  const [remove] = useMutation(DELETE_NOTIFICATION_CHANNEL, { refetchQueries });
  const [test, { loading: testing }] = useMutation(TEST_NOTIFICATION_CHANNEL);

  const labelOf = (key: string) => categories.find((c) => c.key === key)?.label ?? prefs?.pushPreferences.find((c) => c.key === key)?.label ?? key;

  return (
    <Card className={projectId ? 'mt-3' : 'mb-4'}>
      <Card.Header>{projectId ? 'Notifications Slack, Discord et e-mail' : 'Notifications par e-mail, Slack ou Discord'}</Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          {projectId
            ? 'Les notifications adressées à tous les membres du projet (demandes d’un agent, sessions, tâches, budget…) sont relayées sur ces canaux, avec un lien vers la page concernée.'
            : 'Tout ce que vous verriez dans votre cloche, pour les familles cochées, vous est aussi envoyé ici, avec un lien vers la page concernée.'}{' '}
          Les envois sont regroupés sur une minute ; une demande d’un agent part aussitôt.
        </p>
        {loading && !data && <Spinner size="sm" />}
        {error && (
          <Alert variant="danger" className="py-2">
            {error.message}
          </Alert>
        )}
        {channels.length === 0 && data && <div className="text-secondary mb-3">Aucun canal pour l’instant.</div>}
        {channels.map((c) => {
          const k = kindOf(c.kind);
          return (
            <div key={c.id} className="border rounded p-2 mb-2">
              <div className="d-flex flex-wrap align-items-center gap-2">
                <i className={`bi ${k.icon}`} aria-hidden />
                <strong>{k.label}</strong>
                <code className="text-break">{c.targetHint}</code>
                {!c.enabled && <Badge bg="secondary">en pause</Badge>}
                {c.lastSentAt && <span className="text-secondary">dernier envoi {timeAgo(c.lastSentAt)}</span>}
                {testedId === c.id && !c.lastError && <Badge bg="success">test envoyé</Badge>}
                {canManage && (
                  <span className="ms-auto d-flex align-items-center gap-2">
                    <Form.Check
                      type="switch"
                      id={`channel-enabled-${c.id}`}
                      label="actif"
                      checked={c.enabled}
                      onChange={(e) =>
                        void update({
                          variables: {
                            id: c.id,
                            patch: { enabled: e.target.checked },
                          },
                        }).catch(showError)
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={testing}
                      onClick={() => {
                        setTestedId(c.id);
                        void test({ variables: { id: c.id } }).catch((err) => {
                          setTestedId(null);
                          void showError(err);
                        });
                      }}
                    >
                      Tester
                    </Button>
                    <Button size="sm" variant="outline-secondary" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                      Familles
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: 'Supprimer le canal',
                            message: `Ne plus envoyer de notifications vers ${k.label} (${c.targetHint}) ?`,
                            confirmLabel: 'Supprimer',
                            danger: true,
                          })
                        )
                          void remove({ variables: { id: c.id } }).catch(showError);
                      }}
                    >
                      <i className="bi bi-trash" aria-label="Supprimer" />
                    </Button>
                  </span>
                )}
              </div>
              {editing === c.id ? (
                <div className="mt-2">
                  <CategoryChecks
                    categories={categories}
                    value={c.categories}
                    idPrefix={`channel-${c.id}`}
                    onChange={(next) =>
                      void update({
                        variables: { id: c.id, patch: { categories: next } },
                        optimisticResponse: {
                          updateNotificationChannel: {
                            __typename: 'NotificationChannel',
                            ...c,
                            categories: next,
                          },
                        },
                      }).catch(showError)
                    }
                  />
                </div>
              ) : (
                <div className="text-secondary mt-1">{c.categories.length ? c.categories.map(labelOf).join(' · ') : 'Aucune famille : rien n’est envoyé.'}</div>
              )}
              {c.lastError && <div className="text-danger mt-1">Dernier envoi en échec : {c.lastError}</div>}
            </div>
          );
        })}

        {canManage && (
          <Form
            className="mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create({
                variables: {
                  input: {
                    ...(projectId ? { projectId } : {}),
                    kind,
                    target: target.trim(),
                    categories: selected,
                  },
                },
              })
                .then(() => setTarget(''))
                .catch(() => undefined);
            }}
          >
            <InputGroup className="mb-2">
              <Form.Select aria-label="Type de canal" value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ maxWidth: '9rem' }}>
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </Form.Select>
              <Form.Control
                aria-label="Adresse du webhook ou e-mail"
                type={kind === 'email' ? 'email' : 'url'}
                placeholder={kindOf(kind).placeholder}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
              <Button type="submit" disabled={creating || !target.trim() || (kind === 'email' && !emailAvailable)}>
                Ajouter
              </Button>
            </InputGroup>
            {kind === 'email' && !emailAvailable && (
              <div className="text-warning mb-2">Aucun serveur SMTP n’est configuré : un administrateur le règle dans Paramètres › Serveur.</div>
            )}
            {kind !== 'email' && (
              <div className="text-secondary mb-2">
                {kind === 'slack'
                  ? 'Slack : créez une application avec « Incoming Webhooks » et choisissez le canal, puis collez l’adresse du webhook.'
                  : 'Discord : Paramètres du salon › Intégrations › Webhooks › Nouveau webhook, puis « Copier l’URL du webhook ».'}
              </div>
            )}
            <CategoryChecks categories={categories} value={selected} onChange={setSelected} idPrefix={`new-channel-${projectId ?? 'me'}`} />
            {createError && (
              <Alert variant="danger" className="mt-2 mb-0 py-2">
                {createError.message}
              </Alert>
            )}
          </Form>
        )}
      </Card.Body>
    </Card>
  );
}
