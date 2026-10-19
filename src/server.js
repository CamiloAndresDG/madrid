const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, tx } = require('./db');
const L = require('./logic');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiame';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD no definido: usando "cambiame". Defínelo antes de publicar la web.');
}
const ADMIN_TOKEN = crypto.createHash('sha256').update(`f7-admin:${ADMIN_PASSWORD}`).digest('hex');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Utilidades ----------

const nowIso = () => new Date().toISOString();
const newToken = () => crypto.randomBytes(12).toString('base64url');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) { next(e); }
};

function isAdmin(req) {
  const h = req.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  return tok.length === ADMIN_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN));
}
function playerFromReq(req) {
  const tok = req.get('x-player-token');
  if (!tok) return null;
  return db.prepare('SELECT * FROM players WHERE token = ?').get(tok) || null;
}
function requireAdmin(req, _res, next) {
  if (!isAdmin(req)) return next(new HttpError(401, 'Acceso solo para coordinación'));
  next();
}
function requireAny(req, _res, next) {
  req.player = playerFromReq(req);
  req.admin = isAdmin(req);
  if (!req.player && !req.admin) return next(new HttpError(401, 'Necesitas tu enlace personal'));
  next();
}
function requirePlayer(req, _res, next) {
  req.player = playerFromReq(req);
  if (!req.player) return next(new HttpError(401, 'Enlace personal no válido'));
  next();
}

function sessionOr404(id) {
  const s = L.getSession(Number(id));
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
    is_open: now >= t.opensAt && now < t.startsAt && !s.cancelled,
    has_started: now >= t.startsAt,
    is_past: now >= t.endsAt,
  };
}

function playerName(id) {
  return id ? db.prepare('SELECT name FROM players WHERE id = ?').get(id)?.name || null : null;
}

function listPayload(session, ctx) {
  const list = L.computeList(session, ctx);
  const noes = db.prepare(`
    SELECT r.player_id, p.name, r.cancel_reason, r.updated_at FROM responses r JOIN players p ON p.id = r.player_id
    WHERE r.session_id = ? AND r.answer = 'no' ORDER BY p.name`).all(session.id);
  return {
    session: { ...publicSession(session), petos: playerName(session.petos_player_id), balones: playerName(session.balones_player_id) },
    previous: list.previous ? { id: list.previous.id, date: list.previous.date } : null,
    titulares: list.entries.filter((e) => e.role === 'titular'),
    reservas: list.entries.filter((e) => e.role === 'reserva'),
    no_van: noes,
  };
}

function currentSession() {
  return db.prepare('SELECT * FROM sessions WHERE cancelled = 0 AND date >= ? ORDER BY date LIMIT 1')
    .get(L.todayMadrid());
}

function whatsappText(payload) {
  const s = payload.session;
  const [y, m, d] = s.date.split('-');
  const lines = [
    `⚽ *Entrenamiento Fútbol 7* — miércoles ${d}/${m}/${y} · ${s.start_time}`,
    `📍 ${s.location} (llegad a las 21:45)`,
    '',
    `*TITULARES (${payload.titulares.length}/${s.capacity})*`,
    ...payload.titulares.map((e) => `${e.position}. ${e.name}`),
  ];
  if (payload.reservas.length) {
    lines.push('', '*RESERVAS*', ...payload.reservas.map((e) => `${e.position}. ${e.name}`));
  }
  if (s.petos || s.balones) lines.push('', `🦺 Petos: ${s.petos || '—'} · ⚽ Balones: ${s.balones || '—'}`);
  lines.push('', 'Recordad: no borrarse después de las 15h del martes sin motivo justificado.');
  return lines.join('\n');
}

function resultsPayload(sessionId) {
  const teams = db.prepare('SELECT * FROM teams WHERE session_id = ? ORDER BY id').all(sessionId).map((t) => ({
    ...t,
    players: db.prepare(`SELECT p.id, p.name FROM team_players tp JOIN players p ON p.id = tp.player_id
      WHERE tp.team_id = ? ORDER BY p.name`).all(t.id),
  }));
  const matches = db.prepare('SELECT * FROM matches WHERE session_id = ? ORDER BY id').all(sessionId);
  const stats = db.prepare(`SELECT ps.*, p.name FROM player_stats ps JOIN players p ON p.id = ps.player_id
    WHERE ps.session_id = ? ORDER BY ps.goals DESC, ps.assists DESC, p.name`).all(sessionId);
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
  const notes = db.prepare('SELECT results_notes FROM sessions WHERE id = ?').get(sessionId)?.results_notes || '';
  return { teams, matches, stats, table, notes };
}

