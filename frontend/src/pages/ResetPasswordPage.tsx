import { useEffect, useState } from 'react';
import { Alert, Button, Form, Spinner } from 'react-bootstrap';
import AuthShell from '../components/AuthShell';
import { authPost, fetchPasswordToken, forgetCachedUser } from '../apollo';

/**
 * Choisir ou réinitialiser son mot de passe depuis un lien (`/reset-password?token=…`, envoyé par « mot de passe
 * oublié » ou créé par un administrateur). Accessible sans session ; une fois le mot de passe choisi, la personne est connectée.
 */
export default function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [info, setInfo] = useState<{ valid: boolean; email?: string; name?: string; hasPassword?: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPasswordToken(token)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('Les deux mots de passe ne correspondent pas');
    setBusy(true);
    setError(null);
    try {
      await authPost('password/reset', { token, password });
      forgetCachedUser();
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell showcase={false}>
      <div>
        {!info && (
          <div className="text-center text-secondary">
            <Spinner animation="border" size="sm" />
          </div>
        )}
        {info && !info.valid && (
          <Alert variant="warning" className="small">
            Ce lien a expiré ou a déjà servi. Demandez-en un nouveau depuis la page de connexion (« Mot de passe oublié ») ou à un administrateur.
            <div className="mt-2">
              <a href="/">Page de connexion</a>
            </div>
          </Alert>
        )}
        {info?.valid && (
          <Form onSubmit={submit}>
            <h2 className="auth-card-title">{info.hasPassword ? 'Nouveau mot de passe' : 'Choisissez votre mot de passe'}</h2>
            <p className="text-secondary small mb-3">
              Pour {info.name ? `${info.name}, ` : ''}
              <strong>{info.email}</strong>. Au moins 10 caractères ; une phrase de quelques mots convient très bien.
            </p>
            {/* Champ caché : les gestionnaires de mots de passe associent le mot de passe à l'adresse. */}
            <input type="email" autoComplete="username" value={info.email} readOnly hidden />
            <Form.Group className="mb-2" controlId="reset-password">
              <Form.Label className="small mb-1">Mot de passe</Form.Label>
              <Form.Control type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </Form.Group>
            <Form.Group className="mb-2" controlId="reset-confirm">
              <Form.Label className="small mb-1">Confirmation</Form.Label>
              <Form.Control type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Form.Group>
            {error && <div className="text-danger small mb-2">{error}</div>}
            <Button type="submit" className="w-100" disabled={busy || !password || !confirm}>
              {busy ? <Spinner animation="border" size="sm" /> : 'Enregistrer et se connecter'}
            </Button>
            <p className="text-secondary small mt-2 mb-0">Vos autres sessions de connexion seront fermées.</p>
          </Form>
        )}
      </div>
    </AuthShell>
  );
}
