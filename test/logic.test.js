const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startLocalPg } = require('../scripts/local-pg');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-pg-'));
let pg, db, pool, L;
let A, B, C, D, K, s1, s2, s3;

let n = 0;
const player = async (name, coord = 0) => {
  const { id } = await db.get('INSERT INTO players (name, email) VALUES ($1, $2) RETURNING id', [name, `p${++n}@test.local`]);
  if (coord) await db.run(`INSERT INTO player_roles (player_id, role_code) VALUES ($1, 'coordinador')`, [id]);
  return id;
};
const session = async (date, capacity = 3) => (await db.get('INSERT INTO sessions (date, capacity) VALUES ($1, $2) RETURNING id', [date, capacity])).id;
const yes = (sid, pid, t) => db.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at) VALUES ($1, $2, 'yes', $3, $3)`, [sid, pid, t]);
const attend = (sid, pid, status = 'attended') => db.run('INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, $3)', [sid, pid, status]);
const inf = (sid, pid, type) => db.run(`INSERT INTO infractions (session_id, player_id, type, status) VALUES ($1, $2, $3, 'confirmed')`, [sid, pid, type]);

before(async () => {
  pg = await startLocalPg({ dir, port: 54000 + (process.pid % 1000), persistent: false });
  process.env.DATABASE_URL = pg.url;
  ({ db, pool } = require('../src/db'));
  await require('../src/db').init();
  L = require('../src/logic');

  A = await player('Ana'); B = await player('Bea'); C = await player('Carla'); D = await player('Dani'); K = await player('Coord', 1);
  s1 = await session('2026-10-07'); s2 = await session('2026-10-14'); s3 = await session('2026-10-21');
  await attend(s1, A); await attend(s1, B); await attend(s1, C, 'no_show'); await attend(s1, K);
  await inf(s1, C, 'no_show');
  await attend(s2, A); await attend(s2, K);
  await inf(s2, B, 'late_cancel_tuesday');
});

after(async () => {
  await pool?.end();
  await pg?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prioridad: P1 si no vino, P2 si vino, P3 con sanción (2 semanas para no presentarse)', async () => {
  await yes(s3, A, '2026-10-18T15:00:01Z'); // vino en s2 -> P2
  await yes(s3, B, '2026-10-18T15:00:02Z'); // sanción de 1 semana en s2 -> P3
  await yes(s3, C, '2026-10-18T15:00:03Z'); // no_show en s1 (2 semanas) -> P3
  await yes(s3, D, '2026-10-18T15:00:04Z'); // no vino en s2 -> P1
  const list = await L.computeList(await L.getSession(s3));
  const pr = Object.fromEntries(list.entries.map((e) => [e.name, e.priority]));
  assert.deepStrictEqual(pr, { Ana: 2, Bea: 3, Carla: 3, Dani: 1 });
  assert.deepStrictEqual(list.entries.map((e) => e.name), ['Dani', 'Ana', 'Bea', 'Carla']);
  assert.deepStrictEqual(list.entries.map((e) => e.role), ['titular', 'titular', 'titular', 'reserva']);
});

test('al menos un coordinador en P1 aunque viniera la semana anterior', async () => {
  await yes(s3, K, '2026-10-18T16:00:00Z');
  const list = await L.computeList(await L.getSession(s3));
  const k = list.entries.find((e) => e.name === 'Coord');
  assert.strictEqual(k.priority, 1);
  assert.strictEqual(k.position, 2); // después de Dani (P1, se apuntó antes)
});

test('la lista final congela el orden y quien entra después va al final', async () => {
  const sid = await session('2026-10-28', 2);
  await yes(sid, A, '2026-10-25T15:00:01Z');
  await yes(sid, B, '2026-10-25T15:00:02Z');
  const before = (await L.computeList(await L.getSession(sid))).entries;
  for (const e of before) {
    await db.run('UPDATE responses SET locked_rank = $1, locked_priority = $2 WHERE session_id = $3 AND player_id = $4', [e.position, e.priority, sid, e.player_id]);
  }
  await db.run(`UPDATE sessions SET finalized_at = '2026-10-26T10:00:00Z' WHERE id = $1`, [sid]);
  await yes(sid, D, '2026-10-26T12:00:00Z'); // P1 pero llega tras la lista final
  const afterList = (await L.computeList(await L.getSession(sid))).entries;
  assert.strictEqual(afterList[2].name, 'Dani');
  assert.strictEqual(afterList[2].role, 'reserva');
});

test('borrarse fuera de plazo genera la incidencia correcta', () => {
  const s = { date: '2026-10-21', start_time: '22:00', finalized_at: null };
  const at = (iso) => new Date(iso);
  assert.strictEqual(L.cancellationInfraction(s, { role: 'titular', notified: false, now: at('2026-10-19T10:00:00Z') }), null);
  // martes 20/10 16:00 Madrid = 14:00 UTC
  assert.strictEqual(L.cancellationInfraction(s, { role: 'titular', notified: false, now: at('2026-10-20T14:00:00Z') }), 'late_cancel_tuesday');
  // miércoles 21/10 16:00 Madrid
  assert.strictEqual(L.cancellationInfraction(s, { role: 'titular', notified: true, now: at('2026-10-21T14:00:00Z') }), 'late_cancel_wednesday');
  const fin = { ...s, finalized_at: 'x' };
  assert.strictEqual(L.cancellationInfraction(fin, { role: 'titular', notified: false, now: at('2026-10-19T10:00:00Z') }), 'cancel_starter_no_notice');
  assert.strictEqual(L.cancellationInfraction(fin, { role: 'reserva', notified: false, now: at('2026-10-19T10:00:00Z') }), 'cancel_reserve_no_notice');
  assert.strictEqual(L.cancellationInfraction(fin, { role: 'reserva', notified: true, now: at('2026-10-19T10:00:00Z') }), null);
});

test('dos faltas graves = fuera del equipo', async () => {
  assert.strictEqual(await L.isExpelled(C), false);
  await inf(s2, C, 'late_cancel_wednesday');
  assert.strictEqual(await L.isExpelled(C), true);
});

test('horarios en hora de Madrid (domingo 17h, martes 15h)', () => {
  const t = L.sessionTimes({ date: '2026-10-21', start_time: '22:00' });
  assert.strictEqual(t.opensAt.toISOString(), '2026-10-18T15:00:00.000Z');
  assert.strictEqual(t.tuesdayDeadline.toISOString(), '2026-10-20T13:00:00.000Z');
  // tras el cambio de hora (invierno, UTC+1)
  assert.strictEqual(L.sessionTimes({ date: '2026-11-04', start_time: '22:00' }).startsAt.toISOString(), '2026-11-04T21:00:00.000Z');
});

test('estadísticas de temporada suman asistencia', async () => {
  const stats = await L.seasonStats(new Date('2026-12-01T00:00:00Z'));
  const ana = stats.find((s) => s.name === 'Ana');
  assert.ok(ana.attended >= 2);
  assert.strictEqual(stats.find((s) => s.name === 'Carla').serious_infractions, 2);
});