// ---------- API: jugador ----------

app.get('/api/me', requirePlayer, wrap((req) => {
  const p = req.player;
  const s = currentSession();
  const counts = L.seriousCounts();
  const out = {
    player: { id: p.id, name: p.name, is_coordinator: !!p.is_coordinator, active: !!p.active },
    expelled: (counts.get(p.id) || 0) >= L.SERIOUS_LIMIT,
    serious_infractions: counts.get(p.id) || 0,
    infractions: db.prepare(`SELECT i.id, i.type, i.status, i.note, s.date FROM infractions i JOIN sessions s ON s.id = i.session_id
      WHERE i.player_id = ? ORDER BY s.date DESC`).all(p.id)
      .map((i) => ({ ...i, label: L.INFRACTION_TYPES[i.type]?.label || i.type, weeks: L.INFRACTION_TYPES[i.type]?.weeks })),
    session: null,
  };
  if (s) {
    const ctx = L.newCtx();
    const payload = listPayload(s, ctx);
    const resp = db.prepare('SELECT * FROM responses WHERE session_id = ? AND player_id = ?').get(s.id, p.id);
    const mine = [...payload.titulares, ...payload.reservas].find((e) => e.player_id === p.id) || null;
    out.session = { ...payload, my_response: resp ? resp.answer : null, my_entry: mine };
  }
  return out;
}));

app.put('/api/sessions/:id/response', requirePlayer, wrap((req) => {
  const p = req.player;
  const s = sessionOr404(req.params.id);
  const { answer, notified = false, reason = '' } = req.body || {};
  if (!['yes', 'no'].includes(answer)) throw new HttpError(400, 'Respuesta no válida');
  if (s.cancelled) throw new HttpError(400, 'Este entrenamiento está cancelado');
  const t = L.sessionTimes(s);
  const now = new Date();
  if (now >= t.startsAt) throw new HttpError(400, 'El entrenamiento ya ha empezado');

  const existing = db.prepare('SELECT * FROM responses WHERE session_id = ? AND player_id = ?').get(s.id, p.id);
  let infraction = null;

  if (answer === 'yes') {
    if (!p.active) throw new HttpError(403, 'Tu inscripción no está activa. Habla con Coordinación.');
    if (L.isExpelled(p.id)) throw new HttpError(403, 'Tienes dos faltas graves esta temporada. Habla con Coordinación.');
    if (now < t.opensAt) throw new HttpError(400, 'La convocatoria se abre el domingo a las 17:00');
    if (existing?.answer === 'yes') return { ok: true };
    db.prepare(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at)
      VALUES (?, ?, 'yes', ?, ?)
      ON CONFLICT(session_id, player_id) DO UPDATE SET answer = 'yes', signed_up_at = excluded.signed_up_at,
        updated_at = excluded.updated_at, cancel_reason = NULL, cancel_notified = NULL, locked_rank = NULL, locked_priority = NULL, added_by_admin = 0`)
      .run(s.id, p.id, nowIso(), nowIso());
  } else {
    tx(() => {
      if (existing?.answer === 'yes') {
        const entry = L.computeList(s).entries.find((e) => e.player_id === p.id);
        const type = L.cancellationInfraction(s, { role: entry?.role, notified: !!notified, now });
        if (type) {
          const note = [reason && `Motivo: ${reason}`, notified ? 'Dice que avisó al coordinador' : 'No avisó al coordinador',
            entry && `Estaba en ${entry.role === 'titular' ? 'titulares' : 'reservas'} (puesto ${entry.position})`]
            .filter(Boolean).join(' · ');
          db.prepare(`INSERT INTO infractions (session_id, player_id, type, status, source, note) VALUES (?, ?, ?, 'pending', 'auto', ?)`)
            .run(s.id, p.id, type, note);
          infraction = { type, label: L.INFRACTION_TYPES[type].label };
        }
      }
      db.prepare(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at, cancel_reason, cancel_notified)
        VALUES (?, ?, 'no', NULL, ?, ?, ?)
        ON CONFLICT(session_id, player_id) DO UPDATE SET answer = 'no', signed_up_at = NULL, updated_at = excluded.updated_at,
          cancel_reason = excluded.cancel_reason, cancel_notified = excluded.cancel_notified, locked_rank = NULL, locked_priority = NULL`)
        .run(s.id, p.id, nowIso(), reason || null, notified ? 1 : 0);
    });
  }
  return { ok: true, infraction };
}));

// ---------- API: compartida (jugadores y coordinación) ----------

