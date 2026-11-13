import http from 'node:http';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config, isoDate, migrate, pool, sha256, sqlDate, telegram, token, uuid, verifyTurnstile } from './shared.js';

const rate = new Map();
const adminRate = new Map();
const scrypt = promisify(scryptCallback);
const eventCalendarResourceId = 'c75a1b0e-9ea5-4c15-b0dd-1a249c105004';
const municipalCalendarUrl = 'https://www.defryskemarren.nl/direct-regelen/vergunningen-toestemming/evenementenkalender/';
let municipalCache = { expires: 0, events: [] };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const text = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };
const clean = (value, max = 255) => String(value || '').trim().slice(0, max);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const safePublicUrl = value => { const candidate = clean(value, 500); if (!candidate) return null; if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate; try { const url = new URL(candidate); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };

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

function adminLimited(req) {
  const ip = clean(req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress, 80);
  const now = Date.now(); const recent = (adminRate.get(ip) || []).filter(t => t > now - 900000); recent.push(now); adminRate.set(ip, recent);
  if (adminRate.size > 10000) adminRate.delete(adminRate.keys().next().value);
  return recent.length > 20;
}

async function passwordDigest(password, salt = randomBytes(16).toString('hex')) {
  const digest = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(digest).toString('hex') };
}

async function passwordMatches(password, salt, expected) {
  const { hash } = await passwordDigest(password, salt);
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
}

const serializeAdminUser = user => ({
  id: user.id,
  username: user.username,
  display_name: user.display_name,
  is_super_admin: Boolean(user.is_super_admin),
  is_active: Boolean(user.is_active),
  permissions: (user.permissions || []).map(permission => ({
    resource_id: permission.resource_id,
    can_view: Boolean(permission.can_view),
    can_create: Boolean(permission.can_create),
    can_edit: Boolean(permission.can_edit),
    can_delete: Boolean(permission.can_delete)
  }))
});

async function authenticateAdmin(req, res) {
  const header = clean(req.headers.authorization, 4096);
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const row = supplied ? (await pool.query(`SELECT u.id,u.username,u.display_name,u.is_super_admin,u.is_active,s.id session_id
    FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>NOW(3) AND u.is_active=1`, [sha256(supplied)]))[0] : null;
  if (!row) { res.setHeader('www-authenticate', 'Bearer realm="Sint Jut agenda"'); json(res, 401, { error: 'Je sessie is verlopen of ongeldig.' }); return null; }
  const permissions = await pool.query('SELECT resource_id,can_view,can_create,can_edit,can_delete FROM admin_user_resources WHERE user_id=?', [row.id]);
  await pool.query('UPDATE admin_sessions SET last_used_at=NOW(3) WHERE id=?', [row.session_id]);
  return { ...row, permissions: permissions.map(permission => ({ ...permission, can_view: Boolean(permission.can_view), can_create: Boolean(permission.can_create), can_edit: Boolean(permission.can_edit), can_delete: Boolean(permission.can_delete) })) };
}

function can(admin, resourceId, action) {
  if (admin.is_super_admin) return true;
  const permission = admin.permissions.find(item => item.resource_id === resourceId);
  return Boolean(permission?.[`can_${action}`]);
}

async function adminStatus(res) {
  const [{ count }] = await pool.query('SELECT COUNT(*) count FROM admin_users');
  json(res, 200, { configured: Number(count) > 0, bootstrap_available: Boolean(config.adminToken) });
}

async function bootstrapAdmin(req, res) {
  if (adminLimited(req)) return json(res, 429, { error: 'Te veel pogingen. Probeer het later opnieuw.' });
  const data = await body(req); const bootstrapToken = clean(data.bootstrap_token, 4096);
  if (!config.adminToken || !bootstrapToken || !timingSafeEqual(Buffer.from(sha256(config.adminToken)), Buffer.from(sha256(bootstrapToken)))) return json(res, 403, { error: 'De installatiesleutel is ongeldig.' });
  const [{ count }] = await pool.query('SELECT COUNT(*) count FROM admin_users');
  if (Number(count) > 0) return json(res, 409, { error: 'Het eerste beheeraccount is al aangemaakt.' });
  return createAdminUserRecord(res, data, true);
}

