// RemoteLock cloud API client (OAuth2 authorization-code flow).
//
// Docs: https://developer.remotelock.com/  — the RemoteLock Connect API.
//   OAuth authorize : https://connect.remotelock.com/oauth/authorize
//   OAuth token     : https://connect.remotelock.com/oauth/token
//   API base        : https://api.remotelock.com
//   Version header  : Accept: application/vnd.remotelock+json; version=1
//
// We store the host's client id/secret + tokens on the LockProvider row and
// refresh the access token on demand. Field names returned by the API can vary
// by account, so callers should keep the raw attributes and map defensively.
const prisma = require('../lib/prisma');

const AUTH_BASE = process.env.REMOTELOCK_AUTH_BASE || 'https://connect.remotelock.com';
const API_BASE = process.env.REMOTELOCK_API_BASE || 'https://api.remotelock.com';
const ACCEPT = 'application/vnd.remotelock+json; version=1';

// The OAuth redirect URI RemoteLock must be told about when registering the app.
// Kept public + unauthenticated; identity is carried in a signed `state`.
function redirectUri(req) {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/smartlocks/callback`;
}

function authorizeUrl({ clientId, redirect, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    state,
  });
  return `${AUTH_BASE}/oauth/authorize?${q.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`RemoteLock token ${res.status}: ${json.error_description || json.error || text}`);
  return json; // { access_token, refresh_token, expires_in, ... }
}

function exchangeCode({ clientId, clientSecret, code, redirect }) {
  return tokenRequest({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirect });
}

function refreshTokens({ clientId, clientSecret, refreshToken }) {
  return tokenRequest({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
}

// Persist a fresh token bundle onto the provider row.
async function storeTokens(providerId, tok) {
  const expiry = tok.expires_in ? new Date(Date.now() + (Number(tok.expires_in) - 60) * 1000) : null;
  return prisma.lockProvider.update({
    where: { id: providerId },
    data: {
      accessToken: tok.access_token || undefined,
      refreshToken: tok.refresh_token || undefined,
      tokenExpiry: expiry,
      connectedAt: new Date(),
      lastError: null,
    },
  });
}

// Return a valid access token for this provider, refreshing if expired.
async function validAccessToken(provider) {
  if (!provider || !provider.accessToken) throw new Error('not_connected');
  const fresh = !provider.tokenExpiry || new Date(provider.tokenExpiry).getTime() > Date.now();
  if (fresh) return provider.accessToken;
  if (!provider.refreshToken) throw new Error('token_expired_no_refresh');
  const tok = await refreshTokens({ clientId: provider.clientId, clientSecret: provider.clientSecret, refreshToken: provider.refreshToken });
  const updated = await storeTokens(provider.id, tok);
  return updated.accessToken;
}

async function apiGet(token, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`RemoteLock ${res.status} on ${path}: ${json.message || text}`);
  return json;
}

// List every device on the account (follows pagination). RemoteLock returns
// JSON:API-style { data: [{ id, type, attributes }], links: { next } }.
async function listDevices(token) {
  const out = [];
  let path = '/devices?per_page=100';
  for (let guard = 0; path && guard < 20; guard += 1) {
    const page = await apiGet(token, path);
    const data = Array.isArray(page.data) ? page.data : (Array.isArray(page.devices) ? page.devices : []);
    out.push(...data);
    const next = page.links && page.links.next;
    path = next ? next.replace(API_BASE, '') : null;
  }
  return out;
}

// Normalise one device into the shape the dashboard cares about, keeping the
// full raw attributes too (so the UI can show "all the details that come back").
function normaliseDevice(d) {
  const a = d.attributes || d || {};
  const battery = a.power_level ?? a.battery_level ?? a.battery ?? null;
  return {
    id: d.id || a.id,
    name: a.name || a.device_name || '(unnamed)',
    type: d.type || a.type || a.device_type || null,
    battery: battery != null ? Math.round(Number(battery)) : null,
    online: a.connection_status ? a.connection_status === 'online' : (a.online ?? null),
    status: a.connection_status || a.state || null,
    raw: a,
  };
}

module.exports = {
  redirectUri, authorizeUrl, exchangeCode, refreshTokens, storeTokens,
  validAccessToken, apiGet, listDevices, normaliseDevice, API_BASE, AUTH_BASE,
};