app.get('/api/sessions/:id/list', requireAny, wrap((req) => listPayload(sessionOr404(req.params.id), L.newCtx())));

app.get('/api/sessions', requireAny, wrap(() => {
  return db.prepare('SELECT * FROM sessions ORDER BY date DESC').all().map((s) => ({
    ...publicSession(s),
    has_results: !!db.prepare('SELECT 1 FROM matches WHERE session_id = ? LIMIT 1').get(s.id),
    yes_count: db.prepare(`SELECT COUNT(*) c FROM responses WHERE session_id = ? AND answer = 'yes'`).get(s.id).c,
  }));
}));

app.get('/api/sessions/:id/results', requireAny, wrap((req) => {
  const s = sessionOr404(req.params.id);
  return { session: publicSession(s), ...resultsPayload(s.id) };
}));

app.get('/api/stats', requireAny, wrap((req) => ({
  min_per_quarter: L.MIN_ATTENDANCE_PER_QUARTER,
  players: L.seasonStats().filter((p) => p.active || req.admin),
})));

app.get('/api/rules', wrap(() => ({ infraction_types: L.INFRACTION_TYPES, attendance_statuses: L.ATTENDANCE_STATUSES })));

// ---------- API: coordinación ----------

app.post('/api/admin/login', wrap((req) => {
  const pw = String(req.body?.password || '');
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Contraseña incorrecta');
  return { token: ADMIN_TOKEN };
}));

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/overview', wrap(() => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY date DESC').all().map((s) => ({
    ...publicSession(s),
    yes_count: db.prepare(`SELECT COUNT(*) c FROM responses WHERE session_id = ? AND answer = 'yes'`).get(s.id).c,
    attendance_taken: !!db.prepare('SELECT 1 FROM attendance WHERE session_id = ? LIMIT 1').get(s.id),
    has_results: !!db.prepare('SELECT 1 FROM matches WHERE session_id = ? LIMIT 1').get(s.id),
  }));
  const cur = currentSession();
  return {
    sessions,
    current_id: cur?.id || null,
    next_wednesday: L.nextWednesday(),
    pending_infractions: db.prepare(`SELECT COUNT(*) c FROM infractions WHERE status = 'pending'`).get().c,
  };
}));

// Jugadores
admin.get('/players', wrap(() => {
  const counts = L.seriousCounts();
  return db.prepare('SELECT * FROM players ORDER BY active DESC, name').all().map((p) => ({
    ...p, serious_infractions: counts.get(p.id) || 0, expelled: (counts.get(p.id) || 0) >= L.SERIOUS_LIMIT,
  }));
}));
admin.post('/players', wrap((req) => {
  const names = (Array.isArray(req.body.names) ? req.body.names : [req.body.name])
    .map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length) throw new HttpError(400, 'Falta el nombre');
  const ins = db.prepare('INSERT INTO players (name, is_coordinator, token) VALUES (?, ?, ?)');
  tx(() => names.forEach((n) => ins.run(n, req.body.is_coordinator ? 1 : 0, newToken())));
  return { ok: true, created: names.length };
}));
admin.patch('/players/:id', wrap((req) => {
  const fields = ['name', 'is_coordinator', 'active', 'attendance_exempt', 'exempt_note'];
  for (const f of fields) {
    if (f in req.body) {
      let v = req.body[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      db.prepare(`UPDATE players SET ${f} = ? WHERE id = ?`).run(v, Number(req.params.id));
    }
  }
  return { ok: true };
}));
admin.post('/players/:id/token', wrap((req) => {
  db.prepare('UPDATE players SET token = ? WHERE id = ?').run(newToken(), Number(req.params.id));
  return { ok: true };
}));

// Entrenamientos
admin.post('/sessions', wrap((req) => {
  const { date, capacity = 16, start_time = '22:00', location, notes } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'Fecha no válida');
  if (db.prepare('SELECT 1 FROM sessions WHERE date = ?').get(date)) throw new HttpError(400, 'Ya hay un entrenamiento ese día');
  const r = db.prepare(`INSERT INTO sessions (date, capacity, start_time, location, notes)
    VALUES (?, ?, ?, COALESCE(?, 'Polideportivo Marqués de Samaranch'), ?)`)
    .run(date, Number(capacity), start_time, location || null, notes || null);
  return { id: Number(r.lastInsertRowid) };
}));