async function loginAdmin(req, res) {
  if (adminLimited(req)) return json(res, 429, { error: 'Te veel pogingen. Probeer het later opnieuw.' });
  const data = await body(req); const username = clean(data.username, 80).toLowerCase(); const password = clean(data.password, 200);
  const user = (await pool.query('SELECT * FROM admin_users WHERE username=? AND is_active=1', [username]))[0];
  if (!user || !(await passwordMatches(password, user.password_salt, user.password_hash))) return json(res, 401, { error: 'Gebruikersnaam of wachtwoord is onjuist.' });
  const sessionToken = token(); const id = uuid(); const expires = new Date(Date.now() + 12 * 3600000);
  await pool.query('DELETE FROM admin_sessions WHERE expires_at<=NOW(3)');
  await pool.query('INSERT INTO admin_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)', [id,user.id,sha256(sessionToken),sqlDate(expires)]);
  json(res, 200, { token: sessionToken, user: serializeAdminUser(user), expires_at: expires.toISOString() });
}

async function logoutAdmin(admin, res) {
  await pool.query('DELETE FROM admin_sessions WHERE id=?', [admin.session_id]);
  json(res, 200, { ok: true });
}

async function createAdminUserRecord(res, data, forceSuper = false) {
  const username = clean(data.username, 80).toLowerCase(); const displayName = clean(data.display_name, 160); const password = clean(data.password, 200);
  if (!/^[a-z0-9._-]{3,80}$/.test(username) || !displayName || password.length < 12) return json(res, 422, { error: 'Gebruik een geldige gebruikersnaam en een wachtwoord van minimaal 12 tekens.' });
  const { salt, hash } = await passwordDigest(password); const id = uuid(); const isSuper = forceSuper || Boolean(data.is_super_admin);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('INSERT INTO admin_users(id,username,display_name,password_hash,password_salt,is_super_admin) VALUES (?,?,?,?,?,?)', [id,username,displayName,hash,salt,isSuper]);
    if (!isSuper) await saveAdminPermissions(connection,id,data.permissions);
    await connection.commit();
    const user = (await pool.query('SELECT * FROM admin_users WHERE id=?',[id]))[0]; user.permissions = isSuper ? [] : await pool.query('SELECT resource_id,can_view,can_create,can_edit,can_delete FROM admin_user_resources WHERE user_id=?',[id]);
    json(res, 201, { user: serializeAdminUser(user) });
  } catch (error) { await connection.rollback(); if (error.code === 'ER_DUP_ENTRY') return json(res,409,{error:'Deze gebruikersnaam bestaat al.'}); throw error; } finally { connection.release(); }
}

async function saveAdminPermissions(connection, userId, permissions) {
  await connection.query('DELETE FROM admin_user_resources WHERE user_id=?',[userId]);
  if (!Array.isArray(permissions)) return;
  for (const permission of permissions) {
    const resourceId=clean(permission.resource_id,36); if (!resourceId) continue;
    const exists=(await connection.query('SELECT id FROM resources WHERE id=? AND is_active=1',[resourceId]))[0]; if(!exists) continue;
    await connection.query('INSERT INTO admin_user_resources(user_id,resource_id,can_view,can_create,can_edit,can_delete) VALUES (?,?,?,?,?,?)',[userId,resourceId,Boolean(permission.can_view),Boolean(permission.can_create),Boolean(permission.can_edit),Boolean(permission.can_delete)]);
  }
}

async function listAdminUsers(res) {
  const users=await pool.query('SELECT id,username,display_name,is_super_admin,is_active,created_at FROM admin_users ORDER BY display_name');
  const permissions=await pool.query('SELECT user_id,resource_id,can_view,can_create,can_edit,can_delete FROM admin_user_resources');
  json(res,200,{users:users.map(user=>serializeAdminUser({...user,permissions:permissions.filter(permission=>permission.user_id===user.id)}))});
}

