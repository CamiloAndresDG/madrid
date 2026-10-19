// Crea el equipo de coordinación. Con --demo añade además jugadores ficticios y
// un par de entrenamientos para probar la web (usa DB_PATH para no tocar la base real).
//   npm run seed
//   DB_PATH=data/demo.db npm run seed -- --demo
const crypto = require('node:crypto');
const { db, tx, DB_PATH } = require('../src/db');
const L = require('../src/logic');

const token = () => crypto.randomBytes(12).toString('base64url');
const demo = process.argv.includes('--demo');

const COORDINATORS = ['Aleix Artacho', 'Mario Hernández', 'Axel Blas', 'Andrés Aranda'];

tx(() => {
  const ins = db.prepare('INSERT INTO players (name, is_coordinator, token) VALUES (?, ?, ?)');
  for (const name of COORDINATORS) {
    if (!db.prepare('SELECT 1 FROM players WHERE name = ?').get(name)) ins.run(name, 1, token());
  }
  if (!demo) return;

  for (let i = 1; i <= 28; i++) {
    const name = `Jugador ${String(i).padStart(2, '0')}`;
    if (!db.prepare('SELECT 1 FROM players WHERE name = ?').get(name)) ins.run(name, 0, token());
  }
  const players = db.prepare('SELECT id FROM players ORDER BY id').all().map((p) => p.id);

  // Entrenamiento de la semana pasada (con asistencia, incidencias y resultados) y el próximo
  const next = L.nextWednesday();
  const last = L.addDays(next, -7);
  for (const date of [last, next]) {
    if (!db.prepare('SELECT 1 FROM sessions WHERE date = ?').get(date)) db.prepare('INSERT INTO sessions (date) VALUES (?)').run(date);
  }
  const lastS = db.prepare('SELECT * FROM sessions WHERE date = ?').get(last);
  const opens = L.sessionTimes(lastS).opensAt.getTime();
  const insR = db.prepare(`INSERT OR IGNORE INTO responses (session_id, player_id, answer, signed_up_at, updated_at) VALUES (?, ?, 'yes', ?, ?)`);
  players.slice(0, 18).forEach((pid, i) => {
    const t = new Date(opens + (i + 1) * 47_000).toISOString();
    insR.run(lastS.id, pid, t, t);
  });
  const att = db.prepare('INSERT OR IGNORE INTO attendance (session_id, player_id, status) VALUES (?, ?, ?)');
  players.slice(0, 16).forEach((pid, i) => att.run(lastS.id, pid, i === 5 ? 'late' : i === 9 ? 'no_show' : 'attended'));
  players.slice(16, 18).forEach((pid) => att.run(lastS.id, pid, 'left_out'));
  const insI = db.prepare(`INSERT INTO infractions (session_id, player_id, type, status, source) VALUES (?, ?, ?, 'confirmed', 'attendance')`);
  if (!db.prepare('SELECT 1 FROM infractions WHERE session_id = ?').get(lastS.id)) {
    insI.run(lastS.id, players[5], 'late_arrival');
    insI.run(lastS.id, players[9], 'no_show');
  }
  if (!db.prepare('SELECT 1 FROM teams WHERE session_id = ?').get(lastS.id)) {
    const a = Number(db.prepare(`INSERT INTO teams (session_id, name, color) VALUES (?, 'Petos', '#f97316')`).run(lastS.id).lastInsertRowid);
    const b = Number(db.prepare(`INSERT INTO teams (session_id, name, color) VALUES (?, 'Sin petos', '#f8fafc')`).run(lastS.id).lastInsertRowid);
    const present = players.slice(0, 16).filter((_, i) => i !== 9);
    present.forEach((pid, i) => db.prepare('INSERT INTO team_players (team_id, player_id) VALUES (?, ?)').run(i % 2 ? b : a, pid));
    db.prepare('INSERT INTO matches (session_id, home_team_id, away_team_id, home_goals, away_goals) VALUES (?, ?, ?, 5, 3)').run(lastS.id, a, b);
    db.prepare('INSERT INTO matches (session_id, home_team_id, away_team_id, home_goals, away_goals) VALUES (?, ?, ?, 2, 2)').run(lastS.id, a, b);
    const ps = db.prepare('INSERT INTO player_stats (session_id, player_id, goals, assists, saves, mvp) VALUES (?, ?, ?, ?, ?, ?)');
    ps.run(lastS.id, present[0], 3, 1, 0, 1);
    ps.run(lastS.id, present[2], 2, 2, 0, 0);
    ps.run(lastS.id, present[1], 2, 0, 0, 0);
    ps.run(lastS.id, present[3], 1, 1, 6, 0);
  }
});

console.log(`Base de datos: ${DB_PATH}`);
for (const p of db.prepare('SELECT name, is_coordinator, token FROM players ORDER BY id').all()) {
  console.log(`${p.is_coordinator ? '[coord] ' : '        '}${p.name.padEnd(20)} /?t=${p.token}`);
}
