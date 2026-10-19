const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, tx, init } = require('./db');
const L = require('./logic');
const A = require('./auth');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
    is_open: now >= t.opensAt && now < t.startsAt && !s.cancelled,
    has_started: now >= t.startsAt,
    is_past: now >= t.endsAt,
  };
}

async function playerName(id) {
  return id ? (await db.get('SELECT name FROM players WHERE id = $1', [id]))?.name || null : null;
}

async function listPayload(session, ctx) {
  const list = await L.computeList(session, ctx);
  const noes = await db.all(`
    SELECT r.player_id, p.name, r.cancel_reason, r.updated_at FROM responses r JOIN players p ON p.id = r.player_id
    WHERE r.session_id = $1 AND r.answer = 'no' ORDER BY p.name`, [session.id]);
  return {
    session: { ...publicSession(session), petos: await playerName(session.petos_player_id), balones: await playerName(session.balones_player_id) },
    previous: list.previous ? { id: list.previous.id, date: list.previous.date } : null,
    titulares: list.entries.filter((e) => e.role === 'titular'),
    reservas: list.entries.filter((e) => e.role === 'reserva'),
    no_van: noes,
  };
}

function currentSession() {
  return db.get('SELECT * FROM sessions WHERE cancelled = 0 AND date >= $1 ORDER BY date LIMIT 1', [L.todayMadrid()]);
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
      id: p.id, name: p.name, email: p.email, phone: p.phone,
      active: !!p.active, roles: req.roles, is_coordinator: req.roles.includes('coordinador'),
      can_manage: A.canManage(req.roles),
    },
    expelled: (counts.get(p.id) || 0) >= L.SERIOUS_LIMIT,
    serious_infractions: counts.get(p.id) || 0,
    infractions: infractions.map((i) => ({ ...i, label: L.INFRACTION_TYPES[i.type]?.label || i.type, weeks: L.INFRACTION_TYPES[i.type]?.weeks })),
    session: null,
  };
  if (s) {
    const payload = await listPayload(s, L.newCtx());
    const resp = await db.get('SELECT * FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, p.id]);
    const mine = [...payload.titulares, ...payload.reservas].find((e) => e.player_id === p.id) || null;
    out.session = { ...payload, my_response: resp ? resp.answer : null, my_entry: mine };
  }
  return out;
}));

app.put('/api/sessions/:id/response', requirePlayer, wrap(async (req) => {
  const p = req.player;
  const s = await sessionOr404(req.params.id);
  const { answer, notified = false, reason = '' } = req.body || {};
  if (!['yes', 'no'].includes(answer)) throw new HttpError(400, 'Respuesta no válida');
  if (s.cancelled) throw new HttpError(400, 'Este entrenamiento está cancelado');
  const t = L.sessionTimes(s);
  const now = new Date();
  if (now >= t.startsAt) throw new HttpError(400, 'El entrenamiento ya ha empezado');

  const existing = await db.get('SELECT * FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, p.id]);
  let infraction = null;

  if (answer === 'yes') {
    if (!p.active) throw new HttpError(403, 'Tu inscripción no está activa. Habla con Coordinación.');
    if (await L.isExpelled(p.id)) throw new HttpError(403, 'Tienes dos faltas graves esta temporada. Habla con Coordinación.');
    if (now < t.opensAt) throw new HttpError(400, 'La convocatoria se abre el domingo a las 17:00');
    if (existing?.answer === 'yes') return { ok: true };
    await db.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at)
      VALUES ($1, $2, 'yes', $3, $3)
      ON CONFLICT (session_id, player_id) DO UPDATE SET answer = 'yes', signed_up_at = excluded.signed_up_at,
        updated_at = excluded.updated_at, cancel_reason = NULL, cancel_notified = NULL, locked_rank = NULL, locked_priority = NULL, added_by_admin = 0`,
    [s.id, p.id, nowIso()]);
  } else {
    let type = null, note = null;
    if (existing?.answer === 'yes') {
      const entry = (await L.computeList(s)).entries.find((e) => e.player_id === p.id);
      type = L.cancellationInfraction(s, { role: entry?.role, notified: !!notified, now });
      note = [reason && `Motivo: ${reason}`, notified ? 'Dice que avisó al coordinador' : 'No avisó al coordinador',
        entry && `Estaba en ${entry.role === 'titular' ? 'titulares' : 'reservas'} (puesto ${entry.position})`]
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
          cancel_reason = excluded.cancel_reason, cancel_notified = excluded.cancel_notified, locked_rank = NULL, locked_priority = NULL`,
      [s.id, p.id, nowIso(), reason || null, notified ? 1 : 0]);
    });
  }
  return { ok: true, infraction };
}));