async function updateAdminUser(req,res,admin,id) {
  const data=await body(req); const current=(await pool.query('SELECT * FROM admin_users WHERE id=?',[id]))[0]; if(!current)return json(res,404,{error:'Gebruiker niet gevonden.'});
  const username=clean(data.username,80).toLowerCase();const displayName=clean(data.display_name,160);const isSuper=Boolean(data.is_super_admin);const isActive=data.is_active!==false;
  if(!/^[a-z0-9._-]{3,80}$/.test(username)||!displayName)return json(res,422,{error:'Controleer gebruikersnaam en weergavenaam.'});
  if(id===admin.id&&(!isSuper||!isActive))return json(res,409,{error:'Je kunt je eigen hoofdbeheerrechten of account niet uitschakelen.'});
  if(current.is_super_admin&&(!isSuper||!isActive)){const [{count}]=await pool.query('SELECT COUNT(*) count FROM admin_users WHERE is_super_admin=1 AND is_active=1 AND id<>?',[id]);if(Number(count)<1)return json(res,409,{error:'Er moet minimaal één actieve hoofdbeheerder blijven.'});}
  const connection=await pool.getConnection();
  try{await connection.beginTransaction();let passwordSql='';const params=[username,displayName,isSuper,isActive];const password=clean(data.password,200);if(password){if(password.length<12){await connection.rollback();return json(res,422,{error:'Het wachtwoord moet minimaal 12 tekens hebben.'});}const {salt,hash}=await passwordDigest(password);passwordSql=',password_hash=?,password_salt=?';params.push(hash,salt);}params.push(id);await connection.query(`UPDATE admin_users SET username=?,display_name=?,is_super_admin=?,is_active=?${passwordSql} WHERE id=?`,params);if(isSuper)await connection.query('DELETE FROM admin_user_resources WHERE user_id=?',[id]);else await saveAdminPermissions(connection,id,data.permissions);if(!isActive)await connection.query('DELETE FROM admin_sessions WHERE user_id=?',[id]);await connection.commit();const user=(await pool.query('SELECT * FROM admin_users WHERE id=?',[id]))[0];user.permissions=isSuper?[]:await pool.query('SELECT resource_id,can_view,can_create,can_edit,can_delete FROM admin_user_resources WHERE user_id=?',[id]);json(res,200,{user:serializeAdminUser(user)});}catch(error){await connection.rollback();if(error.code==='ER_DUP_ENTRY')return json(res,409,{error:'Deze gebruikersnaam bestaat al.'});throw error;}finally{connection.release();}
}

function adminEventData(data) {
  const resourceId = clean(data.resource_id, 36);
  const title = clean(data.title, 180);
  const starts = new Date(data.starts_at);
  const ends = new Date(data.ends_at);
  if (!resourceId || !title || !Number.isFinite(starts.valueOf()) || !Number.isFinite(ends.valueOf()) || ends <= starts || ends - starts > 7 * 86400000) throw new Error('invalid_admin_event');
  const rawLogo = clean(data.logo_url, 500);
  const logoUrl = safePublicUrl(rawLogo);
  if (rawLogo && !logoUrl) throw new Error('invalid_logo_url');
  return { resourceId, title, starts, ends, publicDescription: clean(data.public_description, 2000) || null, location: clean(data.location, 255) || null, logoUrl };
}

const adminEventSelect = `SELECT e.id,e.resource_id,e.reservation_id,e.source,e.title,e.public_description,e.logo_url,e.location,e.starts_at,e.ends_at,e.is_private,
  r.name resource_name,r.location resource_location,r.logo_url resource_logo_url
  FROM calendar_events e JOIN resources r ON r.id=e.resource_id`;

const serializeAdminEvent = (row, admin) => ({
  ...row,
  editable: ['website','municipality'].includes(row.source) && !row.reservation_id && can(admin, row.resource_id, 'edit'),
  deletable: ['website','municipality'].includes(row.source) && !row.reservation_id && can(admin, row.resource_id, 'delete'),
  starts_at: isoDate(row.starts_at),
  ends_at: isoDate(row.ends_at)
});

async function adminEvents(url, res, admin) {
  const from = url.searchParams.get('from') || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = url.searchParams.get('to') || new Date(Date.now() + 365 * 86400000).toISOString();
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return json(res, 400, { error: 'Ongeldige periode.' });
  const allowed = admin.permissions.filter(permission => permission.can_view).map(permission => permission.resource_id);
  if (!admin.is_super_admin && !allowed.length) return json(res, 200, { events: [] });
  const resourceSql = admin.is_super_admin ? '' : ` AND e.resource_id IN (${allowed.map(() => '?').join(',')})`;
  const rows = await pool.query(`${adminEventSelect} WHERE e.is_cancelled=0 AND e.starts_at < ? AND e.ends_at > ?${resourceSql} ORDER BY e.starts_at`, [sqlDate(to), sqlDate(from), ...allowed]);
  json(res, 200, { events: rows.map(row => serializeAdminEvent(row, admin)) });
}

