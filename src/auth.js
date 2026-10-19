// Cuentas de jugador: registro, inicio de sesión, sesiones y roles.
const crypto = require('node:crypto');
const { db, tx } = require('./db');

const SESSION_DAYS = 30;
const ROLE_CODES = ['coordinador', 'gestor', 'petos', 'balones'];
const MANAGER_ROLES = ['coordinador', 'gestor'];

const COORDINATOR_EMAIL = (process.env.COORDINATOR_EMAIL || '').trim().toLowerCase();

const nowIso = () => new Date().toISOString();

// ---------- Contraseñas (scrypt) ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- Validación ----------

function validateRegistration(input) {
  const errors = [];
  const first = String(input.first_name || '').trim();
  const last = String(input.last_name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').replace(/[\s.-]/g, '');
  const password = String(input.password || '');

  if (first.length < 2) errors.push('Escribe tu nombre');
  if (last.length < 2) errors.push('Escribe tus apellidos');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('El email no es válido');
  if (!/^(\+34)?[6-9]\d{8}$/.test(phone)) errors.push('El número de teléfono no es válido');
  if (password.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres');

  return {
    errors,
    data: { first_name: first, last_name: last, email, phone, password },
  };
}

// ---------- Jugadores y roles ----------

async function rolesOf(playerId) {
  const rows = await db.all('SELECT role_code FROM player_roles WHERE player_id = $1 ORDER BY role_code', [playerId]);
  return rows.map((r) => r.role_code);
}

function canManage(roles) {
  return roles.some((r) => MANAGER_ROLES.includes(r));
}

// Reemplaza los roles de un jugador. Siempre debe quedar al menos un coordinador.
async function setRoles(playerId, roles) {
  const wanted = [...new Set(roles)].filter((r) => ROLE_CODES.includes(r));
  await tx(async (c) => {
    const current = (await c.all('SELECT role_code FROM player_roles WHERE player_id = $1', [playerId])).map((r) => r.role_code);
    const wasCoord = current.includes('coordinador');
    const willBeCoord = wanted.includes('coordinador');
    if (wasCoord && !willBeCoord) {
      const others = await c.get(`SELECT COUNT(*)::int AS n FROM player_roles pr JOIN players p ON p.id = pr.player_id
        WHERE pr.role_code = 'coordinador' AND pr.player_id <> $1 AND p.active = 1`, [playerId]);
      if (others.n === 0) throw Object.assign(new Error('Debe quedar al menos un coordinador activo'), { status: 409 });
    }
    await c.run('DELETE FROM player_roles WHERE player_id = $1', [playerId]);
    for (const code of wanted) {
      await c.run('INSERT INTO player_roles (player_id, role_code) VALUES ($1, $2)', [playerId, code]);
    }
  });
}

async function register(input) {
  const { errors, data } = validateRegistration(input);
  if (errors.length) throw Object.assign(new Error(errors.join('. ')), { status: 400 });

  if (await db.get('SELECT 1 FROM players WHERE email = $1', [data.email])) {
    throw Object.assign(new Error('Ya existe una cuenta con ese email'), { status: 409 });
  }

  const id = await tx(async (c) => {
    const row = await c.get(`INSERT INTO players (name, first_name, last_name, phone, email, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [`${data.first_name} ${data.last_name}`, data.first_name, data.last_name, data.phone, data.email, hashPassword(data.password)]);
    if (COORDINATOR_EMAIL && data.email === COORDINATOR_EMAIL) {
      await c.run(`INSERT INTO player_roles (player_id, role_code) VALUES ($1, 'coordinador')`, [row.id]);
    }
    return row.id;
  });
  return id;
}

async function login(email, password) {
  const e = String(email || '').trim().toLowerCase();
  const p = await db.get('SELECT * FROM players WHERE email = $1', [e]);
  // Mismo mensaje exista o no la cuenta, para no revelar qué emails están registrados
  if (!p || !verifyPassword(String(password || ''), p.password_hash)) {
    throw Object.assign(new Error('Email o contraseña incorrectos'), { status: 401 });
  }
  if (!p.active) throw Object.assign(new Error('Tu cuenta no está activa. Habla con Coordinación.'), { status: 403 });
  return p.id;
}

// ---------- Mi cuenta ----------

async function updateProfile(playerId, input) {
  const current = await db.get('SELECT * FROM players WHERE id = $1', [playerId]);
  const { errors, data } = validateRegistration({ ...input, password: 'x'.repeat(8) });
  if (errors.length) throw Object.assign(new Error(errors.join('. ')), { status: 400 });
  if (data.email !== current.email && await db.get('SELECT 1 FROM players WHERE email = $1 AND id <> $2', [data.email, playerId])) {
    throw Object.assign(new Error('Ya existe otra cuenta con ese email'), { status: 409 });
  }
  await db.run(`UPDATE players SET first_name = $1, last_name = $2, name = $3, phone = $4, email = $5 WHERE id = $6`,
    [data.first_name, data.last_name, `${data.first_name} ${data.last_name}`, data.phone, data.email, playerId]);
}

// Cambia la contraseña y cierra las demás sesiones (la actual sigue abierta)
async function changePassword(playerId, currentPw, nextPw, keepToken) {
  const p = await db.get('SELECT password_hash FROM players WHERE id = $1', [playerId]);
  if (!verifyPassword(String(currentPw || ''), p?.password_hash)) {
    throw Object.assign(new Error('La contraseña actual no es correcta'), { status: 400 });
  }
  if (String(nextPw || '').length < 8) throw Object.assign(new Error('La nueva contraseña debe tener al menos 8 caracteres'), { status: 400 });
  await tx(async (c) => {
    await c.run('UPDATE players SET password_hash = $1 WHERE id = $2', [hashPassword(String(nextPw)), playerId]);
    await c.run('DELETE FROM auth_sessions WHERE player_id = $1 AND token_hash <> $2', [playerId, hashToken(keepToken || '')]);
  });
}

async function deleteAllSessions(playerId) {
  await db.run('DELETE FROM auth_sessions WHERE player_id = $1', [playerId]);
}

// ---------- Sesiones ----------

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function createSession(playerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.run('INSERT INTO auth_sessions (token_hash, player_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [hashToken(token), playerId, created.toISOString(), expires.toISOString()]);
  await db.run('UPDATE players SET last_login_at = $1 WHERE id = $2', [nowIso(), playerId]);
  return { token, expires_at: expires.toISOString() };
}

// Devuelve el jugador de la sesión y sus roles, o null si el token no vale o ha caducado
async function sessionPlayer(token) {
  if (!token) return null;
  const row = await db.get(`SELECT p.* FROM auth_sessions s JOIN players p ON p.id = s.player_id
    WHERE s.token_hash = $1 AND s.expires_at > $2`, [hashToken(token), nowIso()]);
  if (!row || !row.active) return null;
  row.roles = await rolesOf(row.id);
  return row;
}

async function deleteSession(token) {
  if (token) await db.run('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]);
}

module.exports = {
  ROLE_CODES, MANAGER_ROLES, SESSION_DAYS,
  hashPassword, verifyPassword, validateRegistration,
  rolesOf, canManage, setRoles, register, login,
  createSession, sessionPlayer, deleteSession,
  updateProfile, changePassword, deleteAllSessions,
};
