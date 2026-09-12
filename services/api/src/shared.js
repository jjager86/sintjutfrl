import mariadb from 'mariadb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const calendarIds = new Map((process.env.GRAPH_CALENDAR_IDS || '').split(',').map(entry => {
  const separator = entry.indexOf('=');
  return separator > 0 ? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] : ['', ''];
}).filter(([slug, id]) => slug && id));

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  db: {
    host: process.env.DB_HOST || 'mariadb',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'sintjut',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'sintjut',
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    timezone: 'Z',
    dateStrings: true
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    chatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    adminUserIds: new Set((process.env.TELEGRAM_ADMIN_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean))
  },
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    secretKey: process.env.TURNSTILE_SECRET_KEY || '',
    expectedHostname: process.env.TURNSTILE_EXPECTED_HOSTNAME || ''
  },
  graph: {
    enabled: process.env.GRAPH_SYNC_ENABLED === 'true',
    tenantId: process.env.GRAPH_TENANT_ID || '',
    clientId: process.env.GRAPH_CLIENT_ID || '',
    clientSecret: process.env.GRAPH_CLIENT_SECRET || '',
    mailbox: process.env.GRAPH_MAILBOX || '',
    webhookClientState: process.env.GRAPH_WEBHOOK_CLIENT_STATE || '',
    calendarIds
  }
};

export const pool = mariadb.createPool(config.db);
export const uuid = () => randomUUID();
export const token = () => randomBytes(18).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sqlDate = value => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
export const isoDate = value => value ? `${String(value).replace(' ', 'T')}Z` : null;

export async function migrate() {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  const statements = sql.split(/;\s*(?:\n|$)/).map(v => v.trim()).filter(Boolean);
  const connection = await pool.getConnection();
  try {
    for (const statement of statements) await connection.query(statement);
    for (const [slug, id] of config.graph.calendarIds) {
      await connection.query('UPDATE resources SET graph_calendar_id=? WHERE slug=?', [id, slug]);
    }
  } finally {
    connection.release();
  }
}

export async function telegram(method, body) {
  if (!config.telegram.token) return null;
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}

export async function verifyTurnstile(responseToken, remoteIp) {
  if (!config.turnstile.secretKey) return true;
  if (!responseToken) return false;
  const form = new URLSearchParams({ secret: config.turnstile.secretKey, response: responseToken });
  if (remoteIp) form.set('remoteip', remoteIp);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const result = await response.json();
  if (!response.ok || !result.success || result.action !== 'reserve') return false;
  return !config.turnstile.expectedHostname || result.hostname === config.turnstile.expectedHostname;
}

let graphToken = null;
let graphTokenExpires = 0;
export async function graphAccessToken() {
  if (graphToken && graphTokenExpires > Date.now() + 60000) return graphToken;
  const body = new URLSearchParams({
    client_id: config.graph.clientId,
    client_secret: config.graph.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const response = await fetch(`https://login.microsoftonline.com/${config.graph.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Graph token: ${result.error_description || response.status}`);
  graphToken = result.access_token;
  graphTokenExpires = Date.now() + (Number(result.expires_in || 3600) * 1000);
  return graphToken;
}

export async function graphRequest(path, options = {}) {
  const accessToken = await graphAccessToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(`Graph ${response.status}: ${result.error?.message || 'request failed'}`);
  return result;
}

export function graphCalendarPath(resource, suffix = '') {
  const mailbox = encodeURIComponent(config.graph.mailbox);
  const calendar = resource.graph_calendar_id ? `/calendars/${encodeURIComponent(resource.graph_calendar_id)}` : '';
  return `/users/${mailbox}${calendar}${suffix}`;
}
