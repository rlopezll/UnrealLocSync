const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');

const AUTH_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const AUTH_FILE = path.join(__dirname, '.chatgpt-auth.json');

function readStore(filename = AUTH_FILE) {
  if (!fs.existsSync(filename)) return { hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: [], activeClientId: null };
  const store = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!store.hostId || !Array.isArray(store.accounts)) throw new Error('El archivo de sesión de ChatGPT no es válido');
  return store;
}

function saveStore(store, filename = AUTH_FILE) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function activeAccount(store) {
  return store.accounts.find(account => account.clientId === store.activeClientId);
}

function makeAuthorizationUrl({ clientId, hostId, redirectUri, state, nonce, verifier, idToken, email }) {
  const url = new URL(AUTH_URL);
  const fields = {
    client_id: clientId || 'dynamic_agent_client',
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
  if (!clientId) fields.agent_name_hint = 'UnrealLocSync';
  if (idToken) fields.id_token_hint = idToken;
  if (email) fields.login_hint = email;
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  return url;
}

function openBrowser(url) {
  const target = url.toString();
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error('No se pudo abrir el navegador. Abre la URL de autorización manualmente.'));
  child.unref();
}

function waitForCallback(server, expectedState, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('Caducó la espera de inicio de sesión con ChatGPT')); }, timeoutMs);
    server.on('request', (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== expectedState) { response.writeHead(400).end('Estado OAuth inválido'); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Autorización recibida. Puedes cerrar esta pestaña y volver a UnrealLocSync.');
      clearTimeout(timer);
      server.close();
      if (url.searchParams.has('error')) reject(new Error(`ChatGPT rechazó la autorización: ${url.searchParams.get('error')}`));
      else resolve(url.searchParams);
    });
    server.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body.error?.code || body.error || body.detail || body.error_description || response.statusText;
    throw new Error(`${new URL(url).pathname}: HTTP ${response.status} (${String(reason).slice(0, 200)})`);
  }
  return body;
}

async function tokenRequest(fields) {
  return jsonRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

async function verifyIdToken(token, { clientId, nonce, subject }) {
  const parts = token?.split('.');
  if (parts?.length !== 3) throw new Error('ChatGPT no devolvió un ID token válido');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Algoritmo de firma del ID token no admitido');
  const discovery = await jsonRequest(DISCOVERY_URL);
  if (discovery.issuer !== 'https://auth.openai.com' || !discovery.jwks_uri?.startsWith('https://auth.openai.com/')) {
    throw new Error('Configuración OIDC de ChatGPT inesperada');
  }
  const jwks = await jsonRequest(discovery.jwks_uri);
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig'));
  if (!jwk) throw new Error('No se encontró la clave de firma del ID token');
  const signatureValid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Math.floor(Date.now() / 1000);
  if (!signatureValid || payload.iss !== discovery.issuer || !audiences.includes(clientId) ||
      (audiences.length > 1 && payload.azp !== clientId) || !payload.sub ||
      !Number.isFinite(payload.exp) || payload.exp <= now ||
      !Number.isFinite(payload.iat) || payload.iat > now + 60 || payload.nonce !== nonce ||
      (subject && payload.sub !== subject)) {
    throw new Error('La identidad devuelta por ChatGPT no pasó la validación');
  }
  return payload;
}

async function login({ newAccount = false, browser = openBrowser, filename = AUTH_FILE } = {}) {
  const store = readStore(filename);
  if (!fs.existsSync(filename)) saveStore(store, filename);
  const previous = newAccount ? null : activeAccount(store);
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const url = makeAuthorizationUrl({ clientId: previous?.clientId, hostId: store.hostId,
    redirectUri, state, nonce, verifier, idToken: previous?.idToken, email: previous?.email });
  const callback = waitForCallback(server, state);
  console.log('Continúa con ChatGPT en el navegador para autorizar UnrealLocSync.');
  browser(url);
  const params = await callback;
  const issuedClientId = params.get('client_id') || previous?.clientId;
  if (!issuedClientId || (previous && issuedClientId !== previous.clientId)) throw new Error('ChatGPT devolvió un ID de cliente inesperado');
  if (!params.get('code')) throw new Error('ChatGPT no devolvió un código de autorización');
  const tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: issuedClientId,
    code: params.get('code'), code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
  const identity = await verifyIdToken(tokens.id_token, { clientId: issuedClientId, nonce, subject: previous?.subject });
  const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
  if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('No se concedió permiso para usar el plan ChatGPT');
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('ChatGPT no devolvió los tokens necesarios');
  const account = { clientId: issuedClientId, subject: identity.sub, email: identity.email || '',
    idToken: tokens.id_token, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    scopes, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
  const index = store.accounts.findIndex(item => item.clientId === issuedClientId);
  if (index >= 0) store.accounts[index] = account;
  else store.accounts.push(account);
  store.activeClientId = issuedClientId;
  saveStore(store, filename);
  console.log(`Sesión de ChatGPT guardada para ${account.email || account.subject}.`);
  return account;
}

async function getAccessToken(filename = AUTH_FILE) {
  const store = readStore(filename);
  const account = activeAccount(store);
  if (!account?.refreshToken) throw new Error('Inicia sesión primero con node do_trans.js --login');
  if (account.expiresAt > Date.now() + 120000 && account.accessToken) return account.accessToken;
  const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: account.clientId,
    refresh_token: account.refreshToken, resource: RESOURCE });
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('No se pudo renovar la sesión de ChatGPT; ejecuta --login');
  const scopes = String(tokens.scope || account.scopes.join(' ')).split(/\s+/).filter(Boolean);
  if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('La sesión ya no permite usar el plan ChatGPT; ejecuta --login');
  account.accessToken = tokens.access_token;
  account.refreshToken = tokens.refresh_token;
  account.scopes = scopes;
  account.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  saveStore(store, filename);
  return account.accessToken;
}

async function listModels(filename = AUTH_FILE) {
  const accessToken = await getAccessToken(filename);
  const result = await jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return (result.models || []).filter(model => model.visibility === 'list');
}

module.exports = { readStore, saveStore, activeAccount, makeAuthorizationUrl, verifyIdToken,
  login, getAccessToken, listModels, AUTH_FILE };
