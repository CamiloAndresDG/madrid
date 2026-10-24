const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const compression = require('compression');
const { db, tx, init } = require('./db');
const L = require('./logic');
const A = require('./auth');
const T = require('./teams');
const Audit = require('./audit');
const F = require('./forum');
const N = require('./notify');
const W = require('./weather');
const R = require('./roster');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(compression());

// index.html con versión en los enlaces a CSS/JS: cada despliegue cambia la URL y el navegador
// no puede quedarse con una copia antigua (Render expone el commit en RENDER_GIT_COMMIT)
const ASSET_V = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replaceAll('__V__', ASSET_V);
const sendIndex = (_req, res) => res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);
app.get(['/', '/index.html'], sendIndex);
// Versión desplegada: la web abierta la consulta para saber si hay una nueva
app.get('/api/version', (_req, res) => res.set('Cache-Control', 'no-store').json({ v: ASSET_V }));
app.use(express.json({ limit: '25mb' })); // el foro envía fotos (ya reducidas en el navegador)
// Estáticos: HTML, CSS y JS se revalidan siempre (ETag: si no ha cambiado, respuesta 304 vacía),
// así cada despliegue se ve al momento. Las imágenes del sitio se cachean un día.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, file) {
    res.setHeader('Cache-Control', /\.(png|jpe?g|webp|svg|ico)$/.test(file) ? 'public, max-age=86400' : 'no-cache');
  },
}));

// ---------- Utilidades ----------

const nowIso = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => { if (out !== undefined) res.json(out); })
    .catch(next);
};
const mw = (fn) => (req, res, next) => { Promise.resolve(fn(req, res)).then(() => next(), next); };

// Token de sesión en la cabecera Authorization: "Bearer <token>"
function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// Cualquier jugador con sesión iniciada (req.player, req.roles)
const requirePlayer = mw(async (req) => {
  req.player = await A.sessionPlayer(bearer(req));
  if (!req.player) throw new HttpError(401, 'Inicia sesión para continuar');
  req.roles = req.player.roles;
});

// Foro: con sesión, siempre; sin sesión, solo si Coordinación lo ha abierto al público
const requireForumReader = mw(async (req) => {
  req.player = await A.sessionPlayer(bearer(req));
  if (req.player) { req.roles = req.player.roles; return; }
  if (!(await F.isPublic())) throw new HttpError(401, 'Inicia sesión para continuar');
});

// Jugador con sesión y al menos uno de los roles indicados (el coordinador siempre entra)
const requireRole = (...allowed) => mw(async (req) => {
  req.player = await A.sessionPlayer(bearer(req));
  if (!req.player) throw new HttpError(401, 'Inicia sesión para continuar');
  req.roles = req.player.roles;
  const ok = req.roles.includes('coordinador') || req.roles.some((r) => allowed.includes(r));
  if (!ok) throw new HttpError(403, 'Tu cuenta no tiene permiso para esta sección');
});

// Lectura compartida: jugadores y coordinación (req.admin = puede gestionar)
const requireAny = requirePlayer;

async function sessionOr404(id) {
  const s = Number.isInteger(Number(id)) ? await L.getSession(Number(id)) : null;
  if (!s) throw new HttpError(404, 'Entrenamiento no encontrado');
  return s;
}

function publicSession(s) {
  const t = L.sessionTimes(s);
  const now = new Date();
  return {
    ...s,
    cancelled: !!s.cancelled,
    opens_at: t.opensAt.toISOString(),
    list_day: t.listDay,
    tuesday_deadline: t.tuesdayDeadline.toISOString(),
    wednesday_deadline: t.wednesdayDeadline.toISOString(),
    starts_at: t.startsAt.toISOString(),
    is_published: !!s.published_at,
    is_open: !!s.published_at && now >= t.opensAt && now < t.startsAt && !s.cancelled,
    has_started: now >= t.startsAt,
    is_past: now >= t.endsAt,
  };
}

// Material y quién lo tiene ahora: las personas de la última entrega de cada cosa (pueden ser varias)
async function equipmentHolders({ includeInactive = false } = {}) {
  const items = await db.all(`SELECT e.id, e.name, e.active, a.batch, a.assigned_at, a.assigned_by,
      b.name AS assigned_by_name, a.session_id, a.note
    FROM equipment e
    LEFT JOIN LATERAL (SELECT * FROM equipment_assignments x WHERE x.equipment_id = e.id
      ORDER BY x.assigned_at DESC, x.id DESC LIMIT 1) a ON true
    LEFT JOIN players b ON b.id = a.assigned_by
    ${includeInactive ? '' : 'WHERE e.active = 1'} ORDER BY e.name`);
  const batches = items.map((i) => i.batch).filter(Boolean);
  const rows = batches.length ? await db.all(`SELECT a.batch, a.holder_id, p.name FROM equipment_assignments a
    JOIN players p ON p.id = a.holder_id WHERE a.batch = ANY($1::text[]) ORDER BY p.name`, [batches]) : [];
  for (const i of items) {
    i.holders = rows.filter((r) => r.batch === i.batch).map((r) => ({ id: r.holder_id, name: r.name }));
    i.holder_names = i.holders.map((h) => h.name);
  }
  return items;
}