// ---------- API: compartida (jugadores y coordinación) ----------

app.get('/api/sessions/:id/list', requireAny, wrap(async (req) => listPayload(await sessionOr404(req.params.id), L.newCtx())));

app.get('/api/sessions', requireAny, wrap(async () => {
  const sessions = await db.all('SELECT * FROM sessions ORDER BY date DESC');
  return Promise.all(sessions.map(sessionFlags));
}));

app.get('/api/sessions/:id/results', requireAny, wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  return { session: publicSession(s), ...(await resultsPayload(s.id)) };
}));

app.get('/api/stats', requireAny, wrap(async (req) => ({
  min_per_quarter: L.MIN_ATTENDANCE_PER_QUARTER,
  players: (await L.seasonStats()).filter((p) => p.active || A.canManage(req.roles)),
})));

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

app.get('/api/roles', wrap(async () => db.all('SELECT code, label, description FROM roles ORDER BY code')));

// ---------- API: coordinación ----------

const admin = express.Router();
// Coordinadores y gestores: convocatorias, asistencia, resultados e incidencias
admin.use(requireRole('gestor'));

admin.get('/overview', wrap(async () => {
  const sessions = await Promise.all((await db.all('SELECT * FROM sessions ORDER BY date DESC')).map(sessionFlags));
  const cur = await currentSession();
  return {
    sessions,
    current_id: cur?.id || null,
    next_wednesday: L.nextWednesday(),
    pending_infractions: (await db.get(`SELECT COUNT(*)::int c FROM infractions WHERE status = 'pending'`)).c,
  };
}));

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
  for (const f of ['active', 'attendance_exempt', 'exempt_note']) {
    if (f in req.body) {
      let v = req.body[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      await db.run(`UPDATE players SET ${f} = $1 WHERE id = $2`, [v, Number(req.params.id)]);
    }
  }
  return { ok: true };
}));
// Solo coordinación cambia los roles (coordinador, gestor, petos, balones…)
admin.put('/players/:id/roles', requireRole(), wrap(async (req) => {
  const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
  await A.setRoles(Number(req.params.id), roles);
  return { ok: true, roles: await A.rolesOf(Number(req.params.id)) };
}));

// Entrenamientos
admin.post('/sessions', wrap(async (req) => {
  const { date, capacity = 16, start_time = '22:00', location, notes } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'Fecha no válida');
  if (await db.get('SELECT 1 FROM sessions WHERE date = $1', [date])) throw new HttpError(400, 'Ya hay un entrenamiento ese día');
  const r = await db.get(`INSERT INTO sessions (date, capacity, start_time, location, notes)
    VALUES ($1, $2, $3, COALESCE($4, 'Polideportivo Marqués de Samaranch'), $5) RETURNING id`,
  [date, Number(capacity), start_time, location || null, notes || null]);
  return { id: r.id };
}));

admin.get('/sessions/:id', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const payload = await listPayload(s, L.newCtx());
  const answered = new Set((await db.all('SELECT player_id FROM responses WHERE session_id = $1', [s.id])).map((r) => r.player_id));
  return {
    ...payload,
    whatsapp: whatsappText(payload),
    sin_responder: (await db.all('SELECT id, name FROM players WHERE active = 1 ORDER BY name')).filter((p) => !answered.has(p.id)),
    attendance: await db.all('SELECT player_id, status FROM attendance WHERE session_id = $1', [s.id]),
    infractions: await db.all(`SELECT i.*, p.name FROM infractions i JOIN players p ON p.id = i.player_id
      WHERE i.session_id = $1 ORDER BY i.created_at`, [s.id]),
    results: await resultsPayload(s.id),
  };
}));

admin.patch('/sessions/:id', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  for (const f of ['capacity', 'start_time', 'location', 'notes', 'petos_player_id', 'balones_player_id', 'cancelled']) {
    if (f in req.body) {
      let v = req.body[f];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (v === '') v = null;
      await db.run(`UPDATE sessions SET ${f} = $1 WHERE id = $2`, [v, s.id]);
    }
  }
  return { ok: true };
}));

admin.delete('/sessions/:id', wrap(async (req) => {
  await db.run('DELETE FROM sessions WHERE id = $1', [(await sessionOr404(req.params.id)).id]);
  return { ok: true };
}));

