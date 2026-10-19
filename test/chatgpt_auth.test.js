const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeAuthorizationUrl, verifyIdToken, saveStore, getAccessToken, login } = require('../chatgpt_auth');

test('la autorización usa PKCE, loopback y permiso de plan ChatGPT', () => {
  const url = makeAuthorizationUrl({ hostId: 'urn:uuid:test', redirectUri: 'http://127.0.0.1:54321/auth/callback',
    state: 'state-test', nonce: 'nonce-test', verifier: 'verifier-test' });
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:test');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:54321/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /chatgpt\.tokens\.use\.direct/);
  assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1');
});

test('valida firma, audiencia, emisor, nonce e identidad del ID token', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
  const oldFetch = global.fetch;
  global.fetch = async url => ({ ok: true, json: async () => url.includes('openid-configuration')
    ? { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/test/jwks' }
    : { keys: [jwk] } });
  try {
    const makeToken = nonce => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'client-1',
        sub: 'account-1', nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
      const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      return `${header}.${payload}.${signature}`;
    };
    assert.equal((await verifyIdToken(makeToken('good'), { clientId: 'client-1', nonce: 'good' })).sub, 'account-1');
    await assert.rejects(verifyIdToken(makeToken('wrong'), { clientId: 'client-1', nonce: 'good' }), /validación/);
    await assert.rejects(verifyIdToken(makeToken('good'), { clientId: 'client-2', nonce: 'good' }), /validación/);
  } finally {
    global.fetch = oldFetch;
  }
});

test('renueva y guarda juntos el acceso y el refresh token', async () => {
  const filename = path.join(__dirname, `.auth-test-${crypto.randomUUID()}.json`);
  const oldFetch = global.fetch;
  try {
    saveStore({ hostId: 'urn:uuid:test', activeClientId: 'client-1', accounts: [{ clientId: 'client-1',
      accessToken: 'expired', refreshToken: 'refresh-old', expiresAt: 0,
      scopes: ['chatgpt.tokens.use.direct'] }] }, filename);
    global.fetch = async (url, options) => {
      assert.equal(options.body.get('client_id'), 'client-1');
      assert.equal(options.body.get('refresh_token'), 'refresh-old');
      return { ok: true, json: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new',
        expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }) };
    };
    assert.equal(await getAccessToken(filename), 'access-new');
    const stored = JSON.parse(fs.readFileSync(filename, 'utf8')).accounts[0];
    assert.equal(stored.accessToken, 'access-new');
    assert.equal(stored.refreshToken, 'refresh-new');
  } finally {
    global.fetch = oldFetch;
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
});

test('el inicio de sesión registra el cliente y guarda solo tokens validados', async () => {
  const filename = path.join(__dirname, `.auth-test-${crypto.randomUUID()}.json`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'login-key', use: 'sig' };
  const oldFetch = global.fetch;
  let nonce;
  try {
    global.fetch = async (url, options) => {
      if (url.includes('openid-configuration')) return { ok: true, json: async () => ({
        issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/test/jwks' }) };
      if (url.includes('/jwks')) return { ok: true, json: async () => ({ keys: [jwk] }) };
      assert.equal(options.body.get('client_id'), 'oaiapp_test');
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'login-key' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test',
        sub: 'user-1', email: 'user@example.com', nonce, iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
      const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      return { ok: true, json: async () => ({ id_token: `${header}.${payload}.${signature}`,
        access_token: 'access-test', refresh_token: 'refresh-test', expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }) };
    };
    const account = await login({ filename, browser: url => {
      assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
      nonce = url.searchParams.get('nonce');
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'auth-code');
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('client_id', 'oaiapp_test');
      http.get(callback, response => response.resume()).on('error', error => { throw error; });
    } });
    assert.equal(account.clientId, 'oaiapp_test');
    assert.equal(account.email, 'user@example.com');
    const store = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(store.activeClientId, 'oaiapp_test');
    assert.match(store.hostId, /^urn:uuid:/);
  } finally {
    global.fetch = oldFetch;
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
});
