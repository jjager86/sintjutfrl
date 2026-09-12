import { config, graphCalendarPath, graphRequest, isoDate, migrate, pool, sha256, sqlDate, telegram, token, uuid } from './shared.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHtml = value => String(value || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function claimJob() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const rows = await connection.query(`SELECT id,topic,aggregate_id,payload,attempts FROM outbox
      WHERE ((status IN ('pending','failed') AND available_at<=NOW(3)) OR (status='processing' AND locked_at<DATE_SUB(NOW(3),INTERVAL 10 MINUTE)))
      AND attempts<8 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!rows[0]) { await connection.rollback(); return null; }
    await connection.query(`UPDATE outbox SET status='processing',locked_at=NOW(3),attempts=attempts+1 WHERE id=?`, [rows[0].id]);
    await connection.commit(); return rows[0];
  } finally { connection.release(); }
}

async function finish(job, error = null) {
  if (!error) return pool.query(`UPDATE outbox SET status='done',processed_at=NOW(3),last_error=NULL WHERE id=?`, [job.id]);
  const delayMinutes = Math.min(60, 2 ** Math.min(job.attempts, 6));
  await pool.query(`UPDATE outbox SET status='failed',available_at=DATE_ADD(NOW(3),INTERVAL ? MINUTE),last_error=? WHERE id=?`, [delayMinutes, String(error.message || error).slice(0, 4000), job.id]);
  if (job.topic === 'graph.create_event' && job.attempts >= 7) {
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    const r = (await pool.query('SELECT reference,telegram_chat_id,telegram_message_id FROM reservations WHERE id=?', [payload.reservation_id]))[0];
    await pool.query(`UPDATE reservations SET status='sync_error' WHERE id=? AND status='approved_pending_sync'`, [payload.reservation_id]);
    if (r?.telegram_chat_id && r?.telegram_message_id) await telegram('editMessageText', {
      chat_id: r.telegram_chat_id, message_id: Number(r.telegram_message_id),
      text: `⚠️ ${r.reference} is goedgekeurd en staat op de website, maar synchronisatie met Microsoft 365 is mislukt. Controleer de agenda-instellingen.`
    });
  }
}

async function notifyTelegram(reservationId) {
  if (!config.telegram.token || !config.telegram.chatId) throw new Error('Telegram is niet geconfigureerd');
  const rows = await pool.query(`SELECT r.*,x.name resource_name,x.location resource_location FROM reservations r JOIN resources x ON x.id=r.resource_id WHERE r.id=?`, [reservationId]);
  const r = rows[0]; if (!r || r.status !== 'pending') return;
  const approve = token(); const reject = token(); const expires = sqlDate(Date.now() + 7 * 86400000);
  await pool.batch(`INSERT INTO approval_tokens(id,reservation_id,action,token_hash,expires_at) VALUES (?,?,?,?,?)`, [
    [uuid(), r.id, 'approve', sha256(approve), expires], [uuid(), r.id, 'reject', sha256(reject), expires]
  ]);
  const start = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(isoDate(r.starts_at)));
  const end = new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(isoDate(r.ends_at)));
  const message = await telegram('sendMessage', {
    chat_id: config.telegram.chatId,
    parse_mode: 'HTML',
    text: `<b>Nieuwe reserveringsaanvraag ${escapeHtml(r.reference)}</b>\n\n🏠 <b>${escapeHtml(r.resource_name)}</b>\n🗓 ${escapeHtml(start)} – ${escapeHtml(end)}\n🎉 ${escapeHtml(r.title)}\n👤 ${escapeHtml(r.organizer_name)}\n✉️ ${escapeHtml(r.organizer_email)}${r.organizer_phone ? `\n☎️ ${escapeHtml(r.organizer_phone)}` : ''}${r.attendee_count ? `\n👥 ${r.attendee_count} personen` : ''}\n\n${escapeHtml(r.description || 'Geen aanvullende toelichting.')}`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Goedkeuren', callback_data: `r:a:${approve}` },
      { text: '❌ Afwijzen', callback_data: `r:r:${reject}` }
    ]] }
  });
  await pool.query('UPDATE reservations SET telegram_chat_id=?,telegram_message_id=? WHERE id=?', [String(message.chat.id), message.message_id, r.id]);
}

async function confirmLocally(r, resource, graphEvent = null) {
  const eventId = uuid();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`INSERT INTO calendar_events(id,resource_id,reservation_id,source,external_id,title,public_description,location,starts_at,ends_at,last_synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NOW(3)) ON DUPLICATE KEY UPDATE external_id=VALUES(external_id),title=VALUES(title),public_description=VALUES(public_description),starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),last_synced_at=NOW(3)`,
      [eventId, r.resource_id, r.id, 'website', graphEvent?.id || null, r.title, r.public_description, resource.location, r.starts_at, r.ends_at]);
    await connection.query(`UPDATE reservations SET status='confirmed',graph_event_id=? WHERE id=?`, [graphEvent?.id || null, r.id]);
    await connection.query(`INSERT INTO audit_log(reservation_id,actor_type,action,metadata) VALUES (?,'system','reservation.confirmed',?)`, [r.id, JSON.stringify({ graph: Boolean(graphEvent) })]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  if (r.telegram_chat_id && r.telegram_message_id) await telegram('editMessageText', {
    chat_id: r.telegram_chat_id, message_id: Number(r.telegram_message_id), parse_mode: 'HTML',
    text: `✅ <b>${escapeHtml(r.reference)} is definitief</b>\n${escapeHtml(resource.name)} · ${escapeHtml(r.title)}\nGoedgekeurd door ${escapeHtml(r.approved_by_name || 'beheerder')}.`
  });
}

