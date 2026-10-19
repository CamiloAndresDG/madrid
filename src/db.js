// Postgres (Supabase en producción). DATABASE_URL = cadena de conexión del "Session pooler" de Supabase.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('Falta DATABASE_URL (cadena de conexión de Postgres/Supabase).');
}
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX) || 5,
});

const NOW = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_coordinator INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  attendance_exempt INTEGER NOT NULL DEFAULT 0,  -- lesión, temporada fuera... (no aplica el mínimo de 4)
  exempt_note TEXT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,                 -- YYYY-MM-DD (miércoles)
  start_time TEXT NOT NULL DEFAULT '22:00',
  location TEXT NOT NULL DEFAULT 'Polideportivo Marqués de Samaranch',
  capacity INTEGER NOT NULL DEFAULT 16,
  cancelled INTEGER NOT NULL DEFAULT 0,
  finalized_at TEXT,                         -- lista final generada (lunes)
  petos_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  balones_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  notes TEXT,
  results_notes TEXT
);

CREATE TABLE IF NOT EXISTS responses (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  answer TEXT NOT NULL CHECK (answer IN ('yes','no')),
  signed_up_at TEXT,                         -- hora de inscripción (cuenta para el orden)
  updated_at TEXT NOT NULL,
  cancel_reason TEXT,
  cancel_notified INTEGER,                   -- avisó al coordinador al borrarse
  locked_rank INTEGER,                       -- orden congelado al generar la lista final
  locked_priority INTEGER,
  added_by_admin INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, player_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('attended','late','no_show','excused','left_out')),
  PRIMARY KEY (session_id, player_id)
);

CREATE TABLE IF NOT EXISTS infractions (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','justified')),
  source TEXT NOT NULL DEFAULT 'manual',     -- manual | auto | attendance
  note TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS team_players (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  home_goals INTEGER NOT NULL DEFAULT 0,
  away_goals INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_stats (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  mvp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, player_id)
);
`;

const TABLES = ['players', 'sessions', 'responses', 'attendance', 'infractions', 'teams', 'team_players', 'matches', 'player_stats'];

// Supabase expone las tablas de "public" por su API REST: activar RLS sin políticas
// las cierra a esa API; el servidor entra como propietario de las tablas y no le afecta.
const LOCKDOWN = TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n');

let ready;
function init() {
  ready ??= pool.query(SCHEMA + LOCKDOWN);
  return ready;
}

function api(runner) {
  return {
    all: async (sql, params = []) => (await runner.query(sql, params)).rows,
    get: async (sql, params = []) => (await runner.query(sql, params)).rows[0],
    run: async (sql, params = []) => runner.query(sql, params),
  };
}

const db = api(pool);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(api(client));
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { db, tx, init, pool };