const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`);

async function listPayload(session, ctx) {
  const list = await L.computeList(session, ctx);
  const noes = await db.all(`
    SELECT r.player_id, p.name, r.cancel_reason, r.updated_at FROM responses r JOIN players p ON p.id = r.player_id
    WHERE r.session_id = $1 AND r.answer = 'no' ORDER BY p.name`, [session.id]);
  const titulares = list.entries.filter((e) => e.role === 'titular');
  const cambios = list.entries.filter((e) => e.role === 'cambio');
  return {
    session: publicSession(session),
    previous: list.previous ? { id: list.previous.id, date: list.previous.date } : null,
    titulares,
    cambios,
    reservas: list.entries.filter((e) => e.role === 'reserva'),
    no_van: noes,
    // Formato según los apuntados: faltan / 7 contra 7 / 8 contra 8 / triangular
    format: { ...list.format, cutoff: list.cutoff, min: L.MIN_PLAYERS, full: L.FULL_MATCH, triangular_at: L.TRIANGULAR_AT },
    equipment: await equipmentHolders(),
    weather: await W.forecast(session.date, session.start_time),
    // Equipos provisionales: se recalculan con cada inscripción según las estadísticas
    teams_proposal: T.propose([...titulares, ...cambios], await L.seasonStats()),
  };
}

// Próxima convocatoria publicada (los borradores solo los ve coordinación)
function currentSession() {
  return db.get(`SELECT * FROM sessions WHERE cancelled = 0 AND published_at IS NOT NULL AND date >= $1
    ORDER BY date LIMIT 1`, [L.todayMadrid()]);
}

async function sessionFlags(s) {
  const r = await db.get(`SELECT
    (SELECT COUNT(*)::int FROM responses WHERE session_id = $1 AND answer = 'yes') AS yes_count,
    EXISTS (SELECT 1 FROM attendance WHERE session_id = $1) AS attendance_taken,
    EXISTS (SELECT 1 FROM matches WHERE session_id = $1) AS has_results`, [s.id]);
  return { ...publicSession(s), ...r };
}

function whatsappText(payload) {
  const s = payload.session;
  const [y, m, d] = s.date.split('-');
  const lines = [
    `⚽ *Entrenamiento Fútbol 7* — miércoles ${d}/${m}/${y} · ${s.start_time}`,
    `📍 ${s.location} (llegad a las ${s.arrival_time || '21:45'})`,
  ];
  const w = payload.weather;
  if (w) {
    lines.push(`${w.icon} ${w.label}, ${w.temp}°C a las ${w.hour}${w.rain_prob != null ? ` · ${w.rain_prob}% de lluvia` : ''}`);
    if (w.joke) lines.push(`☔ ${w.joke}`);
  }
  lines.push('',
    `*Formato:* ${payload.format.label}${payload.format.next && payload.format.next.missing > 0 ? ` (faltan ${payload.format.next.missing} para ${payload.format.next.label})` : ''}`,
    '',
    `*CONVOCADOS (${payload.titulares.length})*`,
    ...payload.titulares.map((e) => `${e.position}. ${e.name}`));
  if (payload.cambios.length) lines.push('', '*CAMBIOS*', ...payload.cambios.map((e) => `${e.position}. ${e.name}`));
  if (payload.reservas.length) {
    lines.push('', '*RESERVAS*', ...payload.reservas.map((e) => `${e.position}. ${e.name}`));
  }
  const kit = (payload.equipment || []).filter((e) => e.holder_names.length);
  if (kit.length) lines.push('', ...kit.map((e) => `🎒 ${e.name}: ${listNames(e.holder_names)}`));
  const tp = payload.teams_proposal;
  if (tp) {
    lines.push('', `*EQUIPOS* (${tp.description})`, ...tp.teams.map((t) => `${t.name}: ${t.players.map((p) => p.name).join(', ')}`));
  }
  lines.push('', 'Recordad: no borrarse después de las 15h del martes sin motivo justificado.');
  return lines.join('\n');
}

async function resultsPayload(sessionId) {
  const teams = await db.all('SELECT * FROM teams WHERE session_id = $1 ORDER BY id', [sessionId]);
  for (const t of teams) {
    t.players = await db.all(`SELECT p.id, p.name FROM team_players tp JOIN players p ON p.id = tp.player_id
      WHERE tp.team_id = $1 ORDER BY p.name`, [t.id]);
  }
  const matches = await db.all('SELECT * FROM matches WHERE session_id = $1 ORDER BY id', [sessionId]);
  const stats = await db.all(`SELECT ps.*, p.name FROM player_stats ps JOIN players p ON p.id = ps.player_id
    WHERE ps.session_id = $1 ORDER BY ps.goals DESC, ps.assists DESC, p.name`, [sessionId]);
  // Tabla del día por equipo
  const table = teams.map((t) => ({ team_id: t.id, name: t.name, color: t.color, pj: 0, w: 0, d: 0, l: 0, gf: 0, gc: 0, pts: 0 }));
  const byId = new Map(table.map((r) => [r.team_id, r]));
  for (const m of matches) {
    const h = byId.get(m.home_team_id), a = byId.get(m.away_team_id);
    if (!h || !a) continue;
    h.pj++; a.pj++; h.gf += m.home_goals; h.gc += m.away_goals; a.gf += m.away_goals; a.gc += m.home_goals;
    if (m.home_goals > m.away_goals) { h.w++; h.pts += 3; a.l++; }
    else if (m.home_goals < m.away_goals) { a.w++; a.pts += 3; h.l++; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  table.sort((x, y) => y.pts - x.pts || (y.gf - y.gc) - (x.gf - x.gc) || y.gf - x.gf);
  const notes = (await db.get('SELECT results_notes FROM sessions WHERE id = $1', [sessionId]))?.results_notes || '';
  return { teams, matches, stats, table, notes };
}

// ---------- API: jugador ----------

app.get('/api/me', requirePlayer, wrap(async (req) => {
  const p = req.player;
  const s = await currentSession();
  const counts = await L.seriousCounts();
  const infractions = await db.all(`SELECT i.id, i.type, i.status, i.note, s.date FROM infractions i JOIN sessions s ON s.id = i.session_id
    WHERE i.player_id = $1 ORDER BY s.date DESC`, [p.id]);
  const out = {
    player: {
      id: p.id, name: p.name, first_name: p.first_name, last_name: p.last_name, email: p.email, phone: p.phone,
      active: !!p.active, roles: req.roles, is_coordinator: req.roles.includes('coordinador'),
      can_manage: A.canManage(req.roles),
    },
    expelled: (counts.get(p.id) || 0) >= L.SERIOUS_LIMIT,
    serious_infractions: counts.get(p.id) || 0,
    infractions: infractions.map((i) => ({ ...i, label: L.INFRACTION_TYPES[i.type]?.label || i.type, weeks: L.INFRACTION_TYPES[i.type]?.weeks })),
    session: null,
    notifications: await N.unread(p.id),
  };
  if (s) {
    const payload = await listPayload(s, L.newCtx());
    const resp = await db.get('SELECT * FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, p.id]);
    const mine = [...payload.titulares, ...payload.cambios, ...payload.reservas].find((e) => e.player_id === p.id) || null;
    out.session = { ...payload, my_response: resp ? resp.answer : null, my_entry: mine };
  }
  return out;
}));

app.post('/api/notifications/read', requirePlayer, wrap(async (req) => {
  await N.markRead(req.player.id, req.body?.ids || null);
  return { ok: true };
}));

app.put('/api/sessions/:id/response', requirePlayer, wrap(async (req) => {
  const p = req.player;
  const s = await sessionOr404(req.params.id);
  if (!s.published_at) throw new HttpError(404, 'Entrenamiento no encontrado');
  const { answer, notified = false, reason = '' } = req.body || {};
  if (!['yes', 'no'].includes(answer)) throw new HttpError(400, 'Respuesta no válida');
  if (s.cancelled) throw new HttpError(400, 'Este entrenamiento está cancelado');
  const t = L.sessionTimes(s);
  const now = new Date();
  if (now >= t.startsAt) throw new HttpError(400, 'El entrenamiento ya ha empezado');

  const existing = await db.get('SELECT * FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, p.id]);
  let infraction = null;
  const before = await N.snapshot(s.id);

  if (answer === 'yes') {
    if (!p.active) throw new HttpError(403, 'Tu inscripción no está activa. Habla con Coordinación.');
    if (await L.isExpelled(p.id)) throw new HttpError(403, 'Tienes dos faltas graves esta temporada. Habla con Coordinación.');
    if (now < t.opensAt) throw new HttpError(400, 'Las inscripciones todavía no están abiertas');
    if (existing?.answer === 'yes') return { ok: true };
    await db.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at)
      VALUES ($1, $2, 'yes', $3, $3)
      ON CONFLICT (session_id, player_id) DO UPDATE SET answer = 'yes', signed_up_at = excluded.signed_up_at,
        updated_at = excluded.updated_at, cancel_reason = NULL, cancel_notified = NULL, locked_rank = NULL, locked_priority = NULL, added_by_admin = 0,
        called_up = 0, called_up_by = NULL, called_up_at = NULL`,
    [s.id, p.id, nowIso()]);
  } else {
    let type = null, note = null;
    if (existing?.answer === 'yes') {
      const entry = (await L.computeList(s)).entries.find((e) => e.player_id === p.id);
      type = L.cancellationInfraction(s, { role: entry?.role, notified: !!notified, now });
      note = [reason && `Motivo: ${reason}`, notified ? 'Dice que avisó al coordinador' : 'No avisó al coordinador',
        entry && `Estaba ${entry.role === 'reserva' ? 'en reservas' : entry.role === 'cambio' ? 'convocado como cambio' : 'convocado'} (puesto ${entry.position})`]
        .filter(Boolean).join(' · ');
    }
    await tx(async (c) => {
      if (type) {
        await c.run(`INSERT INTO infractions (session_id, player_id, type, status, source, note) VALUES ($1, $2, $3, 'pending', 'auto', $4)`,
          [s.id, p.id, type, note]);
        infraction = { type, label: L.INFRACTION_TYPES[type].label };
      }
      await c.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at, cancel_reason, cancel_notified)
        VALUES ($1, $2, 'no', NULL, $3, $4, $5)
        ON CONFLICT (session_id, player_id) DO UPDATE SET answer = 'no', signed_up_at = NULL, updated_at = excluded.updated_at,
          cancel_reason = excluded.cancel_reason, cancel_notified = excluded.cancel_notified, locked_rank = NULL, locked_priority = NULL,
          called_up = 0, called_up_by = NULL, called_up_at = NULL`,
      [s.id, p.id, nowIso(), reason || null, notified ? 1 : 0]);
    });
  }
  await N.notifyChanges(db, before, await N.snapshot(s.id), { skip: p.id });
  return { ok: true, infraction };
}));

// ---------- API: compartida (jugadores y coordinación) ----------

// Un borrador solo lo ve coordinación
async function visibleSessionOr404(req, id) {
  const s = await sessionOr404(id);
  if (!s.published_at && !A.canManage(req.roles)) throw new HttpError(404, 'Entrenamiento no encontrado');
  return s;
}

app.get('/api/sessions/:id/list', requireAny, wrap(async (req) => listPayload(await visibleSessionOr404(req, req.params.id), L.newCtx())));

app.get('/api/sessions', requireAny, wrap(async (req) => {
  const all = A.canManage(req.roles);
  const sessions = await db.all(`SELECT * FROM sessions ${all ? '' : 'WHERE published_at IS NOT NULL'} ORDER BY date DESC`);
  return Promise.all(sessions.map(sessionFlags));
}));

app.get('/api/sessions/:id/results', requireAny, wrap(async (req) => {
  const s = await visibleSessionOr404(req, req.params.id);
  return { session: publicSession(s), ...(await resultsPayload(s.id)) };
}));

app.get('/api/stats', requireAny, wrap(async (req) => ({
  min_per_quarter: L.MIN_ATTENDANCE_PER_QUARTER,
  players: (await L.seasonStats()).filter((p) => p.active || A.canManage(req.roles)),
})));

// Panel de temporada: el del grupo y el del jugador que pregunta
app.get('/api/dashboard', requirePlayer, wrap(async (req) => L.dashboard(req.player.id)));

// ---------- Foro ----------

app.get('/api/posts', requireForumReader, wrap(async (req) => F.list({
  category: req.query.category || null, limit: req.query.limit, before: req.query.before || null,
})));

// ¿Lo puede leer quien no tiene cuenta? (la web lo consulta al cargar, para pintar el menú)
app.get('/api/forum/access', wrap(async () => ({ public: await F.isPublic() })));

// Fotos: el id es aleatorio y no adivinable, así que se pueden mostrar en <img> sin sesión.
// No cambian nunca: caché larga.
app.get('/api/images/:id', wrap(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) throw new HttpError(404, 'Foto no encontrada');
  const img = await db.get('SELECT mime, data FROM post_images WHERE id = $1', [req.params.id]);
  if (!img) throw new HttpError(404, 'Foto no encontrada');
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(img.data);
}));

// Material: quién se lleva cada cosa (lo ve todo el equipo)
app.get('/api/equipment', requirePlayer, wrap(async () => equipmentHolders()));

app.get('/api/rules', wrap(() => ({ infraction_types: L.INFRACTION_TYPES, attendance_statuses: L.ATTENDANCE_STATUSES })));

// ---------- API: cuentas ----------

const sessionReply = async (playerId) => {
  const { token, expires_at } = await A.createSession(playerId);
  const me = await A.sessionPlayer(token);
  return { token, expires_at, player: { id: me.id, name: me.name, roles: me.roles } };
};

app.post('/api/auth/register', wrap(async (req) => {
  const id = await A.register(req.body || {});
  return sessionReply(id);
}));

app.post('/api/auth/login', wrap(async (req) => {
  const id = await A.login(req.body?.email, req.body?.password);
  return sessionReply(id);
}));

app.post('/api/auth/logout', wrap(async (req) => {
  await A.deleteSession(bearer(req));
  return { ok: true };
}));

app.patch('/api/me/profile', requirePlayer, wrap(async (req) => {
  await A.updateProfile(req.player.id, req.body || {});
  return { ok: true };
}));
app.post('/api/me/password', requirePlayer, wrap(async (req) => {
  await A.changePassword(req.player.id, req.body?.current, req.body?.next, bearer(req));
  return { ok: true };
}));
app.post('/api/auth/logout-all', requirePlayer, wrap(async (req) => {
  await A.deleteAllSessions(req.player.id);
  return { ok: true };
}));

app.get('/api/roles', wrap(async () => db.all('SELECT code, label, description FROM roles ORDER BY code')));

// ---------- API: coordinación ----------
// Cada cambio queda en audit_log con quién lo hizo y cuándo.

const admin = express.Router();
// Coordinadores y gestores: convocatorias, asistencia, resultados, material e incidencias
admin.use(requireRole('gestor'));

const dm = (date) => { const [, m, d] = String(date).split('-'); return `${d}/${m}`; };
const nameOf = async (runner, id) => (id ? (await runner.get('SELECT name FROM players WHERE id = $1', [id]))?.name || `#${id}` : null);
const madridDateTime = (iso) => new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(iso));

admin.get('/overview', wrap(async () => {
  const sessions = await Promise.all((await db.all('SELECT * FROM sessions ORDER BY date DESC')).map(sessionFlags));
  const next = await db.get('SELECT id FROM sessions WHERE cancelled = 0 AND date >= $1 ORDER BY date LIMIT 1', [L.todayMadrid()]);
  return {
    sessions,
    current_id: next?.id || null,
    next_wednesday: L.nextWednesday(),
    pending_infractions: (await db.get(`SELECT COUNT(*)::int c FROM infractions WHERE status = 'pending'`)).c,
  };
}));

// Registro de actividad
admin.get('/audit', wrap(async (req) => Audit.list({
  entity: req.query.entity || null, sessionId: Number(req.query.session_id) || null, limit: req.query.limit,
})));

// Jugadores (las cuentas las crean los propios jugadores al registrarse)
admin.get('/players', wrap(async () => {
  const counts = await L.seriousCounts();
  const rows = await db.all(`SELECT p.id, p.name, p.first_name, p.last_name, p.email, p.phone, p.active,
      p.attendance_exempt, p.exempt_note, p.last_login_at,
      COALESCE(array_agg(pr.role_code ORDER BY pr.role_code) FILTER (WHERE pr.role_code IS NOT NULL), '{}') AS roles
    FROM players p LEFT JOIN player_roles pr ON pr.player_id = p.id
    GROUP BY p.id ORDER BY p.active DESC, p.name`);
  return rows.map((p) => ({
    ...p, serious_infractions: counts.get(p.id) || 0, expelled: (counts.get(p.id) || 0) >= L.SERIOUS_LIMIT,
  }));
}));
admin.patch('/players/:id', wrap(async (req) => {
  const pid = Number(req.params.id);
  const name = await nameOf(db, pid);
  if (!name) throw new HttpError(404, 'Jugador no encontrado');
  const said = [];
  await tx(async (c) => {
    for (const f of ['active', 'attendance_exempt', 'exempt_note']) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      await c.run(`UPDATE players SET ${f} = $1 WHERE id = $2`, [v, pid]);
      if (f === 'active') said.push(v ? `reactivó a ${name}` : `dio de baja a ${name}`);
      if (f === 'attendance_exempt') said.push(v ? `eximió a ${name} del mínimo de asistencia` : `quitó la exención de asistencia a ${name}`);
      if (f === 'exempt_note') said.push(`anotó el motivo de exención de ${name}`);
    }
    for (const summary of said) await Audit.audit(c, req.player, { action: 'player.update', entity: 'player', entityId: pid, summary });
  });
  return { ok: true };
}));
// Solo coordinación cambia los roles (coordinador, gestor, petos, balones…)
admin.put('/players/:id/roles', requireRole(), wrap(async (req) => {
  const pid = Number(req.params.id);
  const before = await A.rolesOf(pid);
  await A.setRoles(pid, Array.isArray(req.body?.roles) ? req.body.roles : []);
  const after = await A.rolesOf(pid);
  const added = after.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !after.includes(r));
  if (added.length || removed.length) {
    const name = await nameOf(db, pid);
    const parts = [added.length && `le dio ${added.join(', ')}`, removed.length && `le quitó ${removed.join(', ')}`].filter(Boolean);
    await Audit.audit(null, req.player, { action: 'player.roles', entity: 'player', entityId: pid, summary: `cambió los roles de ${name}: ${parts.join(' y ')}` });
  }
  return { ok: true, roles: after };
}));

