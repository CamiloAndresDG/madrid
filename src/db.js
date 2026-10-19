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
  name TEXT NOT NULL,                        -- nombre completo (first_name + last_name)
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  email TEXT,
  password_hash TEXT,
  last_login_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  attendance_exempt INTEGER NOT NULL DEFAULT 0 CHECK (attendance_exempt IN (0,1)),  -- lesión, temporada fuera...
  exempt_note TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT players_email_chk CHECK (email IS NULL OR (position('@' in email) > 1 AND email = lower(email)))
);
CREATE UNIQUE INDEX IF NOT EXISTS players_email_key ON players (email) WHERE email IS NOT NULL;

-- Roles: el catálogo es fijo; un jugador puede tener varios (coordinador, gestor, petos, balones...)
CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL
);
INSERT INTO roles (code, label, description) VALUES
  ('coordinador', 'Coordinador/a', 'Acceso completo: gestiona jugadores, roles, convocatorias, resultados e incidencias'),
  ('gestor', 'Gestor/a', 'Gestiona convocatorias, asistencia, resultados e incidencias'),
  ('petos', 'Petos', 'Responsable de los petos del entrenamiento'),
  ('balones', 'Balones', 'Responsable de los balones del entrenamiento')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_roles (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (player_id, role_code)
);
CREATE INDEX IF NOT EXISTS idx_player_roles_role ON player_roles(role_code);

-- Sesiones de inicio de sesión: solo se guarda el hash del token
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_player ON auth_sessions(player_id);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,                 -- YYYY-MM-DD (miércoles)
  start_time TEXT NOT NULL DEFAULT '22:00',
  location TEXT NOT NULL DEFAULT 'Polideportivo Marqués de Samaranch',
  capacity INTEGER NOT NULL DEFAULT 16,
  cancelled INTEGER NOT NULL DEFAULT 0,
  finalized_at TEXT,                         -- lista final generada (lunes)
  published_at TEXT,                         -- NULL = borrador (no la ven los jugadores)
  opens_at TEXT,                             -- NULL = domingo 17:00 antes del entreno
  arrival_time TEXT NOT NULL DEFAULT '21:45' CHECK (arrival_time ~ '^\\d{2}:\\d{2}$'),
  created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  updated_at TEXT,
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
  created_at TEXT NOT NULL DEFAULT ${NOW},
  created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  updated_at TEXT
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

-- Material del equipo y quién se lo lleva (la última asignación es la vigente; holder NULL = en el club)
CREATE TABLE IF NOT EXISTS equipment (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
INSERT INTO equipment (name) VALUES ('Petos amarillos'), ('Petos naranjas'), ('Balones') ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS equipment_assignments (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  holder_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  assigned_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_item ON equipment_assignments(equipment_id, assigned_at DESC);

-- Registro de actividad de coordinación (trazabilidad)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`;

const TABLES = ['players', 'roles', 'player_roles', 'auth_sessions', 'sessions', 'responses', 'attendance', 'infractions',
  'teams', 'team_players', 'matches', 'player_stats', 'equipment', 'equipment_assignments', 'audit_log'];

// Supabase expone las tablas de "public" por su API REST: activar RLS sin políticas
// las cierra a esa API; el servidor entra como propietario de las tablas y no le afecta.
const LOCKDOWN = TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n');

// Resumen de DATABASE_URL para los logs, sin mostrar la contraseña.
function describeConnection() {
  try {
    const u = new URL(DATABASE_URL);
    const pw = decodeURIComponent(u.password);
    const hints = [];
    if (/^\[.*\]$/.test(pw) || pw === 'YOUR-PASSWORD') hints.push('la contraseña sigue siendo el texto de ejemplo o lleva corchetes [ ]');
    if (/[@#/?%:&\s]/.test(u.password)) hints.push('la contraseña tiene caracteres especiales sin codificar');
    if (u.hostname.startsWith('db.') && u.hostname.endsWith('.supabase.co')) {
      hints.push('es la conexión directa de Supabase; usa la del "Session pooler" (host *.pooler.supabase.com, usuario postgres.<proyecto>)');
    }
    if (u.hostname.endsWith('pooler.supabase.com') && !u.username.includes('.')) {
      hints.push('con el pooler el usuario debe ser postgres.<id-del-proyecto>');
    }
    return `host=${u.hostname} port=${u.port || 5432} user=${u.username} db=${u.pathname.slice(1)} ` +
      `contraseña=${pw.length} caracteres${hints.length ? ` · Revisa: ${hints.join('; ')}` : ''}`;
  } catch {
    return 'DATABASE_URL no es una URL válida (debe empezar por postgresql://)';
  }
}

let ready;
function init() {
  ready ??= pool.query(SCHEMA + LOCKDOWN).catch((e) => {
    ready = undefined;
    e.message = `${e.message}\n  Conexión: ${describeConnection()}`;
    throw e;
  });
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
