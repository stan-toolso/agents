import { useEffect, useState } from 'react';
import { Alert, Button, Form, Spinner } from 'react-bootstrap';
import { useLocation } from 'react-router-dom';
import AuthShell from '../components/AuthShell';
import { authPost, fetchAuthMethods, googleLoginUrl, providerLoginUrl, type AuthMethods } from '../apollo';

const errorMessages: Record<string, string> = {
  not_invited: "Cette adresse n'a été invitée sur aucun projet. Demandez une invitation à l'administrateur d'un projet.",
  account_mismatch: 'Cette adresse est déjà reliée à un autre compte.',
  not_configured: "Ce mode de connexion n'est pas configuré sur le serveur.",
  invalid_state: 'La connexion a expiré ou a été altérée. Réessayez.',
  cancelled: 'Connexion annulée.',
  access_denied: 'Connexion refusée par le fournisseur.',
  google_error: 'Google a renvoyé une erreur pendant la connexion. Réessayez.',
  provider_error: 'Le fournisseur a renvoyé une erreur pendant la connexion. Réessayez.',
  unauthenticated: 'Connectez-vous d’abord.',
};

/** Codes dont le message du serveur est plus précis que le nôtre (adresse non garantie, annuaire refusé…). */
const serverMessageFirst = new Set(['email_not_verified', 'provider_error', 'bad_request', 'account_mismatch']);

type Mode = 'login' | 'forgot' | 'sent';

/**
 * Écran de connexion : Google, Microsoft, GitHub (ceux que le serveur a configurés) et e-mail + mot de passe.
 * Affiche l'erreur éventuelle renvoyée par le serveur (`?authError=`, `&authMessage=`).
 */
export default function LoginPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const errorCode = params.get('authError');
  const errorMessage = params.get('authMessage');
  params.delete('authError');
  params.delete('authMessage');
  const nextRaw = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
  const next = nextRaw === '/' ? '/' : nextRaw;

  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  useEffect(() => {
    fetchAuthMethods()
      .then(setMethods)
      .catch((e: Error) => {
        setMethodsError(e.message);
        // Serveur ancien ou injoignable : on garde au moins Google.
        setMethods({ google: true, microsoft: false, github: false, password: false, passwordReset: false });
      });
  }, []);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await authPost('password/login', { email, password });
      // Rechargement complet : l'application repart avec la session ouverte.
      window.location.assign(next);
    } catch (err) {
      setFormError((err as Error).message);
      setBusy(false);
    }
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await authPost('password/forgot', { email });
      setMode('sent');
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shownError = errorCode ? ((serverMessageFirst.has(errorCode) && errorMessage) || errorMessages[errorCode] || errorMessage || `Connexion impossible (${errorCode}).`) : null;
  const oauth = methods ? [methods.google, methods.microsoft, methods.github].some(Boolean) : false;
  const nothing = methods && !oauth && !methods.password;

  return (
    <AuthShell>
      <div>
        <h2 className="auth-card-title">{mode === 'login' ? 'Connexion' : 'Choisir un mot de passe'}</h2>
        <p className="auth-card-sub">
          {mode === 'login'
            ? 'Utilisez le compte invité sur vos projets, ou l’adresse avec laquelle on vous a partagé une page.'
            : 'Recevez par e-mail un lien pour choisir ou réinitialiser votre mot de passe.'}
        </p>
        {shownError && (
          <Alert variant="warning" className="text-start py-2 small">
            {shownError}
          </Alert>
        )}
        {!methods && (
          <div className="text-center text-secondary">
            <Spinner animation="border" size="sm" />
          </div>
        )}
        {nothing && (
          <Alert variant="danger" className="small py-2">
            Aucun mode de connexion n'est configuré sur ce serveur{methodsError ? ` (${methodsError})` : ''}.
          </Alert>
        )}
        {methods && (
          <div className="d-grid gap-2">
            {methods.google && (
              <Button href={googleLoginUrl(next)} size="lg" variant={methods.password || methods.microsoft || methods.github ? 'outline-primary' : 'primary'}>
                <i className="bi bi-google me-2" />
                Se connecter avec Google
              </Button>
            )}
            {methods.microsoft && (
              <Button href={providerLoginUrl('microsoft', next)} size="lg" variant="outline-primary">
                <i className="bi bi-microsoft me-2" />
                Se connecter avec Microsoft
              </Button>
            )}
            {methods.github && (
              <Button href={providerLoginUrl('github', next)} size="lg" variant="outline-primary">
                <i className="bi bi-github me-2" />
                Se connecter avec GitHub
              </Button>
            )}
          </div>
        )}
        {methods?.password && (
          <>
            {oauth && (
              <div className="d-flex align-items-center gap-2 my-3 text-secondary small">
                <hr className="flex-grow-1 m-0" />
                ou
                <hr className="flex-grow-1 m-0" />
              </div>
            )}
            {mode === 'login' && (
              <Form onSubmit={submitPassword}>
                <Form.Group className="mb-2" controlId="login-email">
                  <Form.Label className="small mb-1">Adresse e-mail</Form.Label>
                  <Form.Control type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Form.Group>
                <Form.Group className="mb-2" controlId="login-password">
                  <Form.Label className="small mb-1">Mot de passe</Form.Label>
                  <Form.Control type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Form.Group>
                {formError && <div className="text-danger small mb-2">{formError}</div>}
                <Button type="submit" className="w-100" disabled={busy || !email || !password}>
                  {busy ? <Spinner animation="border" size="sm" /> : 'Se connecter'}
                </Button>
                <div className="text-center mt-2 small">
                  {methods.passwordReset ? (
                    <Button variant="link" size="sm" className="p-0" onClick={() => (setMode('forgot'), setFormError(null))}>
                      Mot de passe oublié, ou pas encore de mot de passe&nbsp;?
                    </Button>
                  ) : (
                    <span className="text-secondary">Pas encore de mot de passe ? Demandez un lien à un administrateur, ou choisissez-le dans Paramètres › Connexion après vous être connecté autrement.</span>
                  )}
                </div>
              </Form>
            )}
            {mode === 'forgot' && (
              <Form onSubmit={submitForgot}>
                <p className="small text-secondary mb-2">Saisissez l'adresse invitée : le lien est valable une heure.</p>
                <Form.Control type="email" autoComplete="username" className="mb-2" placeholder="adresse@exemple.fr" value={email} onChange={(e) => setEmail(e.target.value)} required />
                {formError && <div className="text-danger small mb-2">{formError}</div>}
                <Button type="submit" className="w-100" disabled={busy || !email}>
                  {busy ? <Spinner animation="border" size="sm" /> : 'Recevoir le lien'}
                </Button>
                <div className="text-center mt-2">
                  <Button variant="link" size="sm" onClick={() => setMode('login')}>
                    Retour
                  </Button>
                </div>
              </Form>
            )}
            {mode === 'sent' && (
              <Alert variant="success" className="small py-2">
                Si {email} est une adresse invitée, un lien vient de lui être envoyé. Pensez à regarder dans les indésirables.
                <div className="mt-2">
                  <Button variant="link" size="sm" className="p-0" onClick={() => setMode('login')}>
                    Retour à la connexion
                  </Button>
                </div>
              </Alert>
            )}
          </>
        )}
      </div>
    </AuthShell>
  );
}