async function adminResources(admin, res) {
  const rows = await pool.query('SELECT id,slug,name,location,capacity,logo_url FROM resources WHERE is_active=1 ORDER BY name');
  const visible = admin.is_super_admin ? rows : rows.filter(row => admin.permissions.some(permission => permission.resource_id === row.id && Object.values(permission).some(Boolean)));
  json(res, 200, { resources: visible.map(row => ({
    ...row,
    permissions: {
      can_view: can(admin, row.id, 'view'),
      can_create: can(admin, row.id, 'create'),
      can_edit: can(admin, row.id, 'edit'),
      can_delete: can(admin, row.id, 'delete')
    }
  })) });
}

async function ensureAdminEventAvailable(connection, event, excludeId = '') {
  const resource = (await connection.query('SELECT id,allows_overlap FROM resources WHERE id=? AND is_active=1', [event.resourceId]))[0];
  if (!resource) throw new Error('resource_not_found');
  if (resource.allows_overlap) return;
  const params = [event.resourceId, sqlDate(event.ends), sqlDate(event.starts)];
  const exclude = excludeId ? ' AND id<>?' : '';
  if (excludeId) params.push(excludeId);
  const conflict = await connection.query(`SELECT id FROM calendar_events WHERE resource_id=? AND is_cancelled=0 AND starts_at < ? AND ends_at > ?${exclude} LIMIT 1`, params);
  if (conflict.length) throw new Error('event_conflict');
}

