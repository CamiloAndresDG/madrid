const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), `f7-test-${process.pid}-${Date.now()}.db`);
const { db } = require('../src/db');
const L = require('../src/logic');

let n = 0;
const player = (name, coord = 0) => Number(db.prepare('INSERT INTO players (name, is_coordinator, token) VALUES (?, ?, ?)').run(name, coord, `t${++n}`).lastInsertRowid);
const session = (date, capacity = 3) => Number(db.prepare('INSERT INTO sessions (date, capacity) VALUES (?, ?)').run(date, capacity).lastInsertRowid);
const yes = (sid, pid, t) => db.prepare(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at) VALUES (?, ?, 'yes', ?, ?)`).run(sid, pid, t, t);
const attend = (sid, pid, status = 'attended') => db.prepare('INSERT INTO attendance (session_id, player_id, status) VALUES (?, ?, ?)').run(sid, pid, status);
const inf = (sid, pid, type) => db.prepare(`INSERT INTO infractions (session_id, player_id, type, status) VALUES (?, ?, ?, 'confirmed')`).run(sid, pid, type);

const A = player('Ana'), B = player('Bea'), C = player('Carla'), D = player('Dani'), K = player('Coord', 1);
const s1 = session('2026-10-07'), s2 = session('2026-10-14'), s3 = session('2026-10-21');

attend(s1, A); attend(s1, B); attend(s1, C, 'no_show'); attend(s1, K);
inf(s1, C, 'no_show');

attend(s2, A); attend(s2, K);
inf(s2, B, 'late_cancel_tuesday');

test('prioridad: P1 si no vino, P2 si vino, P3 con sanción (2 semanas para no presentarse)', () => {
  yes(s3, A, '2026-10-18T15:00:01Z'); // vino en s2 -> P2
  yes(s3, B, '2026-10-18T15:00:02Z'); // sanción de 1 semana en s2 -> P3
  yes(s3, C, '2026-10-18T15:00:03Z'); // no_show en s1 (2 semanas) -> P3
  yes(s3, D, '2026-10-18T15:00:04Z'); // no vino en s2 -> P1
  const list = L.computeList(L.getSession(s3));
  const pr = Object.fromEntries(list.entries.map((e) => [e.name, e.priority]));
  assert.deepStrictEqual(pr, { Ana: 2, Bea: 3, Carla: 3, Dani: 1 });
  assert.deepStrictEqual(list.entries.map((e) => e.name), ['Dani', 'Ana', 'Bea', 'Carla']);
  assert.deepStrictEqual(list.entries.map((e) => e.role), ['titular', 'titular', 'titular', 'reserva']);
});

test('al menos un coordinador en P1 aunque viniera la semana anterior', () => {
  yes(s3, K, '2026-10-18T16:00:00Z');
  const list = L.computeList(L.getSession(s3));
  const k = list.entries.find((e) => e.name === 'Coord');
  assert.strictEqual(k.priority, 1);
  assert.strictEqual(k.position, 2); // después de Dani (P1, se apuntó antes)
});

test('la lista final congela el orden y quien entra después va al final', () => {
  const sid = session('2026-10-28', 2);
  yes(sid, A, '2026-10-25T15:00:01Z');
  yes(sid, B, '2026-10-25T15:00:02Z');
  const before = L.computeList(L.getSession(sid)).entries;
  before.forEach((e) => db.prepare('UPDATE responses SET locked_rank = ?, locked_priority = ? WHERE session_id = ? AND player_id = ?').run(e.position, e.priority, sid, e.player_id));
  db.prepare(`UPDATE sessions SET finalized_at = '2026-10-26T10:00:00Z' WHERE id = ?`).run(sid);
  yes(sid, D, '2026-10-26T12:00:00Z'); // P1 pero llega tras la lista final
  const after = L.computeList(L.getSession(sid)).entries;
  assert.strictEqual(after[2].name, 'Dani');
  assert.strictEqual(after[2].role, 'reserva');
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

test('dos faltas graves = fuera del equipo', () => {
  assert.strictEqual(L.isExpelled(C), false);
  inf(s2, C, 'late_cancel_wednesday');
  assert.strictEqual(L.isExpelled(C), true);
});

test('horarios en hora de Madrid (domingo 17h, martes 15h)', () => {
  const t = L.sessionTimes({ date: '2026-10-21', start_time: '22:00' });
  assert.strictEqual(t.opensAt.toISOString(), '2026-10-18T15:00:00.000Z');
  assert.strictEqual(t.tuesdayDeadline.toISOString(), '2026-10-20T13:00:00.000Z');
  // tras el cambio de hora (invierno, UTC+1)
  assert.strictEqual(L.sessionTimes({ date: '2026-11-04', start_time: '22:00' }).startsAt.toISOString(), '2026-11-04T21:00:00.000Z');
});
