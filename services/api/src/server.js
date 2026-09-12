import http from 'node:http';
import { config, isoDate, migrate, pool, sha256, sqlDate, telegram, token, uuid, verifyTurnstile } from './shared.js';

const rate = new Map();
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const text = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };
const clean = (value, max = 255) => String(value || '').trim().slice(0, max);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('payload_too_large'); }
  return raw ? JSON.parse(raw) : {};
}

function limited(req) {
  const ip = clean(req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress, 80);
  const now = Date.now(); const current = rate.get(ip) || [];
  const recent = current.filter(t => t > now - 3600000); recent.push(now); rate.set(ip, recent);
  if (rate.size > 10000) rate.delete(rate.keys().next().value);
  return recent.length > 10;
}

async function resources(res) {
  const rows = await pool.query('SELECT id, slug, name, location, capacity FROM resources WHERE is_active = 1 ORDER BY name');
  json(res, 200, { resources: rows });
}

async function agenda(url, res) {
  const from = url.searchParams.get('from') || new Date().toISOString();
  const untilDefault = new Date(Date.now() + 120 * 86400000).toISOString();
  const to = url.searchParams.get('to') || untilDefault;
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return json(res, 400, { error: 'Ongeldige periode.' });
  const resourceId = clean(url.searchParams.get('resource_id'), 36);
  const params = [sqlDate(from), sqlDate(to)];
  let resourceSql = '';
  if (resourceId) { resourceSql = ' AND e.resource_id = ?'; params.push(resourceId); }
  const rows = await pool.query(`SELECT e.id, e.title, e.public_description, e.location, e.starts_at, e.ends_at, e.is_private,
    r.id resource_id, r.name resource_name, r.location resource_location
    FROM calendar_events e JOIN resources r ON r.id=e.resource_id
    WHERE e.is_cancelled=0 AND e.starts_at < ? AND e.ends_at > ?${resourceSql} ORDER BY e.starts_at`, [params[1], params[0], ...params.slice(2)]);
  json(res, 200, { events: rows.map(row => ({ ...row, title: row.is_private ? 'Bezet' : row.title, public_description: row.is_private ? null : row.public_description, starts_at: isoDate(row.starts_at), ends_at: isoDate(row.ends_at) })) });
}

async function availability(url, res) {
  const start = url.searchParams.get('start'); const end = url.searchParams.get('end');
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) return json(res, 400, { error: 'Ongeldige periode.' });
  const rows = await pool.query(`SELECT r.id, r.slug, r.name, r.location, r.capacity,
    NOT EXISTS(SELECT 1 FROM calendar_events e WHERE e.resource_id=r.id AND e.is_cancelled=0 AND e.starts_at < ? AND e.ends_at > ?) available
    FROM resources r WHERE r.is_active=1 ORDER BY r.name`, [sqlDate(end), sqlDate(start)]);
  json(res, 200, { resources: rows.map(row => ({ ...row, available: Boolean(row.available) })) });
}