// ---------- Convocatorias ----------

const SESSION_FIELDS = {
  date: 'fecha', start_time: 'hora', arrival_time: 'llegada', location: 'lugar', capacity: 'plazas',
  notes: 'notas', opens_at: 'apertura de inscripciones', cancelled: 'cancelado',
};

function cleanSessionInput(body, { partial = true } = {}) {
  const out = {};
  const has = (k) => k in body;
  if (!partial || has('date')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) throw new HttpError(400, 'Fecha no válida');
    out.date = body.date;
  }
  for (const k of ['start_time', 'arrival_time']) {
    if (has(k)) {
      if (!/^\d{2}:\d{2}$/.test(body[k] || '')) throw new HttpError(400, `Hora no válida (${SESSION_FIELDS[k]})`);
      out[k] = body[k];
    }
  }
  if (has('location')) {
    const loc = String(body.location || '').trim();
    if (!loc) throw new HttpError(400, 'Falta el lugar');
    out.location = loc;
  }
  if (has('capacity')) {
    const cap = Number(body.capacity);
    if (!Number.isInteger(cap) || cap < 2 || cap > 40) throw new HttpError(400, 'Plazas no válidas (2 a 40)');
    out.capacity = cap;
  }
  if (has('notes')) out.notes = String(body.notes || '').trim() || null;
  if (has('opens_at')) {
    if (body.opens_at && Number.isNaN(Date.parse(body.opens_at))) throw new HttpError(400, 'Fecha de apertura no válida');
    out.opens_at = body.opens_at ? new Date(body.opens_at).toISOString() : null;
  }
  if (has('cancelled')) out.cancelled = body.cancelled ? 1 : 0;
  return out;
}