admin.get('/sessions/:id', wrap((req) => {
  const s = sessionOr404(req.params.id);
  const ctx = L.newCtx();
  const payload = listPayload(s, ctx);
  const answered = new Set(db.prepare('SELECT player_id FROM responses WHERE session_id = ?').all(s.id).map((r) => r.player_id));
  return {
    ...payload,
    whatsapp: whatsappText(payload),
    sin_responder: db.prepare('SELECT id, name FROM players WHERE active = 1 ORDER BY name').all().filter((p) => !answered.has(p.id)),
    attendance: db.prepare('SELECT player_id, status FROM attendance WHERE session_id = ?').all(s.id),
    infractions: db.prepare(`SELECT i.*, p.name FROM infractions i JOIN players p ON p.id = i.player_id
      WHERE i.session_id = ? ORDER BY i.created_at`).all(s.id),
    results: resultsPayload(s.id),
  };
}));

admin.patch('/sessions/:id', wrap((req) => {
  const s = sessionOr404(req.params.id);
  for (const f of ['capacity', 'start_time', 'location', 'notes', 'petos_player_id', 'balones_player_id', 'cancelled']) {
    if (f in req.body) {
      let v = req.body[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (v === '') v = null;
      db.prepare(`UPDATE sessions SET ${f} = ? WHERE id = ?`).run(v, s.id);
    }
  }
  return { ok: true };
}));

admin.delete('/sessions/:id', wrap((req) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionOr404(req.params.id).id);
  return { ok: true };
}));

// Lista final (lunes): congela el orden por prioridad + hora de inscripción
admin.post('/sessions/:id/finalize', wrap((req) => {
  const s = sessionOr404(req.params.id);
  tx(() => {
    db.prepare('UPDATE sessions SET finalized_at = NULL WHERE id = ?').run(s.id);
    const fresh = L.getSession(s.id);
    const list = L.computeList(fresh);
    const upd = db.prepare('UPDATE responses SET locked_rank = ?, locked_priority = ? WHERE session_id = ? AND player_id = ?');
    list.entries.forEach((e) => upd.run(e.position, e.priority, s.id, e.player_id));
    db.prepare('UPDATE sessions SET finalized_at = ? WHERE id = ?').run(nowIso(), s.id);
  });
  const payload = listPayload(L.getSession(s.id), L.newCtx());
  return { ok: true, whatsapp: whatsappText(payload) };
}));
admin.post('/sessions/:id/unfinalize', wrap((req) => {
  const s = sessionOr404(req.params.id);
  tx(() => {
    db.prepare('UPDATE sessions SET finalized_at = NULL WHERE id = ?').run(s.id);
    db.prepare('UPDATE responses SET locked_rank = NULL, locked_priority = NULL WHERE session_id = ?').run(s.id);
  });
  return { ok: true };
}));