// Lista final (lunes): congela el orden por prioridad + hora de inscripción
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
  });
  const payload = await listPayload(await L.getSession(s.id), L.newCtx());
  return { ok: true, whatsapp: whatsappText(payload) };
}));
admin.post('/sessions/:id/unfinalize', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  await tx(async (c) => {
    await c.run('UPDATE sessions SET finalized_at = NULL WHERE id = $1', [s.id]);
    await c.run('UPDATE responses SET locked_rank = NULL, locked_priority = NULL WHERE session_id = $1', [s.id]);
  });
  return { ok: true };
}));

// Coordinación apunta o borra a alguien sin generar incidencias
admin.put('/sessions/:id/responses/:playerId', wrap(async (req) => {
  const s = await sessionOr404(req.params.id);
  const pid = Number(req.params.playerId);
  const answer = req.body?.answer;
  if (answer === null) {
    await db.run('DELETE FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, pid]);
    return { ok: true };
  }
  if (!['yes', 'no'].includes(answer)) throw new HttpError(400, 'Respuesta no válida');
  const existing = await db.get('SELECT answer FROM responses WHERE session_id = $1 AND player_id = $2', [s.id, pid]);
  if (existing?.answer === answer) return { ok: true };
  await db.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at, added_by_admin)
    VALUES ($1, $2, $3, $4, $5, 1)
    ON CONFLICT (session_id, player_id) DO UPDATE SET answer = excluded.answer, signed_up_at = excluded.signed_up_at,
      updated_at = excluded.updated_at, added_by_admin = 1, locked_rank = NULL, locked_priority = NULL`,
  [s.id, pid, answer, answer === 'yes' ? nowIso() : null, nowIso()]);
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
    for (const it of items) {
      if (!L.ATTENDANCE_STATUSES[it.status]) continue;
      await c.run('INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [s.id, Number(it.player_id), it.status]);
      const type = it.status === 'late' ? 'late_arrival' : it.status === 'no_show' ? 'no_show' : null;
      if (type) {
        const prev = kept.get(`${it.player_id}:${type}`);
        await c.run(`INSERT INTO infractions (session_id, player_id, type, status, source, note) VALUES ($1, $2, $3, $4, 'attendance', $5)`,
          [s.id, Number(it.player_id), type, prev?.status || 'confirmed', prev?.note || null]);
      }
    }
  });
  return { ok: true };
}));

// Incidencias
admin.get('/infractions', wrap(async () => {
  return (await db.all(`SELECT i.*, p.name, s.date FROM infractions i
    JOIN players p ON p.id = i.player_id JOIN sessions s ON s.id = i.session_id
    ORDER BY (i.status = 'pending') DESC, s.date DESC, i.created_at DESC`))
    .map((i) => ({ ...i, label: L.INFRACTION_TYPES[i.type]?.label || i.type, ...L.INFRACTION_TYPES[i.type] }));
}));
admin.post('/infractions', wrap(async (req) => {
  const { session_id, player_id, type, note } = req.body || {};
  await sessionOr404(session_id);
  if (!L.INFRACTION_TYPES[type]) throw new HttpError(400, 'Tipo de incidencia no válido');
  await db.run(`INSERT INTO infractions (session_id, player_id, type, status, source, note) VALUES ($1, $2, $3, 'confirmed', 'manual', $4)`,
    [Number(session_id), Number(player_id), type, note || null]);
  return { ok: true };
}));
admin.patch('/infractions/:id', wrap(async (req) => {
  const { status, note, type } = req.body || {};
  const id = Number(req.params.id);
  if (status && !['pending', 'confirmed', 'justified'].includes(status)) throw new HttpError(400, 'Estado no válido');
  if (type && !L.INFRACTION_TYPES[type]) throw new HttpError(400, 'Tipo no válido');
  if (status) await db.run('UPDATE infractions SET status = $1 WHERE id = $2', [status, id]);
  if (note !== undefined) await db.run('UPDATE infractions SET note = $1 WHERE id = $2', [note, id]);
  if (type) await db.run('UPDATE infractions SET type = $1 WHERE id = $2', [type, id]);
  return { ok: true };
}));
admin.delete('/infractions/:id', wrap(async (req) => {
  await db.run('DELETE FROM infractions WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

// Resultados del entrenamiento: equipos, partidos y estadísticas individuales
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
    for (const m of matches) {
      const h = ids[m.home], a = ids[m.away];
      if (h == null || a == null || h === a) continue;
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