const describe = (k, v) => {
  if (v == null || v === '') return '—';
  if (k === 'opens_at') return madridDateTime(v);
  if (k === 'cancelled') return v ? 'sí' : 'no';
  if (k === 'date') return dm(v);
  return String(v);
};

admin.post('/sessions', wrap(async (req) => {
  const body = req.body || {};
  const input = cleanSessionInput({ capacity: 16, start_time: '22:00', arrival_time: '21:45', ...body }, { partial: false });
  if (await db.get('SELECT 1 FROM sessions WHERE date = $1', [input.date])) throw new HttpError(400, 'Ya hay un entrenamiento ese día');
  const now = nowIso();
  const publish = !!body.publish;
  const openNow = publish && !!body.open_now;
  const id = await tx(async (c) => {
    const r = await c.get(`INSERT INTO sessions (date, capacity, start_time, arrival_time, location, notes, opens_at, published_at, created_by, updated_at)
      VALUES ($1, $2, $3, $4, COALESCE($5, 'Polideportivo Marqués de Samaranch'), $6, $7, $8, $9, $10) RETURNING *`,
    [input.date, input.capacity, input.start_time, input.arrival_time, input.location || null, input.notes || null,
      openNow ? now : (input.opens_at || null), publish ? now : null, req.player.id, now]);
    const opens = L.sessionTimes(r).opensAt.toISOString();
    const state = !publish ? 'como borrador' : openNow ? 'y la publicó con las inscripciones abiertas' : `y la publicó (inscripciones desde ${madridDateTime(opens)})`;
    await Audit.audit(c, req.player, { action: 'session.create', entity: 'session', entityId: r.id, sessionId: r.id,
      summary: `creó la convocatoria del ${dm(r.date)} ${r.start_time} en ${r.location} (${r.capacity} plazas) ${state}` });
    return r.id;
  });
  return { id };
}));

admin.get('/sessions/:id', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const payload = await listPayload(s, L.newCtx());
  const answered = new Set((await db.all('SELECT player_id FROM responses WHERE session_id = $1', [s.id])).map((r) => r.player_id));
  return {
    ...payload,
    whatsapp: whatsappText(payload),
    created_by_name: await nameOf(db, s.created_by),
    sin_responder: (await db.all('SELECT id, name FROM players WHERE active = 1 ORDER BY name')).filter((p) => !answered.has(p.id)),
    attendance: await db.all('SELECT player_id, status FROM attendance WHERE session_id = $1', [s.id]),
    infractions: await db.all(`SELECT i.*, p.name FROM infractions i JOIN players p ON p.id = i.player_id
      WHERE i.session_id = $1 ORDER BY i.created_at`, [s.id]),
    results: await resultsPayload(s.id),
    activity: await Audit.list({ sessionId: s.id, limit: 50 }),
  };
}));