// Coordinación apunta o borra a alguien sin generar incidencias
admin.put('/sessions/:id/responses/:playerId', wrap((req) => {
  const s = sessionOr404(req.params.id);
  const pid = Number(req.params.playerId);
  const answer = req.body?.answer;
  if (answer === null) {
    db.prepare('DELETE FROM responses WHERE session_id = ? AND player_id = ?').run(s.id, pid);
    return { ok: true };
  }
  if (!['yes', 'no'].includes(answer)) throw new HttpError(400, 'Respuesta no válida');
  const existing = db.prepare('SELECT answer FROM responses WHERE session_id = ? AND player_id = ?').get(s.id, pid);
  if (existing?.answer === answer) return { ok: true };
  db.prepare(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at, added_by_admin)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(session_id, player_id) DO UPDATE SET answer = excluded.answer, signed_up_at = excluded.signed_up_at,
      updated_at = excluded.updated_at, added_by_admin = 1, locked_rank = NULL, locked_priority = NULL`)
    .run(s.id, pid, answer, answer === 'yes' ? nowIso() : null, nowIso());
  return { ok: true };
}));

// Asistencia: llegar tarde / no presentarse generan la incidencia correspondiente
admin.put('/sessions/:id/attendance', wrap((req) => {
  const s = sessionOr404(req.params.id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  tx(() => {
    const kept = new Map(db.prepare(`SELECT player_id, type, status, note FROM infractions
      WHERE session_id = ? AND source = 'attendance'`).all(s.id).map((r) => [`${r.player_id}:${r.type}`, r]));
    db.prepare('DELETE FROM attendance WHERE session_id = ?').run(s.id);
    db.prepare(`DELETE FROM infractions WHERE session_id = ? AND source = 'attendance'`).run(s.id);
    const insA = db.prepare('INSERT INTO attendance (session_id, player_id, status) VALUES (?, ?, ?)');
    const insI = db.prepare(`INSERT INTO infractions (session_id, player_id, type, status, source, note) VALUES (?, ?, ?, ?, 'attendance', ?)`);
    for (const it of items) {
      if (!L.ATTENDANCE_STATUSES[it.status]) continue;
      insA.run(s.id, Number(it.player_id), it.status);
      const type = it.status === 'late' ? 'late_arrival' : it.status === 'no_show' ? 'no_show' : null;
      if (type) {
        const prev = kept.get(`${it.player_id}:${type}`);
        insI.run(s.id, Number(it.player_id), type, prev?.status || 'confirmed', prev?.note || null);
      }
    }
  });
  return { ok: true };
}));

// Incidencias
admin.get('/infractions', wrap(() => {
  return db.prepare(`SELECT i.*, p.name, s.date FROM infractions i
    JOIN players p ON p.id = i.player_id JOIN sessions s ON s.id = i.session_id
    ORDER BY (i.status = 'pending') DESC, s.date DESC, i.created_at DESC`).all()
    .map((i) => ({ ...i, label: L.INFRACTION_TYPES[i.type]?.label || i.type, ...L.INFRACTION_TYPES[i.type] }));
}));
admin.post('/infractions', wrap((req) => {
  const { session_id, player_id, type, note } = req.body || {};
  sessionOr404(session_id);
  if (!L.INFRACTION_TYPES[type]) throw new HttpError(400, 'Tipo de incidencia no válido');
  db.prepare(`INSERT INTO infractions (session_id, player_id, type, status, source, note) VALUES (?, ?, ?, 'confirmed', 'manual', ?)`)
    .run(Number(session_id), Number(player_id), type, note || null);
  return { ok: true };
}));
admin.patch('/infractions/:id', wrap((req) => {
  const { status, note, type } = req.body || {};
  if (status && !['pending', 'confirmed', 'justified'].includes(status)) throw new HttpError(400, 'Estado no válido');
  if (type && !L.INFRACTION_TYPES[type]) throw new HttpError(400, 'Tipo no válido');
  if (status) db.prepare('UPDATE infractions SET status = ? WHERE id = ?').run(status, Number(req.params.id));
  if (note !== undefined) db.prepare('UPDATE infractions SET note = ? WHERE id = ?').run(note, Number(req.params.id));
  if (type) db.prepare('UPDATE infractions SET type = ? WHERE id = ?').run(type, Number(req.params.id));
  return { ok: true };
}));
admin.delete('/infractions/:id', wrap((req) => {
  db.prepare('DELETE FROM infractions WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
}));

// Resultados del entrenamiento: equipos, partidos y estadísticas individuales
admin.put('/sessions/:id/results', wrap((req) => {
  const s = sessionOr404(req.params.id);
  const { teams = [], matches = [], stats = [], notes = '' } = req.body || {};
  tx(() => {
    db.prepare('DELETE FROM teams WHERE session_id = ?').run(s.id); // cascada: team_players, matches
    db.prepare('DELETE FROM player_stats WHERE session_id = ?').run(s.id);
    const ids = teams.map((t) => {
      const r = db.prepare('INSERT INTO teams (session_id, name, color) VALUES (?, ?, ?)')
        .run(s.id, String(t.name || 'Equipo'), t.color || null);
      const tid = Number(r.lastInsertRowid);
      for (const pid of new Set(t.player_ids || [])) db.prepare('INSERT INTO team_players (team_id, player_id) VALUES (?, ?)').run(tid, Number(pid));
      return tid;
    });
    for (const m of matches) {
      const h = ids[m.home], a = ids[m.away];
      if (h == null || a == null || h === a) continue;
      db.prepare('INSERT INTO matches (session_id, home_team_id, away_team_id, home_goals, away_goals) VALUES (?, ?, ?, ?, ?)')
        .run(s.id, h, a, Math.max(0, Number(m.home_goals) || 0), Math.max(0, Number(m.away_goals) || 0));
    }
    const insS = db.prepare('INSERT INTO player_stats (session_id, player_id, goals, assists, saves, mvp) VALUES (?, ?, ?, ?, ?, ?)');
    for (const st of stats) {
      const g = Number(st.goals) || 0, a = Number(st.assists) || 0, sv = Number(st.saves) || 0, mvp = st.mvp ? 1 : 0;
      if (g || a || sv || mvp) insS.run(s.id, Number(st.player_id), g, a, sv, mvp);
    }
    db.prepare('UPDATE sessions SET results_notes = ? WHERE id = ?').run(notes || null, s.id);
  });
  return { ok: true };
}));

app.use('/api/admin', admin);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'No encontrado')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Fútbol 7 · convocatorias en http://localhost:${PORT}`));
}

module.exports = app;
