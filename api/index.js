import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed by CORS')); } }));

let mongoClient;
let dbPromise;
async function db() {
  if (!dbPromise) {
    if (!process.env.MONGODB_URI) throw new Error('Server is missing MONGODB_URI.');
    mongoClient = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 });
    dbPromise = mongoClient.connect().then(c => c.db(process.env.MONGODB_DB || 'codesync'));
  }
  return dbPromise;
}
const users = async () => (await db()).collection('users');
const sessions = async () => (await db()).collection('sessions');
const githubAccounts = async () => (await db()).collection('github_accounts');

function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`Server is missing ${name}.`); return value; }
function encryptionKey() {
  const key = Buffer.from(requiredEnv('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 random bytes.');
  return key;
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt(value) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
}
function signSession(userId) { return jwt.sign({ sub: String(userId) }, requiredEnv('SESSION_JWT_SECRET'), { expiresIn: '7d', issuer: 'codesync' }); }
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Connect your GitHub account first.' });
  try { const payload = jwt.verify(token, requiredEnv('SESSION_JWT_SECRET'), { issuer: 'codesync' }); req.userId = payload.sub; return next(); }
  catch { return res.status(401).json({ error: 'Your CodeSync session expired. Connect GitHub again.' }); }
}
function allowedRedirect(uri) {
  const allow = (process.env.ALLOWED_REDIRECT_URIS || '').split(',').map(x => x.trim()).filter(Boolean);
  return typeof uri === 'string' && allow.includes(uri);
}
async function githubFetch(token, url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || `GitHub API returned ${response.status}.`);
    err.status = response.status;
    throw err;
  }
  return data;
}
async function getAccount(userId) {
  const account = await (await githubAccounts()).findOne({ userId: new ObjectId(userId) });
  if (!account) { const e = new Error('No GitHub account is connected. Connect GitHub in the CodeSync popup.'); e.status = 401; throw e; }
  let accessToken = decrypt(account.accessTokenEnc);
  const expiry = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  if (expiry && expiry < Date.now() + 60_000) {
    if (!account.refreshTokenEnc) { const e = new Error('GitHub authorization expired. Connect GitHub again.'); e.status = 401; throw e; }
    const refreshed = await refreshGithubToken(decrypt(account.refreshTokenEnc));
    accessToken = refreshed.access_token;
    await (await githubAccounts()).updateOne({ _id: account._id }, { $set: {
      accessTokenEnc: encrypt(refreshed.access_token),
      refreshTokenEnc: refreshed.refresh_token ? encrypt(refreshed.refresh_token) : account.refreshTokenEnc,
      expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
      refreshTokenExpiresAt: refreshed.refresh_token_expires_in ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1000) : account.refreshTokenExpiresAt,
      updatedAt: new Date()
    } });
  }
  return { account, accessToken };
}
async function refreshGithubToken(refreshToken) {
  const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: requiredEnv('GITHUB_APP_CLIENT_ID'), client_secret: requiredEnv('GITHUB_APP_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: refreshToken }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) { const e = new Error(data.error_description || data.error || 'Could not refresh GitHub authorization. Connect GitHub again.'); e.status = 401; throw e; }
  return data;
}
function safeSlug(value) {
  const slug = String(value || 'leetcode-solution').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 150);
  return slug || 'leetcode-solution';
}
function extensionFor(language) {
  const map = { java: 'java', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', python3: 'py', cpp: 'cpp', 'c++': 'cpp', c: 'c', csharp: 'cs', 'c#': 'cs', go: 'go', rust: 'rs', kotlin: 'kt', ruby: 'rb', swift: 'swift', php: 'php' };
  return map[String(language || '').toLowerCase()] || 'txt';
}
function encodeBase64Utf8(text) { return Buffer.from(text, 'utf8').toString('base64'); }

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'codesync-api' }));