admin.patch('/sessions/:id', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const input = cleanSessionInput(req.body || {});
  if (input.date && input.date !== s.date && await db.get('SELECT 1 FROM sessions WHERE date = $1', [input.date])) {
    throw new HttpError(400, 'Ya hay un entrenamiento ese día');
  }
  const changes = Object.entries(input).filter(([k, v]) => (s[k] ?? null) !== (v ?? null));
  if (!changes.length) return { ok: true };
  const before = await N.snapshot(s.id);
  await tx(async (c) => {
    for (const [k, v] of changes) await c.run(`UPDATE sessions SET ${k} = $1 WHERE id = $2`, [v, s.id]);
    await c.run('UPDATE sessions SET updated_at = $1 WHERE id = $2', [nowIso(), s.id]);
    const summary = changes.length === 1 && changes[0][0] === 'cancelled'
      ? `${changes[0][1] ? 'canceló' : 'reactivó'} el entrenamiento del ${dm(s.date)}`
      : `cambió la convocatoria del ${dm(s.date)}: ${changes.map(([k, v]) => `${SESSION_FIELDS[k]} ${describe(k, s[k])} → ${describe(k, v)}`).join('; ')}`;
    await Audit.audit(c, req.player, { action: 'session.update', entity: 'session', entityId: s.id, sessionId: s.id, summary });
  });
  if (changes.some(([k]) => k === 'capacity')) await N.notifyChanges(db, before, await N.snapshot(s.id));
  return { ok: true };
}));

// Publicar: desde ese momento la ven los jugadores. open_now abre ya las inscripciones.
admin.post('/sessions/:id/publish', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const now = nowIso();
  const openNow = !!req.body?.open_now;
  await tx(async (c) => {
    await c.run('UPDATE sessions SET published_at = COALESCE(published_at, $1), opens_at = CASE WHEN $2 THEN $1 ELSE opens_at END, updated_at = $1 WHERE id = $3',
      [now, openNow, s.id]);
    const fresh = await c.get('SELECT * FROM sessions WHERE id = $1', [s.id]);
    const opens = L.sessionTimes(fresh).opensAt;
    await Audit.audit(c, req.player, { action: 'session.publish', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: openNow || opens <= new Date()
        ? `publicó la convocatoria del ${dm(s.date)} con las inscripciones abiertas`
        : `publicó la convocatoria del ${dm(s.date)} (inscripciones desde ${madridDateTime(opens.toISOString())})` });
  });
  return { ok: true };
}));
admin.post('/sessions/:id/unpublish', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const yes = (await db.get(`SELECT COUNT(*)::int n FROM responses WHERE session_id = $1 AND answer = 'yes'`, [s.id])).n;
  if (yes) throw new HttpError(409, `No se puede volver a borrador: ya hay ${yes} persona(s) apuntada(s). Cancela el entrenamiento si no se juega.`);
  await tx(async (c) => {
    await c.run('UPDATE sessions SET published_at = NULL, updated_at = $1 WHERE id = $2', [nowIso(), s.id]);
    await Audit.audit(c, req.player, { action: 'session.unpublish', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: `pasó a borrador la convocatoria del ${dm(s.date)}` });
  });
  return { ok: true };
}));

admin.delete('/sessions/:id', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  await tx(async (c) => {
    await Audit.audit(c, req.player, { action: 'session.delete', entity: 'session', entityId: s.id,
      summary: `eliminó el entrenamiento del ${dm(s.date)} y todos sus datos` });
    await c.run('DELETE FROM sessions WHERE id = $1', [s.id]);
  });
  return { ok: true };
}));

// Lista final: congela el orden por prioridad + hora de inscripción
admin.post('/sessions/:id/finalize', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const list = await L.computeList({ ...s, finalized_at: null });
  await tx(async (c) => {
    await c.run('UPDATE responses SET locked_rank = NULL, locked_priority = NULL WHERE session_id = $1', [s.id]);
    for (const e of list.entries) {
      await c.run('UPDATE responses SET locked_rank = $1, locked_priority = $2 WHERE session_id = $3 AND player_id = $4',
        [e.position, e.priority, s.id, e.player_id]);
    }
    await c.run('UPDATE sessions SET finalized_at = $1 WHERE id = $2', [nowIso(), s.id]);
    const conv = list.entries.filter((e) => e.role !== 'reserva').length;
    await Audit.audit(c, req.player, { action: 'session.finalize', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: `cerró la lista del ${dm(s.date)} (${list.format.label.toLowerCase()}): ${conv} convocados y ${list.entries.length - conv} reservas` });
  });
  const payload = await listPayload(await L.getSession(s.id), L.newCtx());
  return { ok: true, whatsapp: whatsappText(payload) };
}));
admin.post('/sessions/:id/unfinalize', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  await tx(async (c) => {
    await c.run('UPDATE sessions SET finalized_at = NULL WHERE id = $1', [s.id]);
    await c.run('UPDATE responses SET locked_rank = NULL, locked_priority = NULL WHERE session_id = $1', [s.id]);
    await Audit.audit(c, req.player, { action: 'session.unfinalize', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: `volvió a lista provisional la convocatoria del ${dm(s.date)}` });
  });
  return { ok: true };
}));

// Convocar a una reserva como cambio (o quitarla de cambios). Se le avisa.
admin.put('/sessions/:id/responses/:playerId/callup', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const pid = Number(req.params.playerId);
  const on = !!req.body?.on;
  const entry = (await L.computeList(s)).entries.find((e) => e.player_id === pid);
  if (!entry) throw new HttpError(400, 'Esa persona no está apuntada a este entreno');
  if (on && entry.role === 'titular') throw new HttpError(400, `${entry.name} ya está convocado`);
  if (on === entry.called_up) return { ok: true };
  const before = await N.snapshot(s.id);
  await tx(async (c) => {
    await c.run('UPDATE responses SET called_up = $1, called_up_by = $2, called_up_at = $3 WHERE session_id = $4 AND player_id = $5',
      [on ? 1 : 0, on ? req.player.id : null, on ? nowIso() : null, s.id, pid]);
    await Audit.audit(c, req.player, { action: on ? 'response.callup' : 'response.uncall', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: on ? `convocó a ${entry.name} como cambio para el ${dm(s.date)}` : `quitó a ${entry.name} de los cambios del ${dm(s.date)}` });
  });
  await N.notifyChanges(db, before, await N.snapshot(s.id));
  return { ok: true };
}));

// Lista pegada desde WhatsApp: primero se revisa (a quién corresponde cada línea)…
admin.post('/sessions/:id/roster/preview', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const players = await db.all('SELECT id, name, first_name, active FROM players WHERE active = 1 ORDER BY name');
  const lines = R.preview(req.body?.text, players);
  const inList = new Set((await L.computeList(s)).entries.map((e) => e.player_id));
  return { lines: lines.map((l) => ({ ...l, in_list: !!(l.player_id && inList.has(l.player_id)) })), in_list_count: inList.size };
}));

