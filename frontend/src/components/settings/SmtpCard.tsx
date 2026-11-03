import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row } from 'react-bootstrap';
import { CLEAR_SMTP_SETTINGS, SEND_TEST_EMAIL, SMTP_SETTINGS, UPDATE_SMTP_SETTINGS, type SmtpSettings } from '../../graphql/misc';
import { useDialogs } from '../Dialogs';

/** Paramètres › Serveur : serveur SMTP des notifications par e-mail (ou variable SMTP_URL, qui l'emporte). */
export default function SmtpCard() {
  const { confirm, showError } = useDialogs();
  const { data } = useQuery<{ smtpSettings: SmtpSettings }>(SMTP_SETTINGS, {
    fetchPolicy: 'cache-and-network',
  });
  const s = data?.smtpSettings;
  const [form, setForm] = useState({
    host: '',
    port: '587',
    secure: false,
    user: '',
    password: '',
    from: '',
  });
  useEffect(() => {
    if (s && s.source === 'settings')
      setForm({
        host: s.host ?? '',
        port: String(s.port ?? 587),
        secure: s.secure,
        user: s.user ?? '',
        password: '',
        from: s.from ?? '',
      });
  }, [s]);
  const update = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const writeCache = {
    update: (cache: { writeQuery: (o: object) => void }, res: { data?: Record<string, SmtpSettings> | null }) => {
      const value = res.data && Object.values(res.data)[0];
      if (value)
        cache.writeQuery({
          query: SMTP_SETTINGS,
          data: { smtpSettings: value },
        });
    },
  };
  const [save, { loading: saving, error: saveError }] = useMutation(UPDATE_SMTP_SETTINGS, writeCache as never);
  const [clear] = useMutation(CLEAR_SMTP_SETTINGS, writeCache as never);
  const [sendTest, { loading: testing }] = useMutation(SEND_TEST_EMAIL);
  const [sent, setSent] = useState(false);
  if (!s) return null;
  const fromEnv = s.source === 'env';

  return (
    <Card className="mb-4">
      <Card.Header>
        Serveur SMTP (notifications par e-mail)
        {s.source === 'none' ? (
          <Badge bg="secondary" className="ms-2">
            non configuré
          </Badge>
        ) : (
          <Badge bg="success" className="ms-2">
            {fromEnv ? 'variable SMTP_URL' : 'configuré'}
          </Badge>
        )}
      </Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Permet à chacun d’ajouter un canal e-mail dans Paramètres › Notifications, et aux projets d’envoyer leurs notifications par e-mail. La variable
          d’environnement <code>SMTP_URL</code> (ex. <code>smtps://utilisateur:mot-de-passe@smtp.exemple.fr:465</code>, avec <code>SMTP_FROM</code>) l’emporte
          sur ce réglage.
        </p>
        {fromEnv ? (
          <div className="mb-2">
            Serveur{' '}
            <code>
              {s.host}
              {s.port ? `:${s.port}` : ''}
            </code>
            , expéditeur <code>{s.from}</code>.
          </div>
        ) : (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void save({
                variables: {
                  input: {
                    host: form.host.trim(),
                    port: Number(form.port),
                    secure: form.secure,
                    user: form.user.trim() || null,
                    ...(form.password ? { password: form.password } : {}),
                    from: form.from.trim(),
                  },
                },
              })
                .then(() => update({ password: '' }))
                .catch(() => undefined);
            }}
          >
            <Row className="g-2 mb-2">
              <Col md={6}>
                <Form.Control aria-label="Serveur" placeholder="smtp.exemple.fr" value={form.host} onChange={(e) => update({ host: e.target.value })} />
              </Col>
              <Col xs={4} md={2}>
                <Form.Control aria-label="Port" type="number" value={form.port} onChange={(e) => update({ port: e.target.value })} />
              </Col>
              <Col xs={8} md={4} className="d-flex align-items-center">
                <Form.Check
                  type="switch"
                  id="smtp-secure"
                  label="TLS dès la connexion (465)"
                  checked={form.secure}
                  onChange={(e) =>
                    update({
                      secure: e.target.checked,
                      port: e.target.checked && form.port === '587' ? '465' : form.port,
                    })
                  }
                />
              </Col>
              <Col md={4}>
                <Form.Control
                  aria-label="Utilisateur"
                  placeholder="Utilisateur (optionnel)"
                  value={form.user}
                  onChange={(e) => update({ user: e.target.value })}
                  autoComplete="off"
                />
              </Col>
              <Col md={4}>
                <Form.Control
                  aria-label="Mot de passe"
                  type="password"
                  placeholder={s.hasPassword ? 'Mot de passe enregistré (inchangé)' : 'Mot de passe'}
                  value={form.password}
                  onChange={(e) => update({ password: e.target.value })}
                  autoComplete="new-password"
                />
              </Col>
              <Col md={4}>
                <Form.Control
                  aria-label="Expéditeur"
                  placeholder="Skipper <skipper@exemple.fr>"
                  value={form.from}
                  onChange={(e) => update({ from: e.target.value })}
                />
              </Col>
            </Row>
            <div className="d-flex gap-2">
              <Button type="submit" size="sm" disabled={saving || !form.host.trim() || !form.from.trim()}>
                Enregistrer
              </Button>
              {s.source === 'settings' && (
                <Button
                  size="sm"
                  variant="outline-danger"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Retirer le serveur SMTP',
                        message: 'Les canaux e-mail ne recevront plus rien.',
                        confirmLabel: 'Retirer',
                        danger: true,
                      })
                    )
                      void clear().catch(showError);
                  }}
                >
                  Retirer
                </Button>
              )}
            </div>
            {saveError && (
              <Alert variant="danger" className="mt-2 mb-0 py-2">
                {saveError.message}
              </Alert>
            )}
          </Form>
        )}
        {s.source !== 'none' && (
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={testing}
              onClick={() => {
                setSent(false);
                void sendTest()
                  .then(() => setSent(true))
                  .catch(showError);
              }}
            >
              M’envoyer un e-mail de test
            </Button>
            {sent && (
              <Badge bg="success" className="ms-2">
                envoyé
              </Badge>
            )}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
