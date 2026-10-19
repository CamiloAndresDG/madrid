// Reglas de la sección (presentación "GMS F7 2627"): sistema de prioridades,
// plazos para borrarse, incidencias y estadísticas de temporada.
const { db } = require('./db');

const TZ = 'Europe/Madrid';

const INFRACTION_TYPES = {
  late_arrival: { label: 'Llegar después de las 21:50 sin avisar ni motivo justificado', weeks: 1, serious: false, severity: 1 },
  cancel_reserve_no_notice: { label: 'Borrarse estando en reservas sin avisar al coordinador', weeks: 1, serious: false, severity: 2 },
  late_cancel_tuesday: { label: 'Borrarse después de las 15h del martes sin motivo justificado', weeks: 1, serious: false, severity: 3 },
  cancel_starter_no_notice: { label: 'Borrarse estando en titulares sin avisar al coordinador', weeks: 2, serious: false, severity: 4 },
  no_show: { label: 'No presentarse estando inscrito sin motivo justificado', weeks: 2, serious: true, severity: 5 },
  late_cancel_wednesday: { label: 'Borrarse después de las 15h del miércoles sin motivo justificado', weeks: 2, serious: true, severity: 6 },
};

const ATTENDANCE_STATUSES = {
  attended: 'Asistió',
  late: 'Llegó tarde',
  no_show: 'No se presentó',
  excused: 'Falta justificada',
  left_out: 'Fuera (lista llena)',
};

const MIN_ATTENDANCE_PER_QUARTER = 4;
const SERIOUS_LIMIT = 2;

// ---------- Fechas en hora de Madrid ----------

function madridParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return o;
}