// …y después se apunta a todos en el orden de la lista. Quien no tenga ficha se crea (sin cuenta).
// Con replace, quien estaba apuntado y ya no aparece en la lista pasa a «No van».
admin.post('/sessions/:id/roster', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 60) : [];
  if (!items.length) throw new HttpError(400, 'La lista está vacía');
  const replace = !!req.body?.replace;
  const result = await tx(async (c) => {
    const ids = [];
    const created = [];
    for (const it of items) {
      let pid = Number(it.player_id) || null;
      if (!pid && it.new_name) {
        const name = R.titleCase(String(it.new_name).trim().replace(/\s+/g, ' ').slice(0, 80));
        if (!name) continue;
        const [first, ...rest] = name.split(' ');
        pid = (await c.get(`INSERT INTO players (name, first_name, last_name) VALUES ($1, $2, $3) RETURNING id`,
          [name, first, rest.join(' ') || null])).id;
        created.push(name);
      }
      if (pid && !ids.includes(pid)) ids.push(pid);
    }
    const known = await c.all('SELECT id FROM players WHERE id = ANY($1::int[])', [ids]);
    if (known.length !== ids.length) throw new HttpError(400, 'Alguna de las personas elegidas no existe');
    // Hora de inscripción escalonada para respetar el orden de WhatsApp (la prioridad sigue mandando)
    const prev = await c.all(`SELECT player_id, signed_up_at FROM responses WHERE session_id = $1 AND answer = 'yes'`, [s.id]);
    const base = Math.min(Date.now(), ...prev.filter((r) => ids.includes(r.player_id) && r.signed_up_at).map((r) => Date.parse(r.signed_up_at)));
    const now = nowIso();
    for (const [i, pid] of ids.entries()) {
      await c.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at, added_by_admin)
        VALUES ($1, $2, 'yes', $3, $4, 1)
        ON CONFLICT (session_id, player_id) DO UPDATE SET answer = 'yes', signed_up_at = excluded.signed_up_at,
          updated_at = excluded.updated_at, added_by_admin = 1, cancel_reason = NULL, cancel_notified = NULL,
          locked_rank = NULL, locked_priority = NULL`,
      [s.id, pid, new Date(base + i * 1000).toISOString(), now]);
    }
    const removed = replace ? prev.filter((r) => !ids.includes(r.player_id)).map((r) => r.player_id) : [];
    if (removed.length) {
      await c.run(`UPDATE responses SET answer = 'no', updated_at = $1, called_up = 0, called_up_by = NULL, called_up_at = NULL,
        locked_rank = NULL, locked_priority = NULL WHERE session_id = $2 AND player_id = ANY($3::int[])`, [now, s.id, removed]);
    }
    const bits = [`${ids.length} en la lista`];
    if (created.length) bits.push(`${created.length === 1 ? 'nueva ficha' : 'nuevas fichas'}: ${listNames(created)}`);
    if (removed.length) bits.push(`${removed.length} ya no van`);
    await Audit.audit(c, req.player, { action: 'session.roster', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: `pasó la lista de WhatsApp del ${dm(s.date)} (${bits.join('; ')})` });
    return { added: ids.length, created, removed: removed.length };
  });
  return { ok: true, ...result };
}));

// Coordinación apunta o quita a alguien sin generar incidencias
admin.put('/sessions/:id/responses/:playerId', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const pid = Number(req.params.playerId);
  const answer = req.body?.answer;
  const name = await nameOf(db, pid);
  if (answer === null) {
    await tx(async (c) => {
      await c.run('DELETE FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, pid]);
      await Audit.audit(c, req.player, { action: 'response.clear', entity: 'session', entityId: s.id, sessionId: s.id,
        summary: `borró la respuesta de ${name} en la convocatoria del ${dm(s.date)}` });
    });
    return { ok: true };
  }
  if (!['yes', 'no'].includes(answer)) throw new HttpError(400, 'Respuesta no válida');
  const existing = await db.get('SELECT answer FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, pid]);
  if (existing?.answer === answer) return { ok: true };
  const before = await N.snapshot(s.id);
  await tx(async (c) => {
    await c.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at, added_by_admin)
      VALUES ($1, $2, $3, $4, $5, 1)
      ON CONFLICT (session_id, player_id) DO UPDATE SET answer = excluded.answer, signed_up_at = excluded.signed_up_at,
        updated_at = excluded.updated_at, added_by_admin = 1, locked_rank = NULL, locked_priority = NULL`,
    [s.id, pid, answer, answer === 'yes' ? nowIso() : null, nowIso()]);
    await Audit.audit(c, req.player, { action: answer === 'yes' ? 'response.add' : 'response.remove', entity: 'session', entityId: s.id, sessionId: s.id,
      summary: answer === 'yes' ? `apuntó a ${name} a la convocatoria del ${dm(s.date)}` : `quitó a ${name} de la convocatoria del ${dm(s.date)}` });
  });
  await N.notifyChanges(db, before, await N.snapshot(s.id));
  return { ok: true };
}));

// Asistencia: llegar tarde / no presentarse generan la incidencia correspondiente
admin.put('/sessions/:id/attendance', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  await tx(async (c) => {
    const kept = new Map((await c.all(`SELECT player_id, type, status, note FROM infractions
      WHERE session_id = $1 AND source = 'attendance'`, [s.id])).map((r) => [`${r.player_id}:${r.type}`, r]));
    await c.run('DELETE FROM attendance WHERE session_id = $1', [s.id]);
    await c.run(`DELETE FROM infractions WHERE session_id = $1 AND source = 'attendance'`, [s.id]);
    const count = {};
    for (const it of items) {
      if (!L.ATTENDANCE_STATUSES[it.status]) continue;
      count[it.status] = (count[it.status] || 0) + 1;
      await c.run('INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [s.id, Number(it.player_id), it.status]);
      const type = it.status === 'late' ? 'late_arrival' : it.status === 'no_show' ? 'no_show' : null;
      if (type) {
        const prev = kept.get(`${it.player_id}:${type}`);
        await c.run(`INSERT INTO infractions (session_id, player_id, type, status, source, note, created_by) VALUES ($1, $2, $3, $4, 'attendance', $5, $6)`,
          [s.id, Number(it.player_id), type, prev?.status || 'confirmed', prev?.note || null, req.player.id]);
      }
    }
    const parts = Object.entries(count).map(([k, n]) => `${n} ${L.ATTENDANCE_STATUSES[k].toLowerCase()}`);
    await Audit.audit(c, req.player, { action: 'attendance.save', entity: 'attendance', entityId: s.id, sessionId: s.id,
      summary: `pasó lista del ${dm(s.date)}: ${parts.join(', ') || 'sin nadie'}` });
  });
  return { ok: true };
}));

// ---------- Incidencias ----------

