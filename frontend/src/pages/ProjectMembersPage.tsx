import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Card, Form, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useDialogs } from '../components/Dialogs';
import { ProjectPageLoading } from '../components/PageLoading';
import ProjectHeader, { type ProjectHeaderProject } from '../components/ProjectHeader';
import { EMAIL_AVAILABLE } from '../graphql/misc';
import { INVITE_PROJECT_MEMBER, PROJECT_MEMBERS, REMOVE_PROJECT_MEMBER, UPDATE_PROJECT_MEMBER_ROLE, type ProjectMember, type ProjectRole } from '../graphql/operations';
import { projectRoleLabels } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

const ROLES: ProjectRole[] = ['ADMIN', 'MEMBER', 'VIEWER', 'GUEST'];

/** Membres du projet : liste avec rôle, invitation par e-mail et retrait (administrateurs du projet). */
function MembersCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { user: me } = useAuth();
  const { data } = usePollingQuery<{ project: { members: ProjectMember[] } | null }>(PROJECT_MEMBERS, { variables: { id: projectId }, pollInterval: 10000 });
  const refetch = { refetchQueries: ['ProjectMembers'] };
  const [invite, { loading: inviting, error: inviteError }] = useMutation(INVITE_PROJECT_MEMBER, refetch);
  const [setRole, { error: roleError }] = useMutation(UPDATE_PROJECT_MEMBER_ROLE, refetch);
  const { confirm } = useDialogs();
  const [remove, { error: removeError }] = useMutation(REMOVE_PROJECT_MEMBER, refetch);
  const [email, setEmail] = useState('');
  const [role, setRoleInput] = useState<ProjectRole>('MEMBER');
  const [message, setMessage] = useState('');
  const { data: mail } = useQuery<{ emailNotificationsAvailable: boolean }>(EMAIL_AVAILABLE);
  const canEmail = Boolean(mail?.emailNotificationsAvailable);
  const members = data?.project?.members ?? [];
  const error = inviteError ?? roleError ?? removeError;
  return (
    <Card>
      <Card.Header>Membres</Card.Header>
      <Card.Body className="small">
        <Table size="sm" className="mb-3 align-middle table-stack">
          <tbody>
            {members.map((m) => (
              <tr key={m.user.id}>
                <td>
                  <strong>{m.user.name}</strong>
                  {m.user.id === me?.id && <span className="text-secondary"> (vous)</span>}
                  {m.user.kind === 'AGENT' && (
                    <Link to={`/projects/${projectId}/agents/${m.user.id}`} className="badge text-bg-info ms-2 text-decoration-none" title="Agent de projet : membre qui n'est pas une personne (fiche, comptes, activité)">
                      <i className="bi bi-robot" /> agent
                    </Link>
                  )}
                  {m.pending && !(m.user.kind === 'AGENT') && (
                    <span className="badge text-bg-secondary ms-2" title="Invité, ne s'est pas encore connecté">
                      en attente
                    </span>
                  )}
                  <div className="text-secondary">{m.user.email}</div>
                </td>
                <td style={{ width: 180 }}>
                  {canManage ? (
                    <Form.Select size="sm" value={m.role} title={projectRoleLabels[m.role]?.hint} onChange={(e) => setRole({ variables: { projectId, userId: m.user.id, role: e.target.value } })}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {projectRoleLabels[r].label}
                        </option>
                      ))}
                    </Form.Select>
                  ) : (
                    <span title={projectRoleLabels[m.role]?.hint}>{projectRoleLabels[m.role]?.label ?? m.role}</span>
                  )}
                </td>
                {canManage && (
                  <td className="text-end" style={{ width: 90 }}>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={async () => {
                        if (await confirm({ title: 'Retirer le membre', message: `Retirer ${m.user.name} du projet ? Cette personne n'y aura plus accès.`, confirmLabel: 'Retirer', danger: true })) remove({ variables: { projectId, userId: m.user.id } });
                      }}
                    >
                      Retirer
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
        {canManage && (
          <Form
            className="d-flex gap-2 align-items-end flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              invite({ variables: { projectId, email: email.trim(), role, message: role === 'GUEST' && message.trim() ? message.trim() : null } }).then(() => {
                setEmail('');
                setMessage('');
              });
            }}
          >
            <Form.Group>
              <Form.Label className="mb-1">Inviter par e-mail</Form.Label>
              <Form.Control size="sm" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@exemple.com" style={{ width: 260 }} />
            </Form.Group>
            <Form.Group>
              <Form.Label className="mb-1">Rôle</Form.Label>
              <Form.Select size="sm" value={role} onChange={(e) => setRoleInput(e.target.value as ProjectRole)} style={{ width: 160 }}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {projectRoleLabels[r].label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <Button type="submit" size="sm" disabled={inviting || !email.trim()}>
              {inviting ? 'Invitation…' : 'Inviter'}
            </Button>
            {role === 'GUEST' && (
              <Form.Group className="w-100">
                <Form.Label className="mb-1">Mot d’accueil (facultatif, repris dans l’e-mail d’invitation)</Form.Label>
                <Form.Control as="textarea" size="sm" rows={2} value={message} maxLength={2000} placeholder="Bonjour Claire, voici l’espace où nous échangeons avec l’équipe et ses agents…" onChange={(e) => setMessage(e.target.value)} />
              </Form.Group>
            )}
            <div className="text-secondary w-100">
              {projectRoleLabels[role].hint}{' '}
              {role === 'GUEST'
                ? canEmail
                  ? 'Elle reçoit un e-mail qui la mène droit aux conversations ; si elle n’a pas d’autre accès à Skipper, le lien la connecte directement, sans mot de passe.'
                  : 'L’envoi des e-mails n’est pas configuré : transmettez-lui l’adresse de Skipper, elle se connecte avec cette adresse (compte Google, Microsoft, GitHub ou mot de passe).'
                : 'La personne se connecte avec cette adresse (compte Google, Microsoft, GitHub ou mot de passe).'}
            </div>
          </Form>
        )}
        {error && (
          <Alert variant="danger" className="mt-2 mb-0">
            {error.message}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * Onglet « Membres » d'un projet : les personnes et agents du projet avec leur rôle ; ses administrateurs y invitent
 * par e-mail, changent les rôles et retirent des membres. Pas d'espace personnel (il n'appartient qu'à la personne).
 */
export default function ProjectMembersPage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ project: (ProjectHeaderProject & { members: ProjectMember[] }) | null }>(PROJECT_MEMBERS, { variables: { id } });
  const project = data?.project;
  useTabTitle(project ? `Membres · ${project.name}` : null);
  if (loading && !data) return <ProjectPageLoading id={id} />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  if (project.isPersonal) return <Alert variant="info">Votre espace personnel n’appartient qu’à vous : on n’y invite personne.</Alert>;
  return (
    <>
      <ProjectHeader project={project} active="members" />
      <MembersCard projectId={project.id} canManage={project.myRole === 'ADMIN'} />
    </>
  );
}