// "2026-10-21", "15:00" (hora de Madrid) -> Date
function madridToDate(dateStr, timeStr = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = madridParts(new Date(guess));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (asUtc - guess));
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function todayMadrid(now = new Date()) {
  const p = madridParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

// Próximo miércoles (o hoy si es miércoles y aún no ha empezado el entreno)
function nextWednesday(now = new Date()) {
  const today = todayMadrid(now);
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo
  let diff = (3 - dow + 7) % 7;
  if (diff === 0 && now >= madridToDate(today, '22:00')) diff = 7;
  return addDays(today, diff);
}

function sessionTimes(session) {
  return {
    opensAt: madridToDate(addDays(session.date, -3), '17:00'),          // domingo 17h
    listDay: addDays(session.date, -2),                                   // lunes: lista final
    tuesdayDeadline: madridToDate(addDays(session.date, -1), '15:00'),
    wednesdayDeadline: madridToDate(session.date, '15:00'),
    startsAt: madridToDate(session.date, session.start_time || '22:00'),
    endsAt: new Date(madridToDate(session.date, session.start_time || '22:00').getTime() + 60 * 60 * 1000),
  };
}

// ---------- Consultas básicas ----------

const q = {
  session: (id) => db.get('SELECT * FROM sessions WHERE id = $1', [id]),
  prevSession: (date) => db.get('SELECT * FROM sessions WHERE date < $1 AND cancelled = 0 ORDER BY date DESC LIMIT 1', [date]),
  yesResponses: (sid) => db.all(`
    SELECT r.*, p.name,
      EXISTS (SELECT 1 FROM player_roles pr WHERE pr.player_id = p.id AND pr.role_code = 'coordinador') AS is_coordinator
    FROM responses r JOIN players p ON p.id = r.player_id
    WHERE r.session_id = $1 AND r.answer = 'yes'`, [sid]),
  attendance: (sid) => db.all('SELECT player_id, status FROM attendance WHERE session_id = $1', [sid]),
  infractionsIn: (sid) => db.all(`SELECT * FROM infractions WHERE session_id = $1 AND status = 'confirmed'`, [sid]),
  seriousCount: () => db.all(`SELECT player_id, type FROM infractions WHERE status = 'confirmed'`),
};

function getSession(id) { return q.session(id); }
async function previousSession(session) { return session ? q.prevSession(session.date) : undefined; }

function newCtx() { return { lists: new Map(), outcomes: new Map() }; }

// Resultado de una sesión para cada jugador: attended | late | no_show | excused | left_out.
// Si no se ha pasado lista, se asume que fueron los titulares y que los reservas se quedaron fuera.
async function sessionOutcome(session, ctx = newCtx()) {
  if (!session) return new Map();
  if (ctx.outcomes.has(session.id)) return ctx.outcomes.get(session.id);
  const out = new Map();
  const rows = await q.attendance(session.id);
  if (rows.length) {
    for (const r of rows) out.set(r.player_id, r.status);
  } else {
    const list = await computeList(session, ctx);
    for (const e of list.entries) out.set(e.player_id, e.role === 'titular' ? 'attended' : 'left_out');
  }
  ctx.outcomes.set(session.id, out);
  return out;
}

function didAttend(status) { return status === 'attended' || status === 'late'; }

// ---------- Sistema de prioridades ----------

async function computeList(session, ctx = newCtx()) {
  if (ctx.lists.has(session.id)) return ctx.lists.get(session.id);
  ctx.lists.set(session.id, { entries: [] }); // evita ciclos

  const prev = await previousSession(session);
  const prev2 = await previousSession(prev);
  const prevOutcome = await sessionOutcome(prev, ctx);

  const penalties = new Map(); // player_id -> [{type, label, date}]
  const addPenalty = (inf, s) => {
    if (!penalties.has(inf.player_id)) penalties.set(inf.player_id, []);
    penalties.get(inf.player_id).push({ type: inf.type, label: INFRACTION_TYPES[inf.type]?.label || inf.type, date: s.date });
  };
  if (prev) for (const inf of await q.infractionsIn(prev.id)) addPenalty(inf, prev);
  if (prev2) for (const inf of await q.infractionsIn(prev2.id)) {
    if ((INFRACTION_TYPES[inf.type]?.weeks || 1) >= 2) addPenalty(inf, prev2);
  }

  const entries = (await q.yesResponses(session.id)).map((r) => {
    let priority, reason;
    const pens = penalties.get(r.player_id);
    if (pens) {
      priority = 3;
      reason = `Sanción: ${pens.map((p) => `${p.label} (${p.date})`).join('; ')}`;
    } else if (!prev) {
      priority = 1;
      reason = 'Primer entrenamiento de la temporada';
    } else if (didAttend(prevOutcome.get(r.player_id))) {
      priority = 2;
      reason = `Asistió al entrenamiento anterior (${prev.date})`;
    } else {
      priority = 1;
      reason = `No asistió al entrenamiento anterior (${prev.date})`;
    }
    return {
      player_id: r.player_id, name: r.name, is_coordinator: !!r.is_coordinator,
      signed_up_at: r.signed_up_at, added_by_admin: !!r.added_by_admin,
      locked_rank: r.locked_rank, locked_priority: r.locked_priority,
      priority, reason,
    };
  });

  // Al menos uno de los coordinadores tiene prioridad 1 (si no está en P3)
  const coords = entries.filter((e) => e.is_coordinator);
  if (coords.length && !coords.some((e) => e.priority === 1)) {
    const pick = coords.filter((e) => e.priority === 2).sort(byTime)[0];
    if (pick) { pick.priority = 1; pick.reason = 'Coordinación (al menos un coordinador en prioridad 1)'; }
  }

  // Con la lista final generada, el orden congelado se respeta; quien entra después va al final.
  if (session.finalized_at) {
    for (const e of entries) if (e.locked_rank != null) e.priority = e.locked_priority;
  }
  entries.sort((a, b) => {
    if (session.finalized_at) {
      const la = a.locked_rank ?? Infinity, lb = b.locked_rank ?? Infinity;
      if (la !== lb) return la - lb;
    }
    return a.priority - b.priority || byTime(a, b);
  });
  entries.forEach((e, i) => {
    e.position = i + 1;
    e.role = i < session.capacity ? 'titular' : 'reserva';
  });

  const result = { session, previous: prev || null, entries };
  ctx.lists.set(session.id, result);
  return result;
}

function byTime(a, b) { return String(a.signed_up_at).localeCompare(String(b.signed_up_at)); }

// ---------- Incidencias ----------

async function seriousCounts() {
  const counts = new Map();
  for (const r of await q.seriousCount()) {
    if (INFRACTION_TYPES[r.type]?.serious) counts.set(r.player_id, (counts.get(r.player_id) || 0) + 1);
  }
  return counts;
}

async function isExpelled(playerId) {
  return ((await seriousCounts()).get(playerId) || 0) >= SERIOUS_LIMIT;
}

// Qué incidencia (si alguna) supone borrarse ahora de una sesión.
function cancellationInfraction(session, { role, notified, now = new Date() }) {
  const t = sessionTimes(session);
  const candidates = [];
  if (now > t.wednesdayDeadline) candidates.push('late_cancel_wednesday');
  else if (now > t.tuesdayDeadline) candidates.push('late_cancel_tuesday');
  if (session.finalized_at && !notified) {
    candidates.push(role === 'titular' ? 'cancel_starter_no_notice' : 'cancel_reserve_no_notice');
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => INFRACTION_TYPES[b].severity - INFRACTION_TYPES[a].severity)[0];
}

// ---------- Estadísticas de temporada ----------

function quarterOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const qn = Math.floor((m - 1) / 3) + 1;
  return `${y}-T${qn}`;
}