admin.get('/infractions', wrap(async () => {
  return (await db.all(`SELECT i.*, p.name, s.date, cb.name AS created_by_name, ub.name AS updated_by_name
    FROM infractions i
    JOIN players p ON p.id = i.player_id JOIN sessions s ON s.id = i.session_id
    LEFT JOIN players cb ON cb.id = i.created_by LEFT JOIN players ub ON ub.id = i.updated_by
    ORDER BY (i.status = 'pending') DESC, s.date DESC, i.created_at DESC`))
    .map((i) => ({ ...i, label: L.INFRACTION_TYPES[i.type]?.label || i.type, ...L.INFRACTION_TYPES[i.type] }));
}));
admin.post('/infractions', wrap(async (req) => {
  const { session_id, player_id, type, note } = req.body || {};
  const s = await sessionOr404(session_id);
  if (!L.INFRACTION_TYPES[type]) throw new HttpError(400, 'Tipo de incidencia no válido');
  const name = await nameOf(db, Number(player_id));
  if (!name) throw new HttpError(400, 'Elige un jugador');
  await tx(async (c) => {
    const r = await c.get(`INSERT INTO infractions (session_id, player_id, type, status, source, note, created_by)
      VALUES ($1, $2, $3, 'confirmed', 'manual', $4, $5) RETURNING id`, [s.id, Number(player_id), type, note || null, req.player.id]);
    await Audit.audit(c, req.player, { action: 'infraction.create', entity: 'infraction', entityId: r.id, sessionId: s.id,
      summary: `registró una incidencia a ${name} (${dm(s.date)}): ${L.INFRACTION_TYPES[type].label}` });
  });
  return { ok: true };
}));
const STATUS_VERB = { confirmed: 'confirmó', justified: 'marcó como justificada', pending: 'devolvió a pendiente' };
admin.patch('/infractions/:id', wrap(async (req) => {
  const { status, note, type } = req.body || {};
  const id = Number(req.params.id);
  const inf = await db.get(`SELECT i.*, p.name, s.date FROM infractions i JOIN players p ON p.id = i.player_id
    JOIN sessions s ON s.id = i.session_id WHERE i.id = $1`, [id]);
  if (!inf) throw new HttpError(404, 'Incidencia no encontrada');
  if (status && !['pending', 'confirmed', 'justified'].includes(status)) throw new HttpError(400, 'Estado no válido');
  if (type && !L.INFRACTION_TYPES[type]) throw new HttpError(400, 'Tipo no válido');
  const said = [];
  if (status && status !== inf.status) said.push(`${STATUS_VERB[status]} la incidencia de ${inf.name}`);
  if (type && type !== inf.type) said.push(`cambió la incidencia de ${inf.name} a «${L.INFRACTION_TYPES[type].label}»`);
  if (note !== undefined && (note || null) !== (inf.note || null)) said.push(`editó la nota de la incidencia de ${inf.name}`);
  if (!said.length) return { ok: true };
  await tx(async (c) => {
    if (status) await c.run('UPDATE infractions SET status = $1 WHERE id = $2', [status, id]);
    if (type) await c.run('UPDATE infractions SET type = $1 WHERE id = $2', [type, id]);
    if (note !== undefined) await c.run('UPDATE infractions SET note = $1 WHERE id = $2', [note || null, id]);
    await c.run('UPDATE infractions SET updated_by = $1, updated_at = $2 WHERE id = $3', [req.player.id, nowIso(), id]);
    await Audit.audit(c, req.player, { action: 'infraction.update', entity: 'infraction', entityId: id, sessionId: inf.session_id,
      summary: `${said.join('; ')} (${dm(inf.date)})` });
  });
  return { ok: true };
}));
admin.delete('/infractions/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  const inf = await db.get(`SELECT i.*, p.name, s.date FROM infractions i JOIN players p ON p.id = i.player_id
    JOIN sessions s ON s.id = i.session_id WHERE i.id = $1`, [id]);
  if (!inf) throw new HttpError(404, 'Incidencia no encontrada');
  await tx(async (c) => {
    await c.run('DELETE FROM infractions WHERE id = $1', [id]);
    await Audit.audit(c, req.player, { action: 'infraction.delete', entity: 'infraction', entityId: id, sessionId: inf.session_id,
      summary: `eliminó la incidencia de ${inf.name} (${dm(inf.date)}): ${L.INFRACTION_TYPES[inf.type]?.label || inf.type}` });
  });
  return { ok: true };
}));

// ---------- Resultados del entrenamiento: equipos, partidos y estadísticas ----------

admin.put('/sessions/:id/results', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const { teams = [], matches = [], stats = [], notes = '' } = req.body || {};
  await tx(async (c) => {
    await c.run('DELETE FROM teams WHERE session_id = $1', [s.id]); // cascada: team_players, matches
    await c.run('DELETE FROM player_stats WHERE session_id = $1', [s.id]);
    const ids = [];
    for (const t of teams) {
      const { id: tid } = await c.get('INSERT INTO teams (session_id, name, color) VALUES ($1, $2, $3) RETURNING id',
        [s.id, String(t.name || 'Equipo'), t.color || null]);
      for (const pid of new Set(t.player_ids || [])) {
        await c.run('INSERT INTO team_players (team_id, player_id) VALUES ($1, $2)', [tid, Number(pid)]);
      }
      ids.push(tid);
    }
    let played = 0;
    for (const m of matches) {
      const h = ids[m.home], a = ids[m.away];
      if (h == null || a == null || h === a) continue;
      played++;
      await c.run('INSERT INTO matches (session_id, home_team_id, away_team_id, home_goals, away_goals) VALUES ($1, $2, $3, $4, $5)',
        [s.id, h, a, Math.max(0, Number(m.home_goals) || 0), Math.max(0, Number(m.away_goals) || 0)]);
    }
    for (const st of stats) {
      const g = Number(st.goals) || 0, a = Number(st.assists) || 0, sv = Number(st.saves) || 0, mvp = st.mvp ? 1 : 0;
      if (g || a || sv || mvp) {
        await c.run('INSERT INTO player_stats (session_id, player_id, goals, assists, saves, mvp) VALUES ($1, $2, $3, $4, $5, $6)',
          [s.id, Number(st.player_id), g, a, sv, mvp]);
      }
    }
    await c.run('UPDATE sessions SET results_notes = $1 WHERE id = $2', [notes || null, s.id]);
    await Audit.audit(c, req.player, { action: 'results.save', entity: 'results', entityId: s.id, sessionId: s.id,
      summary: `guardó los resultados del ${dm(s.date)}: ${teams.length} equipos y ${played} partido(s)` });
  });
  return { ok: true };
}));

// ---------- Material: quién se lleva cada cosa ----------

admin.get('/equipment', wrap(async () => ({
  items: await equipmentHolders({ includeInactive: true }),
  history: await db.all(`SELECT a.batch, MIN(a.assigned_at) AS assigned_at, e.name AS equipment_name,
      b.name AS assigned_by_name, s.date AS session_date, MAX(a.note) AS note,
      COALESCE(array_agg(h.name ORDER BY h.name) FILTER (WHERE h.name IS NOT NULL), '{}') AS holder_names
    FROM equipment_assignments a JOIN equipment e ON e.id = a.equipment_id
    LEFT JOIN players h ON h.id = a.holder_id LEFT JOIN players b ON b.id = a.assigned_by
    LEFT JOIN sessions s ON s.id = a.session_id
    GROUP BY a.batch, e.name, b.name, s.date ORDER BY MIN(a.assigned_at) DESC LIMIT 200`),
})));
admin.post('/equipment', wrap(async (req) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, 'Escribe el nombre del material');
  if (await db.get('SELECT 1 FROM equipment WHERE lower(name) = lower($1)', [name])) throw new HttpError(409, 'Ya existe ese material');
  await tx(async (c) => {
    const r = await c.get('INSERT INTO equipment (name) VALUES ($1) RETURNING id', [name]);
    await Audit.audit(c, req.player, { action: 'equipment.create', entity: 'equipment', entityId: r.id, summary: `añadió el material «${name}»` });
  });
  return { ok: true };
}));
admin.patch('/equipment/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  const item = await db.get('SELECT * FROM equipment WHERE id = $1', [id]);
  if (!item) throw new HttpError(404, 'Material no encontrado');
  await tx(async (c) => {
    if ('name' in (req.body || {})) {
      const name = String(req.body.name || '').trim();
      if (!name) throw new HttpError(400, 'Escribe el nombre del material');
      if (name !== item.name) {
        await c.run('UPDATE equipment SET name = $1 WHERE id = $2', [name, id]);
        await Audit.audit(c, req.player, { action: 'equipment.rename', entity: 'equipment', entityId: id, summary: `renombró «${item.name}» como «${name}»` });
      }
    }
    if ('active' in (req.body || {})) {
      const active = req.body.active ? 1 : 0;
      if (active !== item.active) {
        await c.run('UPDATE equipment SET active = $1 WHERE id = $2', [active, id]);
        await Audit.audit(c, req.player, { action: 'equipment.active', entity: 'equipment', entityId: id,
          summary: active ? `volvió a activar «${item.name}»` : `retiró «${item.name}» (ya no se usa)` });
      }
    }
  });
  return { ok: true };
}));
// Asignar material al terminar el entreno: holder_ids = quiénes se lo llevan (vacío = se queda en el club).
// Varias personas pueden llevarse la misma cosa (por ejemplo, los balones).
admin.post('/equipment/:id/assign', wrap(async (req) => {
  const id = Number(req.params.id);
  const item = await db.get('SELECT * FROM equipment WHERE id = $1', [id]);
  if (!item) throw new HttpError(404, 'Material no encontrado');
  const raw = Array.isArray(req.body?.holder_ids) ? req.body.holder_ids : (req.body?.holder_id ? [req.body.holder_id] : []);
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const people = ids.length ? await db.all('SELECT id, name FROM players WHERE id = ANY($1::int[]) ORDER BY name', [ids]) : [];
  if (people.length !== ids.length) throw new HttpError(400, 'Alguna de las personas elegidas no existe');
  const sessionId = req.body?.session_id ? Number(req.body.session_id) : null;
  const s = sessionId ? await L.getSession(sessionId) : null;
  const note = String(req.body?.note || '').trim() || null;
  const batch = crypto.randomBytes(8).toString('hex');
  const at = nowIso();
  await tx(async (c) => {
    for (const holder of (people.length ? people : [null])) {
      await c.run(`INSERT INTO equipment_assignments (equipment_id, holder_id, session_id, assigned_by, assigned_at, note, batch)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, holder?.id || null, s?.id || null, req.player.id, at, note, batch]);
    }
    const after = s ? ` tras el entreno del ${dm(s.date)}` : '';
    await Audit.audit(c, req.player, { action: 'equipment.assign', entity: 'equipment', entityId: id, sessionId: s?.id || null,
      summary: people.length ? `asignó a ${listNames(people.map((x) => x.name))} los «${item.name}»${after}` : `marcó los «${item.name}» como guardados en el club${after}` });
  });
  return { ok: true };
}));