async function createGraphEvent(reservationId) {
  const r = (await pool.query(`SELECT r.*,x.name resource_name,x.location,x.graph_calendar_id FROM reservations r JOIN resources x ON x.id=r.resource_id WHERE r.id=?`, [reservationId]))[0];
  if (!r || r.status !== 'approved_pending_sync') return;
  const resource = { name: r.resource_name, location: r.location, graph_calendar_id: r.graph_calendar_id };
  if (!config.graph.enabled) return confirmLocally(r, resource);
  if (!config.graph.tenantId || !config.graph.clientId || !config.graph.clientSecret || !config.graph.mailbox) throw new Error('Microsoft Graph is onvolledig geconfigureerd');
  if (!resource.graph_calendar_id) throw new Error(`Geen Microsoft 365-agenda gekoppeld aan ${resource.name}`);
  const result = await graphRequest(graphCalendarPath(resource, '/events'), {
    method: 'POST', body: JSON.stringify({
      subject: r.title,
      body: { contentType: 'text', content: `${r.description || ''}\n\nReservering ${r.reference}`.trim() },
      start: { dateTime: isoDate(r.starts_at).replace('Z', ''), timeZone: 'UTC' },
      end: { dateTime: isoDate(r.ends_at).replace('Z', ''), timeZone: 'UTC' },
      location: { displayName: r.location || r.resource_name },
      transactionId: r.graph_transaction_id,
      singleValueExtendedProperties: [{ id: 'String {66f5a359-4659-4830-9070-00040ec6ac6e} Name SintJutReservationId', value: r.id }]
    })
  });
  await confirmLocally(r, resource, result);
}

async function syncGraph() {
  if (!config.graph.enabled) return;
  const resources = await pool.query('SELECT * FROM resources WHERE is_active=1 AND graph_calendar_id IS NOT NULL');
  const start = new Date(Date.now() - 30 * 86400000).toISOString(); const end = new Date(Date.now() + 365 * 86400000).toISOString();
  for (const resource of resources) {
    const syncStartedAt = sqlDate(new Date());
    let path = `${graphCalendarPath(resource, '/calendarView')}?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=999`;
    while (path) {
      const result = await graphRequest(path, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      for (const event of result.value || []) {
        const isPrivate = event.sensitivity === 'private';
        await pool.query(`INSERT INTO calendar_events(id,resource_id,source,external_id,title,public_description,location,starts_at,ends_at,is_private,is_cancelled,last_synced_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(3)) ON DUPLICATE KEY UPDATE title=VALUES(title),public_description=VALUES(public_description),location=VALUES(location),starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),is_private=VALUES(is_private),is_cancelled=VALUES(is_cancelled),last_synced_at=NOW(3)`,
          [uuid(), resource.id, 'microsoft365', event.id, isPrivate ? 'Bezet' : event.subject || 'Activiteit', isPrivate ? null : (event.bodyPreview || null), event.location?.displayName || resource.location, sqlDate(`${event.start.dateTime}${event.start.dateTime.endsWith('Z') ? '' : 'Z'}`), sqlDate(`${event.end.dateTime}${event.end.dateTime.endsWith('Z') ? '' : 'Z'}`), isPrivate, Boolean(event.isCancelled)]);
      }
      path = result['@odata.nextLink']?.replace('https://graph.microsoft.com/v1.0', '') || null;
    }
    await pool.query(`UPDATE calendar_events SET is_cancelled=1,last_synced_at=NOW(3)
      WHERE resource_id=? AND source='microsoft365' AND starts_at < ? AND ends_at > ? AND last_synced_at < ?`, [resource.id, sqlDate(end), sqlDate(start), syncStartedAt]);
  }
}

async function process(job) {
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  if (job.topic === 'telegram.new_request') return notifyTelegram(payload.reservation_id);
  if (job.topic === 'graph.create_event') return createGraphEvent(payload.reservation_id);
  if (job.topic === 'graph.sync_all') return syncGraph();
}

await migrate();
let nextGraphSync = 0;
for (;;) {
  try {
    if (Date.now() >= nextGraphSync) { await pool.query('INSERT INTO outbox(topic,payload) VALUES (?,?)', ['graph.sync_all', JSON.stringify({ source: 'timer' })]); nextGraphSync = Date.now() + 300000; }
    const job = await claimJob();
    if (!job) { await sleep(1500); continue; }
    try { await process(job); await finish(job); } catch (error) { console.error(job.topic, error); await finish(job, error); }
  } catch (error) { console.error('worker loop', error); await sleep(5000); }
}