async function createAdminEvent(req, res, admin) {
  const event = adminEventData(await body(req));
  if (!can(admin, event.resourceId, 'create')) return json(res, 403, { error: 'Je mag voor deze ruimte geen activiteiten toevoegen.' });
  const connection = await pool.getConnection();
  const id = uuid();
  try {
    await connection.beginTransaction();
    await ensureAdminEventAvailable(connection, event);
    await connection.query(`INSERT INTO calendar_events(id,resource_id,source,title,public_description,logo_url,location,starts_at,ends_at,last_synced_at)
      VALUES (?,?,'website',?,?,?,?,?,?,NOW(3))`, [id,event.resourceId,event.title,event.publicDescription,event.logoUrl,event.location,sqlDate(event.starts),sqlDate(event.ends)]);
    await connection.query(`INSERT INTO audit_log(actor_type,actor_id,action,metadata) VALUES ('system',?,'admin.event_created',?)`, [admin.username, JSON.stringify({ event_id: id })]);
    await connection.commit();
    const row = (await pool.query(`${adminEventSelect} WHERE e.id=?`, [id]))[0];
    json(res, 201, { event: serializeAdminEvent(row, admin) });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function updateAdminEvent(req, res, admin, id) {
  const event = adminEventData(await body(req));
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const current = (await connection.query('SELECT id,resource_id,source,reservation_id FROM calendar_events WHERE id=? AND is_cancelled=0 FOR UPDATE', [id]))[0];
    if (!current) { await connection.rollback(); return json(res, 404, { error: 'Activiteit niet gevonden.' }); }
    if (!can(admin, current.resource_id, 'edit')) { await connection.rollback(); return json(res, 403, { error: 'Je mag activiteiten in deze ruimte niet wijzigen.' }); }
    if (!['website','municipality'].includes(current.source) || current.reservation_id) { await connection.rollback(); return json(res, 409, { error: 'Beheer deze gekoppelde activiteit in Outlook of via de reservering.' }); }
    if (event.resourceId !== current.resource_id && !can(admin, event.resourceId, 'create')) { await connection.rollback(); return json(res, 403, { error: 'Je mag geen activiteit naar deze ruimte verplaatsen.' }); }
    await ensureAdminEventAvailable(connection, event, id);
    await connection.query(`UPDATE calendar_events SET resource_id=?,title=?,public_description=?,logo_url=?,location=?,starts_at=?,ends_at=?,last_synced_at=NOW(3) WHERE id=?`, [event.resourceId,event.title,event.publicDescription,event.logoUrl,event.location,sqlDate(event.starts),sqlDate(event.ends),id]);
    await connection.query(`INSERT INTO audit_log(actor_type,actor_id,action,metadata) VALUES ('system',?,'admin.event_updated',?)`, [admin.username, JSON.stringify({ event_id: id })]);
    await connection.commit();
    const row = (await pool.query(`${adminEventSelect} WHERE e.id=?`, [id]))[0];
    json(res, 200, { event: serializeAdminEvent(row, admin) });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function deleteAdminEvent(res, admin, id) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const current = (await connection.query('SELECT id,resource_id,source,reservation_id FROM calendar_events WHERE id=? AND is_cancelled=0 FOR UPDATE', [id]))[0];
    if (!current) { await connection.rollback(); return json(res, 404, { error: 'Activiteit niet gevonden.' }); }
    if (!can(admin, current.resource_id, 'delete')) { await connection.rollback(); return json(res, 403, { error: 'Je mag activiteiten in deze ruimte niet verwijderen.' }); }
    if (!['website','municipality'].includes(current.source) || current.reservation_id) { await connection.rollback(); return json(res, 409, { error: 'Beheer deze gekoppelde activiteit in Outlook of via de reservering.' }); }
    await connection.query('UPDATE calendar_events SET is_cancelled=1,last_synced_at=NOW(3) WHERE id=?', [id]);
    await connection.query(`INSERT INTO audit_log(actor_type,actor_id,action,metadata) VALUES ('system',?,'admin.event_deleted',?)`, [admin.username, JSON.stringify({ event_id: id })]);
    await connection.commit();
    json(res, 200, { ok: true });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function resources(res) {
  const rows = await pool.query('SELECT id, slug, name, location, capacity, logo_url FROM resources WHERE is_active=1 AND is_bookable=1 ORDER BY name');
  json(res, 200, { resources: rows });
}

async function createEventRequest(req, res) {
  if (limited(req)) return json(res, 429, { error: 'Te veel aanvragen. Probeer het later opnieuw.' });
  const data = await body(req); const title = clean(data.title,180); const description = clean(data.public_description,2000); const location = clean(data.location,255); const organizerName = clean(data.organizer_name,160); const email = clean(data.organizer_email,254).toLowerCase(); const phone = clean(data.organizer_phone,40); const starts = new Date(data.starts_at); const ends = new Date(data.ends_at);
  if (!title || !location || !organizerName || !validEmail(email) || !Number.isFinite(starts.valueOf()) || !Number.isFinite(ends.valueOf()) || ends <= starts || ends - starts > 14 * 86400000) return json(res,422,{error:'Controleer de activiteit, locatie, datum en contactgegevens.'});
  const id=uuid(); const reference=`EVT-${randomBytes(4).toString('hex').toUpperCase()}`;
  await pool.query(`INSERT INTO event_requests(id,reference,title,public_description,location,organizer_name,organizer_email,organizer_phone,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,[id,reference,title,description||null,location,organizerName,email,phone||null,sqlDate(starts),sqlDate(ends)]);
  await pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,metadata) VALUES ('visitor',?,'event.requested',?)`,[sha256(email),JSON.stringify({event_request_id:id,reference})]);
  json(res,201,{ok:true,reference});
}

async function adminEventRequests(admin,res) {
  if (!can(admin,eventCalendarResourceId,'view')) return json(res,403,{error:'Je mag evenementaanvragen niet bekijken.'});
  const requests=await pool.query(`SELECT id,reference,title,public_description,location,organizer_name,organizer_email,organizer_phone,starts_at,ends_at,status,created_at FROM event_requests ORDER BY FIELD(status,'pending','approved','rejected'),starts_at`);
  json(res,200,{requests:requests.map(item=>({...item,starts_at:isoDate(item.starts_at),ends_at:isoDate(item.ends_at),created_at:isoDate(item.created_at)}))});
}

async function reviewEventRequest(admin,res,id,approve) {
  if (!can(admin,eventCalendarResourceId,'create')) return json(res,403,{error:'Je mag evenementaanvragen niet beoordelen.'});
  const connection=await pool.getConnection();
  try{await connection.beginTransaction();const item=(await connection.query('SELECT * FROM event_requests WHERE id=? FOR UPDATE',[id]))[0];if(!item){await connection.rollback();return json(res,404,{error:'Aanvraag niet gevonden.'});}if(item.status!=='pending'){await connection.rollback();return json(res,409,{error:'Deze aanvraag is al beoordeeld.'});}let eventId=null;if(approve){eventId=uuid();await connection.query(`INSERT INTO calendar_events(id,resource_id,source,title,public_description,location,starts_at,ends_at,last_synced_at) VALUES (?,?,'website',?,?,?,?,?,NOW(3))`,[eventId,eventCalendarResourceId,item.title,item.public_description,item.location,item.starts_at,item.ends_at]);}await connection.query('UPDATE event_requests SET status=?,reviewed_by=?,reviewed_at=NOW(3),calendar_event_id=? WHERE id=?',[approve?'approved':'rejected',admin.id,eventId,id]);await connection.query(`INSERT INTO audit_log(actor_type,actor_id,action,metadata) VALUES ('system',?,?,?)`,[admin.username,approve?'event.request_approved':'event.request_rejected',JSON.stringify({event_request_id:id,event_id:eventId})]);await connection.commit();json(res,200,{ok:true});}catch(error){await connection.rollback();throw error;}finally{connection.release();}
}

const decodeHtml = value => String(value || '').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&ndash;|&#8211;/gi,'–').replace(/&mdash;|&#8212;/gi,'—').replace(/\s+/g,' ').trim();
const dutchMonths = { januari:1,februari:2,maart:3,april:4,mei:5,juni:6,juli:7,augustus:8,september:9,oktober:10,november:11,december:12 };
function municipalDate(value, fallbackYear) {
  const normalized=decodeHtml(value).toLowerCase().replace(/\./g,'').trim();let match=/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?$/.exec(normalized);if(match)return{day:Number(match[1]),month:Number(match[2]),year:Number(match[3]||fallbackYear)};
  match=/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(normalized);if(!match||!dutchMonths[match[2]])return null;return{day:Number(match[1]),month:dutchMonths[match[2]],year:Number(match[3]||fallbackYear)};
}
function zonedDate({year,month,day},hour) {
  let utc=Date.UTC(year,month-1,day,hour);for(let pass=0;pass<2;pass++){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(utc)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));const shown=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour);utc-=shown-Date.UTC(year,month-1,day,hour);}return new Date(utc);
}
function municipalEvent(title,place,location,startText,endText,year) {
  const start=municipalDate(startText,year),end=municipalDate(endText||startText,year);if(!title||!start||!end)return null;if(end.month<start.month&&!/\d{4}/.test(endText))end.year=start.year+1;const starts=zonedDate(start,9),ends=zonedDate(end,23);return{external_id:sha256(`${title}|${starts.toISOString()}|${location}`).slice(0,40),title,place,location:location||place,starts_at:starts.toISOString(),ends_at:ends.toISOString(),source_url:municipalCalendarUrl};
}
async function fetchMunicipalEvents(force=false) {
  if(!force&&municipalCache.expires>Date.now())return municipalCache.events;
  const response=await fetch(municipalCalendarUrl,{headers:{'user-agent':'SintJut.frl evenementenkalender/1.0 (+https://sintjut.frl)'}});if(!response.ok)throw new Error('municipal_source_unavailable');const html=await response.text(),year=Number(/Evenementen\s+(20\d{2})/i.exec(decodeHtml(html))?.[1]||new Date().getFullYear()),events=[];
  for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell=>decodeHtml(cell[1]));if(cells.length>=5&&/\d{1,2}[-/]\d{1,2}/.test(cells[3])){const item=municipalEvent(cells[0],cells[1],cells[2],cells[3],cells[4],year);if(item)events.push(item);}}
  for(const heading of html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|<table\b|<h2\b)/gi)){const title=decodeHtml(heading[1]),copy=decodeHtml(heading[2]),match=/Datum:\s*(.+?)\s+Locatie:\s*(.+)$/i.exec(copy);if(!match)continue;const range=match[1].split(/\s+[–—]\s+/),item=municipalEvent(title,'',match[2],range[0],range[1]||range[0],year);if(item)events.push(item);}
  municipalCache={expires:Date.now()+15*60*1000,events:[...new Map(events.map(item=>[item.external_id,item])).values()].sort((a,b)=>a.starts_at.localeCompare(b.starts_at))};return municipalCache.events;
}
async function municipalEvents(admin,res) {
  if(!can(admin,eventCalendarResourceId,'view'))return json(res,403,{error:'Je mag externe evenementen niet bekijken.'});const events=await fetchMunicipalEvents();const imported=await pool.query(`SELECT external_id FROM calendar_events WHERE resource_id=? AND source='municipality'`,[eventCalendarResourceId]);const ids=new Set(imported.map(item=>item.external_id));json(res,200,{source_url:municipalCalendarUrl,events:events.map(item=>({...item,imported:ids.has(item.external_id)}))});
}
async function importMunicipalEvent(req,res,admin) {
  if(!can(admin,eventCalendarResourceId,'create'))return json(res,403,{error:'Je mag geen externe evenementen toevoegen.'});const data=await body(req),events=await fetchMunicipalEvents(),item=events.find(event=>event.external_id===clean(data.external_id,80));if(!item)return json(res,404,{error:'Het evenement staat niet meer in de gemeentelijke bron.'});try{const id=uuid();await pool.query(`INSERT INTO calendar_events(id,resource_id,source,external_id,title,public_description,location,starts_at,ends_at,last_synced_at) VALUES (?,?,'municipality',?,?,?,?,?,?,NOW(3))`,[id,eventCalendarResourceId,item.external_id,item.title,`Overgenomen uit de evenementenkalender van gemeente De Fryske Marren.`,item.location,sqlDate(item.starts_at),sqlDate(item.ends_at)]);await pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,metadata) VALUES ('system',?,'event.municipality_imported',?)`,[admin.username,JSON.stringify({event_id:id,external_id:item.external_id})]);json(res,201,{ok:true,event_id:id});}catch(error){if(error.code==='ER_DUP_ENTRY')return json(res,409,{error:'Dit evenement is al toegevoegd.'});throw error;}
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
  const rows = await pool.query(`SELECT e.id, e.title, e.public_description, e.logo_url, e.location, e.starts_at, e.ends_at, e.is_private,
    r.id resource_id, r.name resource_name, r.location resource_location, r.logo_url resource_logo_url
    FROM calendar_events e JOIN resources r ON r.id=e.resource_id
    WHERE e.is_cancelled=0 AND e.starts_at < ? AND e.ends_at > ?${resourceSql} ORDER BY e.starts_at`, [params[1], params[0], ...params.slice(2)]);
  json(res, 200, { events: rows.map(row => ({ ...row, title: row.is_private ? 'Bezet' : row.title, public_description: row.is_private ? null : row.public_description, starts_at: isoDate(row.starts_at), ends_at: isoDate(row.ends_at) })) });
}

const icsEscape = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const icsDate = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

async function eventCalendar(res) {
  const rows = await pool.query(`SELECT e.id,e.title,e.public_description,e.location,e.starts_at,e.ends_at,r.name resource_name,r.location resource_location
    FROM calendar_events e JOIN resources r ON r.id=e.resource_id
    WHERE e.is_cancelled=0 AND e.is_private=0 AND e.ends_at>=NOW(3) AND e.starts_at<DATE_ADD(NOW(3),INTERVAL 18 MONTH)
    ORDER BY e.starts_at`);
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Sint Jut//Dorpsagenda//NL','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Sint Jut dorpsagenda','X-WR-TIMEZONE:Europe/Amsterdam'];
  for (const event of rows) lines.push('BEGIN:VEVENT',`UID:${event.id}@sintjut.frl`,`DTSTAMP:${icsDate(new Date())}`,`DTSTART:${icsDate(event.starts_at)}`,`DTEND:${icsDate(event.ends_at)}`,`SUMMARY:${icsEscape(event.title)}`,`LOCATION:${icsEscape(event.location || event.resource_location || event.resource_name)}`,`DESCRIPTION:${icsEscape(event.public_description)}`,'END:VEVENT');
  lines.push('END:VCALENDAR');
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="sint-jut-agenda.ics"', 'cache-control': 'public, max-age=300' });
  res.end(`${lines.join('\r\n')}\r\n`);
}

async function availability(url, res) {
  const start = url.searchParams.get('start'); const end = url.searchParams.get('end');
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) return json(res, 400, { error: 'Ongeldige periode.' });
  const rows = await pool.query(`SELECT r.id, r.slug, r.name, r.location, r.capacity,
    NOT EXISTS(SELECT 1 FROM calendar_events e WHERE e.resource_id=r.id AND e.is_cancelled=0 AND e.starts_at < ? AND e.ends_at > ?) available
    FROM resources r WHERE r.is_active=1 AND r.is_bookable=1 ORDER BY r.name`, [sqlDate(end), sqlDate(start)]);
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
    if (req.method === 'GET' && (url.pathname === '/api' || url.pathname === '/api/')) return json(res, 200, {
      name: 'Sint Jut agenda API',
      version: 'v1',
      endpoints: {
        agenda: '/api/v1/agenda',
        availability: '/api/v1/availability',
        resources: '/api/v1/resources',
        calendar: '/api/v1/calendar.ics',
        config: '/api/v1/config',
        admin: '/admin/'
      }
    });
    if (req.method === 'GET' && url.pathname === '/api/v1/admin/status') return adminStatus(res);
    if (req.method === 'POST' && url.pathname === '/api/v1/admin/bootstrap') return bootstrapAdmin(req, res);
    if (req.method === 'POST' && url.pathname === '/api/v1/admin/login') return loginAdmin(req, res);
    if (url.pathname.startsWith('/api/v1/admin/')) {
      const admin = await authenticateAdmin(req, res);
      if (!admin) return;
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/session') return json(res, 200, { ok: true, user: serializeAdminUser(admin) });
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/logout') return logoutAdmin(admin, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/resources') return adminResources(admin, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/events') return adminEvents(url, res, admin);
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/events') return createAdminEvent(req, res, admin);
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/event-requests') return adminEventRequests(admin, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/municipal-events') return municipalEvents(admin,res);
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/municipal-events/import') return importMunicipalEvent(req,res,admin);
      const requestMatch = /^\/api\/v1\/admin\/event-requests\/([0-9a-f-]{36})\/(approve|reject)$/.exec(url.pathname);
      if (requestMatch && req.method === 'POST') return reviewEventRequest(admin,res,requestMatch[1],requestMatch[2]==='approve');
      const eventMatch = /^\/api\/v1\/admin\/events\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (eventMatch && req.method === 'PUT') return updateAdminEvent(req, res, admin, eventMatch[1]);
      if (eventMatch && req.method === 'DELETE') return deleteAdminEvent(res, admin, eventMatch[1]);
      if (url.pathname.startsWith('/api/v1/admin/users')) {
        if (!admin.is_super_admin) return json(res, 403, { error: 'Alleen een hoofdbeheerder kan gebruikers beheren.' });
        if (req.method === 'GET' && url.pathname === '/api/v1/admin/users') return listAdminUsers(res);
        if (req.method === 'POST' && url.pathname === '/api/v1/admin/users') return createAdminUserRecord(res, await body(req));
        const userMatch = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (userMatch && req.method === 'PUT') return updateAdminUser(req, res, admin, userMatch[1]);
      }
      return json(res, 404, { error: 'admin_route_not_found' });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/config') return json(res, 200, { turnstile: { enabled: Boolean(config.turnstile.secretKey), siteKey: config.turnstile.siteKey } });
    if (req.method === 'GET' && url.pathname === '/api/v1/resources') return resources(res);
    if (req.method === 'GET' && url.pathname === '/api/v1/agenda') return agenda(url, res);
    if (req.method === 'GET' && url.pathname === '/api/v1/calendar.ics') return eventCalendar(res);
    if (req.method === 'GET' && url.pathname === '/api/v1/availability') return availability(url, res);
    if (req.method === 'POST' && url.pathname === '/api/v1/event-requests') return createEventRequest(req, res);
    if (req.method === 'POST' && url.pathname === '/api/v1/reservations') return createReservation(req, res);
    if (req.method === 'POST' && url.pathname === '/webhooks/telegram') return telegramWebhook(req, res);
    if (req.method === 'POST' && url.pathname === '/webhooks/microsoft-graph') return graphWebhook(req, res, url);
    json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    const known = {
      payload_too_large: [413, 'De invoer is te groot.'],
      invalid_admin_event: [422, 'Controleer de titel, ruimte en begin- en eindtijd.'],
      invalid_logo_url: [422, 'Gebruik voor het logo een geldige HTTPS-URL of een lokaal pad.'],
      resource_not_found: [404, 'Ruimte niet gevonden.'],
      event_conflict: [409, 'Deze ruimte is in de gekozen periode al bezet.'],
      municipal_source_unavailable: [502, 'De evenementenkalender van De Fryske Marren is tijdelijk niet bereikbaar.']
    };
    const [status, message] = known[error.message] || [500, 'Er ging iets mis. Probeer het later opnieuw.'];
    json(res, status, { error: message });
  }
});

await migrate();
server.listen(config.port, '0.0.0.0', () => console.log(`Sint Jut agenda API luistert op ${config.port}`));