// ---------- Foro (solo Coordinación publica) ----------

// Solo coordinadores (requireRole() sin roles = solo coordinación): decide si el foro es público o solo para jugadores
admin.put('/forum/access', requireRole(), wrap(async (req) => {
  if (typeof req.body?.public !== 'boolean') throw new HttpError(400, 'Indica si el foro es público o solo para jugadores');
  const on = req.body.public;
  if (on === await F.isPublic()) return { ok: true, public: on };
  await tx(async (c) => {
    await F.setPublic(c, on);
    await Audit.audit(c, req.player, { action: 'forum.access', entity: 'forum', summary: on
      ? 'abrió el foro al público: lo puede leer cualquiera'
      : 'dejó el foro solo para jugadores con sesión iniciada' });
  });
  return { ok: true, public: on };
}));

admin.post('/posts', requireRole(), wrap(async (req) => {
  const input = F.cleanPost(req.body || {});
  const images = F.decodeImages(req.body?.images || []);
  if (images.length > F.MAX_IMAGES) throw new HttpError(400, `Máximo ${F.MAX_IMAGES} fotos por publicación`);
  if (input.category === 'fotos' && !images.length) throw new HttpError(400, 'Una publicación de fotos necesita al menos una foto');
  const id = await tx(async (c) => {
    const r = await c.get(`INSERT INTO posts (title, body, category, pinned, session_id, author_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.title, input.body, input.category, input.pinned || 0, input.session_id || null, req.player.id, nowIso()]);
    await F.insertImages(c, r.id, images);
    await Audit.audit(c, req.player, { action: 'post.create', entity: 'post', entityId: r.id,
      summary: `publicó en el foro «${input.title}» (${F.CATEGORIES[input.category].toLowerCase()}${images.length ? `, ${images.length} foto${images.length === 1 ? '' : 's'}` : ''})` });
    return r.id;
  });
  return { id };
}));

admin.patch('/posts/:id', requireRole(), wrap(async (req) => {
  const id = Number(req.params.id);
  const post = await db.get('SELECT * FROM posts WHERE id = $1', [id]);
  if (!post) throw new HttpError(404, 'Publicación no encontrada');
  const input = F.cleanPost(req.body || {}, { partial: true });
  const added = F.decodeImages(req.body?.add_images || []);
  const removeIds = Array.isArray(req.body?.remove_images) ? req.body.remove_images.map(String) : [];
  const current = (await db.get('SELECT COUNT(*)::int AS n FROM post_images WHERE post_id = $1', [id])).n;
  if (current - removeIds.length + added.length > F.MAX_IMAGES) throw new HttpError(400, `Máximo ${F.MAX_IMAGES} fotos por publicación`);
  await tx(async (c) => {
    const fields = Object.entries(input);
    for (const [k, v] of fields) await c.run(`UPDATE posts SET ${k} = $1 WHERE id = $2`, [v, id]);
    if (removeIds.length) await c.run('DELETE FROM post_images WHERE post_id = $1 AND id = ANY($2::text[])', [id, removeIds]);
    if (added.length) {
      const maxPos = (await c.get('SELECT COALESCE(MAX(position), -1)::int AS m FROM post_images WHERE post_id = $1', [id])).m;
      await F.insertImages(c, id, added, maxPos + 1);
    }
    await c.run('UPDATE posts SET updated_at = $1 WHERE id = $2', [nowIso(), id]);
    const what = [
      fields.some(([k]) => k !== 'pinned') && 'editó',
      'pinned' in input && input.pinned !== post.pinned && (input.pinned ? 'fijó' : 'desfijó'),
      added.length && `añadió ${added.length} foto${added.length === 1 ? '' : 's'} a`,
      removeIds.length && `quitó ${removeIds.length} foto${removeIds.length === 1 ? '' : 's'} de`,
    ].filter(Boolean);
    await Audit.audit(c, req.player, { action: 'post.update', entity: 'post', entityId: id,
      summary: `${what.join(', ') || 'editó'} la publicación «${input.title || post.title}»` });
  });
  return { ok: true };
}));

admin.delete('/posts/:id', requireRole(), wrap(async (req) => {
  const id = Number(req.params.id);
  const post = await db.get('SELECT title FROM posts WHERE id = $1', [id]);
  if (!post) throw new HttpError(404, 'Publicación no encontrada');
  await tx(async (c) => {
    await c.run('DELETE FROM posts WHERE id = $1', [id]);
    await Audit.audit(c, req.player, { action: 'post.delete', entity: 'post', entityId: id, summary: `eliminó la publicación «${post.title}» del foro` });
  });
  return { ok: true };
}));

app.use('/api/admin', admin);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'No encontrado')));
app.get('*', sendIndex);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
});

async function start(port = PORT) {
  await init();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Fútbol 7 · convocatorias en http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((e) => { console.error('No se pudo arrancar:', e.message); process.exit(1); });
}

module.exports = { app, start };
