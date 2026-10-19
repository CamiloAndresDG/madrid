// Registro de actividad de coordinación: quién hizo qué, cuándo y sobre qué.
const { db } = require('./db');

// runner: db o el cliente de una transacción (para que el registro vaya en la misma transacción)
async function audit(runner, actor, { action, entity, entityId = null, sessionId = null, summary }) {
  await (runner || db).run(`INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, session_id, summary)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [new Date().toISOString(), actor?.id ?? null, actor?.name || 'Sistema', action, entity, entityId, sessionId, summary]);
}

async function list({ entity = null, sessionId = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (entity) { params.push(entity); where.push(`entity = $${params.length}`); }
  if (sessionId) { params.push(sessionId); where.push(`session_id = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  return db.all(`SELECT a.*, s.date AS session_date FROM audit_log a LEFT JOIN sessions s ON s.id = a.session_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.at DESC, a.id DESC LIMIT $${params.length}`, params);
}

module.exports = { audit, list };
