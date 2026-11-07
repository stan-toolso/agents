import { useMutation, useQuery } from '@apollo/client';
import { Button, Card } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { SETTINGS, UPDATE_ONBOARDING, type AppSettings } from '../graphql/settings';

/**
 * Rappel de l'assistant de premiers pas sur le tableau de bord, tant qu'il n'est ni terminé ni écarté : combien d'étapes
 * sont faites (compte Claude à soi ou crédits Skipper, compte GitHub ou GitLab) et un lien pour le reprendre.
 */
export default function OnboardingBanner() {
  const { data } = useQuery<{ settings: AppSettings }>(SETTINGS, { fetchPolicy: 'cache-first' });
  const [update, { loading }] = useMutation(UPDATE_ONBOARDING);
  const s = data?.settings;
  if (!s || s.onboarding.completedAt || s.onboarding.dismissedAt) return null;
  const claude = (s.claudeAuth.mode === 'oauth' ? s.claudeAuth.hasOauthToken : s.claudeAuth.hasApiKey) || s.claudeAuth.usesCellAccount;
  const git = s.github.connected || s.gitlab.connected;
  return (
    <Card className="mb-3">
      <Card.Body className="d-flex align-items-center gap-3 flex-wrap py-2">
        <i className="bi bi-compass fs-4 text-secondary" />
        <div style={{ flex: '1 1 320px' }}>
          <div className="fw-semibold">Premiers pas</div>
          <div className="small text-secondary">
            Branchez votre compte Claude{claude ? ' (fait)' : ''}, vos dépôts GitHub ou GitLab{git ? ' (fait)' : ''} et vos outils dans le coffre, avec à chaque fois ce qu’ils permettent.
          </div>
        </div>
        <Button as={Link as any} to="/welcome" size="sm">
          Reprendre
        </Button>
        <Button variant="link" size="sm" className="text-secondary p-0" title="Ne plus afficher (l’assistant reste dans le menu du compte)" disabled={loading} onClick={() => void update({ variables: { dismissed: true } }).catch(() => undefined)}>
          <i className="bi bi-x-lg" />
        </Button>
      </Card.Body>
    </Card>
  );
}
