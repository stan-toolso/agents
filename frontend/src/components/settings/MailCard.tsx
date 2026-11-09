import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row } from 'react-bootstrap';
import { CLEAR_MAIL_SETTINGS, MAIL_SETTINGS, SEND_TEST_EMAIL, UPDATE_MAIL_SETTINGS, type MailSettings } from '../../graphql/misc';
import { useDialogs } from '../Dialogs';

const DEFAULT_FROM = 'Skipper <skipper@toolso.io>';

/**
 * Paramètres › Serveur : envoi des e-mails par l'API Brevo (« mot de passe oublié », invitations, canaux e-mail).
 * La variable d'environnement BREVO_API_KEY l'emporte sur ce réglage.
 */
export default function MailCard() {
  const { confirm, showError } = useDialogs();
  const { data } = useQuery<{ mailSettings: MailSettings }>(MAIL_SETTINGS, { fetchPolicy: 'cache-and-network' });
  const s = data?.mailSettings;
  const [form, setForm] = useState({ apiKey: '', from: DEFAULT_FROM });
  useEffect(() => {
    if (s && s.source !== 'env') setForm({ apiKey: '', from: s.from ?? DEFAULT_FROM });
  }, [s]);
  const update = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const writeCache = {
    update: (cache: { writeQuery: (o: object) => void }, res: { data?: Record<string, MailSettings> | null }) => {
      const value = res.data && Object.values(res.data)[0];
      if (value) cache.writeQuery({ query: MAIL_SETTINGS, data: { mailSettings: value } });
    },
  };
  const [save, { loading: saving, error: saveError }] = useMutation(UPDATE_MAIL_SETTINGS, writeCache as never);
  const [clear] = useMutation(CLEAR_MAIL_SETTINGS, writeCache as never);
  const [sendTest, { loading: testing }] = useMutation(SEND_TEST_EMAIL);
  const [sent, setSent] = useState(false);
  if (!s) return null;
  const fromEnv = s.source === 'env';

  return (
    <Card className="mb-4">
      <Card.Header>
        Envoi des e-mails (Brevo)
        {s.source === 'none' ? (
          <Badge bg="secondary" className="ms-2">
            non configuré
          </Badge>
        ) : (
          <Badge bg="success" className="ms-2">
            {fromEnv ? 'variable BREVO_API_KEY' : 'configuré'}
          </Badge>
        )}
      </Card.Header>
      <Card.Body className="small">
        <p className="text-secondary">
          Sert au lien « mot de passe oublié », aux liens de mot de passe envoyés par un administrateur, aux invitations des pages partagées et aux canaux
          e-mail des notifications. Clé d’API à créer dans Brevo (SMTP &amp; API › Clés API) ; l’expéditeur doit y être validé (Expéditeurs, domaines). La
          variable d’environnement <code>BREVO_API_KEY</code> (avec <code>MAIL_FROM</code>) l’emporte sur ce réglage.
        </p>
        {fromEnv ? (
          <div className="mb-2">
            Clé <code>…{s.apiKeyHint}</code>, expéditeur <code>{s.from}</code>.
          </div>
        ) : (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void save({ variables: { input: { from: form.from.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) } } })
                .then(() => update({ apiKey: '' }))
                .catch(() => undefined);
            }}
          >
            <Row className="g-2 mb-2">
              <Col md={6}>
                <Form.Control
                  aria-label="Clé d’API Brevo"
                  type="password"
                  placeholder={s.hasApiKey ? `Clé enregistrée …${s.apiKeyHint ?? ''} (inchangée)` : 'Clé d’API Brevo (xkeysib-…)'}
                  value={form.apiKey}
                  onChange={(e) => update({ apiKey: e.target.value })}
                  autoComplete="off"
                />
              </Col>
              <Col md={6}>
                <Form.Control aria-label="Expéditeur" placeholder={DEFAULT_FROM} value={form.from} onChange={(e) => update({ from: e.target.value })} />
              </Col>
            </Row>
            <div className="d-flex gap-2">
              <Button type="submit" size="sm" disabled={saving || (!s.hasApiKey && !form.apiKey.trim())}>
                Enregistrer
              </Button>
              {s.source === 'settings' && (
                <Button
                  size="sm"
                  variant="outline-danger"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Retirer la clé d’API Brevo',
                        message: 'Plus aucun e-mail ne partira (mot de passe oublié, invitations, canaux e-mail).',
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
