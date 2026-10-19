const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'futbol7.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  is_coordinator INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  attendance_exempt INTEGER NOT NULL DEFAULT 0,  -- lesión, temporada fuera... (no aplica el mínimo de 4)
  exempt_note TEXT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
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
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','justified')),
  source TEXT NOT NULL DEFAULT 'manual',     -- manual | auto | attendance
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
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
  id INTEGER PRIMARY KEY,
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
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx, DB_PATH };
