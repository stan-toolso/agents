const $ = (id) => document.getElementById(id);
const LABELS = { connected: 'connecté', connecting: 'connexion…', unpaired: 'non relié', revoked: 'retiré', error: 'erreur', idle: '…' };

const send = (msg) => chrome.runtime.sendMessage(msg);

function showError(err) {
  $('error').hidden = !err;
  $('error').textContent = err || '';
}

async function refresh() {
  const info = await send({ type: 'getState' });
  if (!info) return;
  render(info);
}

function render({ state, serverUrl, activeTab }) {
  $('status').textContent = LABELS[state.status] ?? state.status;
  $('status').className = `pill ${state.status}`;
  $('message').textContent = state.status === 'connected' ? `Relié à ${serverUrl}${state.name ? ` (${state.name})` : ''}` : state.message || '';
  const paired = state.status === 'connected' || state.status === 'connecting';
  $('pair').hidden = paired;
  $('connected').hidden = !paired;
  if (!$('server').value) $('server').value = serverUrl || '';
  const usable = activeTab && /^https?:/.test(activeTab.url || '');
  $('tabBox').hidden = !usable;
  if (usable) {
    $('tabTitle').textContent = activeTab.title || activeTab.url;
    $('tabTitle').title = activeTab.url;
    $('shareBtn').hidden = activeTab.shared;
    $('unshareBtn').hidden = !activeTab.shared;
    $('shareBtn').onclick = () => act({ type: 'share', tabId: activeTab.id });
    $('unshareBtn').onclick = () => act({ type: 'unshare', tabId: activeTab.id });
  }
}

async function act(msg) {
  showError('');
  const r = await send(msg);
  if (r && r.ok === false) showError(r.error || 'Échec');
  await refresh();
}

$('pairBtn').onclick = async () => {
  await act({ type: 'pair', serverUrl: $('server').value });
  window.close();
};
$('tokenBtn').onclick = () => act({ type: 'setToken', serverUrl: $('server').value, token: $('token').value });
$('reconnectBtn').onclick = () => act({ type: 'reconnect' });
$('forgetBtn').onclick = () => act({ type: 'forget' });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state') void refresh();
});
void refresh();