async function createReservation(req, res) {
  if (limited(req)) return json(res, 429, { error: 'Te veel aanvragen. Probeer het later opnieuw.' });
  const data = await body(req);
  const remoteIp = clean(req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress, 80);
  if (!(await verifyTurnstile(clean(data.turnstile_token, 4096), remoteIp))) return json(res, 422, { error: 'De botcontrole is niet gelukt. Probeer het opnieuw.' });
  const resourceId = clean(data.resource_id, 36); const title = clean(data.title, 180);
  const organizerName = clean(data.organizer_name, 160); const organizerEmail = clean(data.organizer_email, 254).toLowerCase();
  const starts = new Date(data.starts_at); const ends = new Date(data.ends_at);
  if (!resourceId || !title || !organizerName || !validEmail(organizerEmail) || !Number.isFinite(starts.valueOf()) || !Number.isFinite(ends.valueOf()) || ends <= starts) return json(res, 422, { error: 'Controleer de verplichte velden en tijden.' });
  if (starts < new Date(Date.now() - 300000)) return json(res, 422, { error: 'Een reservering moet in de toekomst liggen.' });
  if (ends - starts > 3 * 86400000 || starts > new Date(Date.now() + 2 * 365 * 86400000)) return json(res, 422, { error: 'Deze periode kan niet worden aangevraagd.' });
  const resource = (await pool.query('SELECT id FROM resources WHERE id=? AND is_active=1', [resourceId]))[0];
  if (!resource) return json(res, 404, { error: 'Ruimte niet gevonden.' });
  const id = uuid(); const reference = `SJ-${new Date().getUTCFullYear()}-${id.slice(0, 6).toUpperCase()}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`INSERT INTO reservations
      (id,reference,resource_id,title,description,public_description,organizer_name,organizer_email,organizer_phone,attendee_count,starts_at,ends_at,graph_transaction_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, reference, resourceId, title, clean(data.description, 4000) || null, data.publish_details ? clean(data.public_description, 2000) || null : null, organizerName, organizerEmail, clean(data.organizer_phone, 40) || null, Number(data.attendee_count) || null, sqlDate(starts), sqlDate(ends), id]);
    await connection.query('INSERT INTO outbox(topic,aggregate_id,payload) VALUES (?,?,?)', ['telegram.new_request', id, JSON.stringify({ reservation_id: id })]);
    await connection.query('INSERT INTO audit_log(reservation_id,actor_type,actor_id,action) VALUES (?,\'visitor\',?,\'reservation.created\')', [id, organizerEmail]);
    await connection.commit();
    json(res, 201, { id, reference, status: 'pending', message: 'Je aanvraag is ontvangen en wordt door een beheerder beoordeeld.' });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function telegramWebhook(req, res) {
  if (!config.telegram.webhookSecret || req.headers['x-telegram-bot-api-secret-token'] !== config.telegram.webhookSecret) return json(res, 403, { error: 'forbidden' });
  const update = await body(req); const callback = update.callback_query;
  if (!callback) return json(res, 200, { ok: true });
  const userId = String(callback.from?.id || '');
  if (!config.telegram.adminUserIds.has(userId)) {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Je bent niet gemachtigd.', show_alert: true });
    return json(res, 200, { ok: true });
  }
  const match = /^r:([ar]):([A-Za-z0-9_-]+)$/.exec(callback.data || '');
  if (!match) return json(res, 200, { ok: true });
  const action = match[1] === 'a' ? 'approve' : 'reject'; const tokenHash = sha256(match[2]);
  const connection = await pool.getConnection();
  let reference = ''; let resultText = '';
  try {
    await connection.beginTransaction();
    const rows = await connection.query(`SELECT t.id token_id,t.reservation_id,t.action,t.used_at,t.expires_at,r.reference,r.status,r.resource_id,r.starts_at,r.ends_at
      FROM approval_tokens t JOIN reservations r ON r.id=t.reservation_id WHERE t.token_hash=? FOR UPDATE`, [tokenHash]);
    const record = rows[0];
    if (!record || record.action !== action || record.used_at || new Date(record.expires_at) < new Date()) { await connection.rollback(); resultText = 'Deze knop is verlopen of al gebruikt.'; }
    else if (record.status !== 'pending') { await connection.rollback(); resultText = `Aanvraag is al ${record.status}.`; }
    else {
      reference = record.reference;
      if (action === 'approve') {
        await connection.query('SELECT id FROM resources WHERE id=? FOR UPDATE', [record.resource_id]);
        const conflicts = await connection.query(`SELECT id FROM calendar_events WHERE resource_id=? AND is_cancelled=0 AND starts_at < ? AND ends_at > ? LIMIT 1 FOR UPDATE`, [record.resource_id, record.ends_at, record.starts_at]);
        if (conflicts.length) { await connection.rollback(); resultText = 'Niet goedgekeurd: de ruimte is inmiddels bezet.'; }
        else {
          const approver = clean([callback.from.first_name, callback.from.last_name].filter(Boolean).join(' '), 160) || userId;
          await connection.query(`UPDATE reservations SET status='approved_pending_sync',approved_by_telegram_user_id=?,approved_by_name=?,approved_at=NOW(3) WHERE id=?`, [userId, approver, record.reservation_id]);
          await connection.query(`INSERT INTO calendar_events(id,resource_id,reservation_id,source,title,public_description,starts_at,ends_at,last_synced_at)
            SELECT UUID(),resource_id,id,'website',title,public_description,starts_at,ends_at,NOW(3) FROM reservations WHERE id=?`, [record.reservation_id]);
          await connection.query('UPDATE approval_tokens SET used_at=NOW(3) WHERE reservation_id=?', [record.reservation_id]);
          await connection.query('INSERT INTO outbox(topic,aggregate_id,payload) VALUES (?,?,?)', ['graph.create_event', record.reservation_id, JSON.stringify({ reservation_id: record.reservation_id })]);
          await connection.query(`INSERT INTO audit_log(reservation_id,actor_type,actor_id,action,metadata) VALUES (?,'telegram',?,'reservation.approved',?)`, [record.reservation_id, userId, JSON.stringify({ name: approver })]);
          await connection.commit(); resultText = `Goedgekeurd: ${record.reference}`;
        }
      } else {
        await connection.query(`UPDATE reservations SET status='rejected',rejected_at=NOW(3) WHERE id=?`, [record.reservation_id]);
        await connection.query('UPDATE approval_tokens SET used_at=NOW(3) WHERE reservation_id=?', [record.reservation_id]);
        await connection.query(`INSERT INTO audit_log(reservation_id,actor_type,actor_id,action) VALUES (?,'telegram',?,'reservation.rejected')`, [record.reservation_id, userId]);
        await connection.commit(); resultText = `Afgewezen: ${record.reference}`;
      }
    }
  } catch (error) { try { await connection.rollback(); } catch {} throw error; } finally { connection.release(); }
  await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: resultText, show_alert: Boolean(resultText.includes('Niet goedgekeurd')) });
  if (reference && callback.message) {
    if (action === 'reject') await telegram('editMessageText', { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: `❌ ${reference} is afgewezen\nAfgewezen door ${clean([callback.from.first_name, callback.from.last_name].filter(Boolean).join(' '), 160) || userId}.` });
    else await telegram('editMessageReplyMarkup', { chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  json(res, 200, { ok: true });
}

async function graphWebhook(req, res, url) {
  const validation = url.searchParams.get('validationToken');
  if (validation) return text(res, 200, validation);
  const payload = await body(req);
  if (!config.graph.webhookClientState || !Array.isArray(payload.value) || !payload.value.length || payload.value.some(item => item.clientState !== config.graph.webhookClientState)) return json(res, 403, { error: 'invalid_client_state' });
  await pool.query('INSERT INTO outbox(topic,payload) VALUES (?,?)', ['graph.sync_all', JSON.stringify({ source: 'webhook' })]);
  json(res, 202, { accepted: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/v1/config') return json(res, 200, { turnstile: { enabled: Boolean(config.turnstile.secretKey), siteKey: config.turnstile.siteKey } });
    if (req.method === 'GET' && url.pathname === '/api/v1/resources') return resources(res);
    if (req.method === 'GET' && url.pathname === '/api/v1/agenda') return agenda(url, res);
    if (req.method === 'GET' && url.pathname === '/api/v1/availability') return availability(url, res);
    if (req.method === 'POST' && url.pathname === '/api/v1/reservations') return createReservation(req, res);
    if (req.method === 'POST' && url.pathname === '/webhooks/telegram') return telegramWebhook(req, res);
    if (req.method === 'POST' && url.pathname === '/webhooks/microsoft-graph') return graphWebhook(req, res, url);
    json(res, 404, { error: 'not_found' });
  } catch (error) { console.error(error); json(res, error.message === 'payload_too_large' ? 413 : 500, { error: 'Er ging iets mis. Probeer het later opnieuw.' }); }
});

await migrate();
server.listen(config.port, '0.0.0.0', () => console.log(`Sint Jut agenda API luistert op ${config.port}`));