async function seasonStats(now = new Date()) {
  const players = await db.all('SELECT * FROM players ORDER BY name');
  const sessions = await db.all('SELECT * FROM sessions WHERE cancelled = 0 ORDER BY date');
  const ctx = newCtx();
  const stats = new Map(players.map((p) => [p.id, {
    player_id: p.id, name: p.name, active: !!p.active, is_coordinator: !!p.is_coordinator,
    attendance_exempt: !!p.attendance_exempt,
    attended: 0, late: 0, no_show: 0, left_out: 0,
    played: 0, wins: 0, draws: 0, losses: 0, points: 0,
    goals: 0, assists: 0, saves: 0, mvps: 0, quarters: {},
  }]));

  for (const s of sessions) {
    if (sessionTimes(s).endsAt > now) continue;
    const qk = quarterOf(s.date);
    for (const [pid, status] of await sessionOutcome(s, ctx)) {
      const st = stats.get(pid);
      if (!st) continue;
      st.quarters[qk] ??= { attended: 0, left_out: 0 };
      if (didAttend(status)) { st.attended++; st.quarters[qk].attended++; }
      if (status === 'late') st.late++;
      if (status === 'no_show') st.no_show++;
      if (status === 'left_out') { st.left_out++; st.quarters[qk].left_out++; }
    }
  }

  // Partidos: cada jugador suma los puntos de su equipo (3 victoria, 1 empate)
  const teamPlayers = await db.all('SELECT team_id, player_id FROM team_players');
  const byTeam = new Map();
  for (const tp of teamPlayers) {
    if (!byTeam.has(tp.team_id)) byTeam.set(tp.team_id, []);
    byTeam.get(tp.team_id).push(tp.player_id);
  }
  for (const m of await db.all('SELECT * FROM matches')) {
    const apply = (teamId, gf, ga) => {
      for (const pid of byTeam.get(teamId) || []) {
        const st = stats.get(pid);
        if (!st) continue;
        st.played++;
        if (gf > ga) { st.wins++; st.points += 3; } else if (gf === ga) { st.draws++; st.points += 1; } else st.losses++;
      }
    };
    apply(m.home_team_id, m.home_goals, m.away_goals);
    apply(m.away_team_id, m.away_goals, m.home_goals);
  }

  for (const ps of await db.all('SELECT * FROM player_stats')) {
    const st = stats.get(ps.player_id);
    if (!st) continue;
    st.goals += ps.goals; st.assists += ps.assists; st.saves += ps.saves; st.mvps += ps.mvp;
  }

  const serious = await seriousCounts();
  const infCounts = new Map();
  for (const r of await db.all(`SELECT player_id, COUNT(*)::int c FROM infractions WHERE status='confirmed' GROUP BY player_id`)) {
    infCounts.set(r.player_id, r.c);
  }

  const currentQ = quarterOf(todayMadrid(now));
  return [...stats.values()].map((st) => {
    const cq = st.quarters[currentQ] || { attended: 0, left_out: 0 };
    return {
      ...st,
      infractions: infCounts.get(st.player_id) || 0,
      serious_infractions: serious.get(st.player_id) || 0,
      expelled: (serious.get(st.player_id) || 0) >= SERIOUS_LIMIT,
      current_quarter: currentQ,
      current_quarter_count: cq.attended + cq.left_out, // quedarse fuera por lista llena no cuenta como falta
    };
  });
}

// ---------- Panel de temporada (grupo y personal) ----------

