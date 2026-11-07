import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Form } from 'react-bootstrap';
import { useSearchParams } from 'react-router-dom';
import { googleLinkUrl, providerLinkUrl } from '../../apollo';
import { MY_LOGIN_METHODS, REMOVE_MY_PASSWORD, SET_MY_PASSWORD, UNLINK_MY_LOGIN_IDENTITY, type MyLoginMethods } from '../../graphql/login';
import { timeAgo } from '../../lib/humanize';
import { useDialogs } from '../Dialogs';
import PageLoading from '../PageLoading';

const ICONS: Record<string, string> = { google: 'bi-google', microsoft: 'bi-microsoft', github: 'bi-github' };

/**
 * Paramètres › Connexion : comptes Google, Microsoft et GitHub reliés pour se connecter, et mot de passe.
 * Relier un compte Microsoft ou GitHub ici le reconnaît ensuite quelle que soit son adresse.
 */
export default function LoginMethodsSection() {
  const { confirm, showError } = useDialogs();
  const [searchParams, setSearchParams] = useSearchParams();
  const linked = searchParams.get('linked');
  const linkError = searchParams.get('loginError');
  const { data, loading, error } = useQuery<{ myLoginMethods: MyLoginMethods }>(MY_LOGIN_METHODS, { fetchPolicy: 'cache-and-network' });
  const [unlink] = useMutation(UNLINK_MY_LOGIN_IDENTITY, { onError: (e) => void showError(e) });
  const [removePassword] = useMutation(REMOVE_MY_PASSWORD, { onError: (e) => void showError(e) });
  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!data) return null;
  const m = data.myLoginMethods;
  const clearNotice = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('linked');
    next.delete('loginError');
    setSearchParams(next, { replace: true });
  };
  const methodCount = (m.hasPassword ? 1 : 0) + (m.googleLinked ? 1 : 0) + m.identities.length;

  return (
    <>
      {linked && (
        <Alert variant="success" className="small py-2" dismissible onClose={clearNotice}>
          Compte {m.providers.find((p) => p.id === linked)?.label ?? linked} relié : vous pouvez maintenant vous connecter avec lui.
        </Alert>
      )}
      {linkError && (
        <Alert variant="warning" className="small py-2" dismissible onClose={clearNotice}>
          {linkError}
        </Alert>
      )}
      <Card className="mb-4">
        <Card.Header>Comptes de connexion</Card.Header>
        <Card.Body>
          <p className="small text-secondary">
            Vous vous connectez à Skipper avec l'adresse <strong>{m.email}</strong>. Un compte Google, Microsoft ou GitHub de la même adresse (vérifiée) est reconnu à sa première
            connexion ; reliez ici un compte d'une autre adresse, ou un compte professionnel Microsoft dont l'adresse n'est pas garantie.
          </p>
          <div className="border-top">
              {m.providers.map((p) => {
                const identity = m.identities.find((i) => i.provider === p.id);
                const isLinked = p.id === 'google' ? m.googleLinked : Boolean(identity);
                return (
                  <div key={p.id} className="d-flex flex-wrap align-items-center gap-2 py-2 border-bottom">
                    <div className="text-nowrap" style={{ width: 120 }}>
                      <i className={`bi ${ICONS[p.id] ?? 'bi-person'} me-2`} />
                      {p.label}
                    </div>
                    <div className="small flex-grow-1" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {isLinked ? (
                        <>
                          <Badge bg="success" className="me-2">relié</Badge>
                          {identity?.email ?? (p.id === 'google' ? m.email : '')}
                          {identity?.lastUsedAt && <span className="text-secondary"> · utilisé {timeAgo(identity.lastUsedAt)}</span>}
                        </>
                      ) : p.configured ? (
                        <span className="text-secondary">non relié</span>
                      ) : (
                        <span className="text-secondary">non configuré sur ce serveur</span>
                      )}
                    </div>
                    <div className="text-nowrap ms-auto">
                      {p.configured && !(p.id === 'google' && isLinked) && (
                        <Button
                          size="sm"
                          variant="outline-primary"
                          href={p.id === 'google' ? googleLinkUrl() : providerLinkUrl(p.id as 'microsoft' | 'github')}
                          title={p.id === 'google' ? `Se connecter avec le compte Google de ${m.email} le relie` : undefined}
                          className="me-1"
                        >
                          {isLinked ? 'Changer' : 'Relier'}
                        </Button>
                      )}
                      {isLinked && (
                        <Button
                          size="sm"
                          variant="outline-danger"
                          onClick={async () => {
                            const last = methodCount <= 1;
                            if (
                              await confirm({
                                title: `Retirer le compte ${p.label}`,
                                message: last
                                  ? `C'est votre seul moyen de connexion relié. ${p.id === 'google' ? 'Un compte Google de la même adresse sera de nouveau reconnu à la prochaine connexion.' : 'Choisissez d’abord un mot de passe ou reliez un autre compte, sinon vous ne pourrez plus vous connecter qu’avec Google.'}`
                                  : `Vous ne pourrez plus vous connecter avec ce compte ${p.label} (sauf s'il porte la même adresse vérifiée).`,
                                confirmLabel: 'Retirer',
                                danger: true,
                              })
                            )
                              void unlink({ variables: { provider: p.id } });
                          }}
                        >
                          Retirer
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </Card.Body>
      </Card>
      {m.passwordLoginEnabled && (
        <PasswordCard
          methods={m}
          onRemove={async () => {
            if (await confirm({ title: 'Retirer le mot de passe', message: 'Vous ne pourrez plus vous connecter par e-mail et mot de passe.', confirmLabel: 'Retirer', danger: true })) void removePassword();
          }}
        />
      )}
    </>
  );
}

function PasswordCard({ methods: m, onRemove }: { methods: MyLoginMethods; onRemove: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [save, { loading, error }] = useMutation(SET_MY_PASSWORD, {
    onCompleted: () => {
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    },
  });
  return (
    <Card className="mb-4">
      <Card.Header>
        Mot de passe
        {m.hasPassword ? <Badge bg="success" className="ms-2">défini</Badge> : <Badge bg="secondary" className="ms-2">aucun</Badge>}
      </Card.Header>
      <Card.Body>
        <p className="small text-secondary">
          {m.hasPassword && m.passwordSetAt ? `Défini ${timeAgo(m.passwordSetAt)}. ` : ''}
          Pour vous connecter avec <strong>{m.email}</strong> et un mot de passe, sans compte Google, Microsoft ou GitHub. Au moins 10 caractères ; changer le mot de passe ferme vos autres sessions.
        </p>
        <Form
          style={{ maxWidth: 420 }}
          onSubmit={(e) => {
            e.preventDefault();
            setDone(false);
            if (next !== again) return setLocalError('Les deux mots de passe ne correspondent pas');
            setLocalError(null);
            void save({ variables: { currentPassword: m.hasPassword ? current : null, newPassword: next } }).catch(() => undefined);
          }}
        >
          <input type="email" autoComplete="username" value={m.email} readOnly hidden />
          {m.hasPassword && (
            <Form.Group className="mb-2" controlId="pwd-current">
              <Form.Label className="small mb-1">Mot de passe actuel</Form.Label>
              <Form.Control size="sm" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </Form.Group>
          )}
          <Form.Group className="mb-2" controlId="pwd-new">
            <Form.Label className="small mb-1">{m.hasPassword ? 'Nouveau mot de passe' : 'Mot de passe'}</Form.Label>
            <Form.Control size="sm" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
          </Form.Group>
          <Form.Group className="mb-2" controlId="pwd-again">
            <Form.Label className="small mb-1">Confirmation</Form.Label>
            <Form.Control size="sm" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          </Form.Group>
          {(localError || error) && <div className="text-danger small mb-2">{localError ?? error?.message}</div>}
          {done && <div className="text-success small mb-2">Mot de passe enregistré.</div>}
          <div className="d-flex gap-2">
            <Button size="sm" type="submit" disabled={loading || !next || !again || (m.hasPassword && !current)}>
              {m.hasPassword ? 'Changer le mot de passe' : 'Choisir ce mot de passe'}
            </Button>
            {m.hasPassword && (
              <Button size="sm" variant="outline-danger" onClick={onRemove}>
                Retirer le mot de passe
              </Button>
            )}
          </div>
        </Form>
      </Card.Body>
    </Card>
  );
}