// The extension validates OAuth state locally and sends the authorization code here.
// The client secret and GitHub access/refresh tokens never leave this backend.
app.post('/api/auth/exchange', async (req, res) => {
  try {
    const { code, redirectUri } = req.body || {};
    if (!code || !allowedRedirect(redirectUri)) return res.status(400).json({ error: 'Missing code or unapproved OAuth redirect URI.' });
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: requiredEnv('GITHUB_APP_CLIENT_ID'), client_secret: requiredEnv('GITHUB_APP_CLIENT_SECRET'), code, redirect_uri: redirectUri }) });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) return res.status(400).json({ error: tokenData.error_description || tokenData.error || 'GitHub token exchange failed.' });
    const profile = await githubFetch(tokenData.access_token, 'https://api.github.com/user');
    const now = new Date();
    const usersCol = await users();
    let user = await usersCol.findOne({ githubId: profile.id });
    if (!user) {
      const insert = await usersCol.insertOne({ githubId: profile.id, login: profile.login, name: profile.name || profile.login, createdAt: now, updatedAt: now });
      user = { _id: insert.insertedId, githubId: profile.id };
    } else {
      await usersCol.updateOne({ _id: user._id }, { $set: { login: profile.login, name: profile.name || profile.login, updatedAt: now } });
    }
    const tokenCol = await githubAccounts();
    await tokenCol.updateOne({ userId: user._id }, { $set: {
      userId: user._id, githubId: profile.id, login: profile.login,
      accessTokenEnc: encrypt(tokenData.access_token),
      refreshTokenEnc: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
      expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
      refreshTokenExpiresAt: tokenData.refresh_token_expires_in ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000) : null,
      scopes: tokenData.scope || '', updatedAt: now
    }, $setOnInsert: { createdAt: now } }, { upsert: true });
    const sessionToken = signSession(user._id);
    return res.json({ token: sessionToken, user: { login: profile.login, name: profile.name || profile.login, avatarUrl: profile.avatar_url } });
  } catch (error) { console.error('OAuth exchange failed:', error.message); return res.status(500).json({ error: error.message || 'GitHub sign-in failed.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await (await users()).findOne({ _id: new ObjectId(req.userId) }, { projection: { githubId: 1, login: 1, name: 1 } });
    if (!user) return res.status(401).json({ error: 'CodeSync user session is invalid.' });
    return res.json({ user: { login: user.login, name: user.name } });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    // Delete the stored GitHub credentials for this CodeSync user. They can reconnect later.
    await (await githubAccounts()).deleteOne({ userId: new ObjectId(req.userId) });
    return res.json({ success: true });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.get('/api/github/repos', auth, async (req, res) => {
  try {
    const { accessToken } = await getAccount(req.userId);
    const repos = await githubFetch(accessToken, 'https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member');
    return res.json({ repos: repos.map(r => ({ id: r.id, fullName: r.full_name, owner: r.owner.login, name: r.name, defaultBranch: r.default_branch, private: r.private, htmlUrl: r.html_url, permissions: r.permissions })) });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.get('/api/github/repos/:owner/:repo/branches', auth, async (req, res) => {
  try {
    const { accessToken } = await getAccount(req.userId);
    const owner = encodeURIComponent(req.params.owner); const repo = encodeURIComponent(req.params.repo);
    const branches = await githubFetch(accessToken, `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`);
    return res.json({ branches: branches.map(b => ({ name: b.name, protected: b.protected })) });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/github/sync', auth, async (req, res) => {
  try {
    const { owner, repo, branch, solution } = req.body || {};
    if (!owner || !repo || !branch) return res.status(400).json({ error: 'Select a repository and branch in the CodeSync popup.' });
    if (!solution || typeof solution.code !== 'string' || !solution.code.trim()) return res.status(400).json({ error: 'No solution code provided.' });
    if (solution.code.length > 500_000) return res.status(413).json({ error: 'Solution is too large to sync.' });
    const { accessToken } = await getAccount(req.userId);
    const ownerEnc = encodeURIComponent(owner); const repoEnc = encodeURIComponent(repo); const branchEnc = encodeURIComponent(branch);
    await githubFetch(accessToken, `https://api.github.com/repos/${ownerEnc}/${repoEnc}/branches/${branchEnc}`);
    const slug = safeSlug(solution.slug);
    const path = `${slug}/${slug}.${extensionFor(solution.language)}`;
    const pathEncoded = path.split('/').map(encodeURIComponent).join('/');
    const fileUrl = `https://api.github.com/repos/${ownerEnc}/${repoEnc}/contents/${pathEncoded}`;
    let existingSha;
    try { const existing = await githubFetch(accessToken, `${fileUrl}?ref=${branchEnc}`); existingSha = existing.sha; }
    catch (error) { if (error.status !== 404) throw new Error(`Could not check existing file: ${error.message}`); }
    const body = { message: `${existingSha ? 'Update' : 'Add'} LeetCode solution: ${slug}`, content: encodeBase64Utf8(solution.code), branch, ...(existingSha ? { sha: existingSha } : {}) };
    let result;
    try { result = await githubFetch(accessToken, fileUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (error) {
      // A simultaneous push can invalidate the SHA; re-fetch once and retry once.
      if (error.status !== 409 && error.status !== 422) throw error;
      const current = await githubFetch(accessToken, `${fileUrl}?ref=${branchEnc}`).catch(e => e.status === 404 ? null : Promise.reject(e));
      const retryBody = { ...body, ...(current?.sha ? { sha: current.sha } : {}) };
      if (!current?.sha) delete retryBody.sha;
      result = await githubFetch(accessToken, fileUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(retryBody) });
    }
    return res.json({ success: true, path, commitUrl: result.commit?.html_url || '', fileUrl: result.content?.html_url || `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${pathEncoded}` });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message || 'GitHub sync failed.' }); }
});

app.use((error, _req, res, _next) => { console.error('Unhandled API error:', error.message); res.status(500).json({ error: 'Unexpected server error.' }); });
export default app;