// Por cada entrenamiento ya jugado: asistencia y goles del grupo, y el historial del jugador
// (estado, equipo, resultado, puntos, goles...). También puntos acumulados frente a la media
// del grupo y rachas de asistencia (quedarse fuera o falta justificada no rompen la racha).
async function dashboard(playerId, now = new Date()) {
  const sessions = (await db.all('SELECT * FROM sessions WHERE cancelled = 0 ORDER BY date'))
    .filter((s) => sessionTimes(s).endsAt <= now);
  const activeCount = (await db.get('SELECT COUNT(*)::int AS n FROM players WHERE active = 1')).n || 1;
  const teams = await db.all('SELECT id, session_id, name, color FROM teams');
  const teamPlayers = await db.all('SELECT team_id, player_id FROM team_players');
  const matches = await db.all('SELECT * FROM matches ORDER BY id');
  const pstats = await db.all('SELECT * FROM player_stats');
  const infractions = await db.all(`SELECT type, COUNT(*)::int AS n FROM infractions WHERE status = 'confirmed' GROUP BY type`);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const membersOf = new Map();
  const teamOf = new Map(); // "sesión:jugador" -> equipo
  for (const tp of teamPlayers) {
    const t = teamById.get(tp.team_id);
    if (!t) continue;
    if (!membersOf.has(t.id)) membersOf.set(t.id, []);
    membersOf.get(t.id).push(tp.player_id);
    teamOf.set(`${t.session_id}:${tp.player_id}`, t);
  }
  const matchesOf = new Map();
  for (const m of matches) {
    if (!matchesOf.has(m.session_id)) matchesOf.set(m.session_id, []);
    matchesOf.get(m.session_id).push(m);
  }
  const statOf = new Map(pstats.map((x) => [`${x.session_id}:${x.player_id}`, x]));

  const ctx = newCtx();
  const groupSessions = [];
  const history = [];
  const cumulative = [];
  let myCum = 0, groupCum = 0;

  for (const s of sessions) {
    const outcome = await sessionOutcome(s, ctx);
    const count = { attended: 0, late: 0, no_show: 0, excused: 0, left_out: 0 };
    for (const st of outcome.values()) if (st in count) count[st]++;

    // Resultado del día por jugador: G/E/P, goles a favor/en contra y puntos (3/1/0)
    const rec = new Map();
    const add = (teamId, gf, ga) => {
      for (const pid of membersOf.get(teamId) || []) {
        const r = rec.get(pid) || { wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 };
        r.gf += gf; r.ga += ga;
        if (gf > ga) { r.wins++; r.points += 3; } else if (gf === ga) { r.draws++; r.points += 1; } else r.losses++;
        rec.set(pid, r);
      }
    };
    const ms = matchesOf.get(s.id) || [];
    for (const m of ms) { add(m.home_team_id, m.home_goals, m.away_goals); add(m.away_team_id, m.away_goals, m.home_goals); }
    const dayPoints = [...rec.values()].reduce((a, r) => a + r.points, 0);

    groupSessions.push({
      id: s.id, date: s.date, capacity: s.capacity,
      attended: count.attended + count.late, late: count.late, no_show: count.no_show, left_out: count.left_out,
      goals: ms.reduce((a, m) => a + m.home_goals + m.away_goals, 0), matches: ms.length,
    });

    const mine = rec.get(playerId) || { wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 };
    const st = statOf.get(`${s.id}:${playerId}`);
    const team = teamOf.get(`${s.id}:${playerId}`);
    myCum += mine.points;
    groupCum += dayPoints / activeCount;
    history.push({
      session_id: s.id, date: s.date, status: outcome.get(playerId) || null,
      team: team ? { name: team.name, color: team.color } : null,
      ...mine, goals: st?.goals || 0, assists: st?.assists || 0, saves: st?.saves || 0, mvp: !!st?.mvp,
    });
    cumulative.push({ date: s.date, me: myCum, group: Math.round(groupCum * 10) / 10 });
  }

  // Rachas: cuenta asistir; quedarse fuera o falta justificada no la rompen; faltar sí
  let streak = 0, best = 0, run = 0;
  for (const h of history) {
    if (h.status === 'attended' || h.status === 'late') { run++; best = Math.max(best, run); }
    else if (h.status === 'left_out' || h.status === 'excused') continue;
    else run = 0;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const st = history[i].status;
    if (st === 'attended' || st === 'late') streak++;
    else if (st === 'left_out' || st === 'excused') continue;
    else break;
  }

  return {
    group: {
      sessions: groupSessions,
      infractions_by_type: infractions.map((r) => ({ type: r.type, label: INFRACTION_TYPES[r.type]?.label || r.type, n: r.n })),
    },
    me: { history, cumulative, streak, best_streak: best },
  };
}

module.exports = {
  INFRACTION_TYPES, ATTENDANCE_STATUSES, MIN_ATTENDANCE_PER_QUARTER, SERIOUS_LIMIT,
  madridToDate, addDays, todayMadrid, nextWednesday, sessionTimes,
  getSession, previousSession, computeList, sessionOutcome, newCtx,
  seriousCounts, isExpelled, cancellationInfraction, seasonStats, quarterOf, dashboard,
};
