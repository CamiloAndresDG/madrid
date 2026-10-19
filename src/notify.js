// Avisos a los jugadores cuando cambia su estado en una convocatoria:
// entra (se libera plaza, se llega a 21 para el triangular o Coordinación le convoca como cambio)
// o sale a reservas (alguien con más prioridad entra o se deshace el triangular).
const { db } = require('./db');
const L = require('./logic');

const dm = (date) => { const [, m, d] = String(date).split('-'); return `${d}/${m}`; };
const isIn = (role) => role === 'titular' || role === 'cambio';

// Foto del estado de la lista: rol de cada jugador y si hay triangular
async function snapshot(sessionId) {
  const session = await L.getSession(sessionId);
  const list = await L.computeList(session);
  return {
    session,
    roles: new Map(list.entries.map((e) => [e.player_id, e.role])),
    triangular: list.format.kind === 'triangular',
  };
}

// Compara dos fotos y crea un aviso para quien cambió de convocado a reserva o al revés.
// skip: quien hizo el cambio (ya ve el resultado en pantalla). Quien entra o sale de la lista no recibe aviso.
async function notifyChanges(runner, before, after, { skip = null } = {}) {
  const r = runner || db;
  const when = dm(after.session.date);
  const now = new Date().toISOString();
  const created = [];
  for (const [pid, a] of after.roles) {
    const b = before.roles.get(pid);
    if (!b || pid === skip || isIn(b) === isIn(a)) continue;
    let kind, message;
    if (isIn(a)) {
      if (a === 'cambio') {
        kind = 'called_up';
        message = `Coordinación te ha convocado como cambio para el entreno del ${when}.`;
      } else if (after.triangular && !before.triangular) {
        kind = 'triangular';
        message = `¡Ya sois 21! Hay triangular y estás convocado para el entreno del ${when}.`;
      } else {
        kind = 'promoted';
        message = `Se ha liberado una plaza: estás convocado para el entreno del ${when}.`;
      }
    } else {
      kind = 'demoted';
      message = before.triangular && !after.triangular
        ? `Ya no hay triangular el ${when}: pasas a reservas. Si alguien más se apunta, vuelves a entrar.`
        : `Has pasado a reservas para el entreno del ${when}. Si se libera una plaza, entras automáticamente.`;
    }
    await r.run(`INSERT INTO notifications (player_id, session_id, kind, message, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [pid, after.session.id, kind, message, now]);
    created.push({ player_id: pid, kind });
  }
  return created;
}

function unread(playerId) {
  return db.all(`SELECT id, session_id, kind, message, created_at FROM notifications
    WHERE player_id = $1 AND read_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 10`, [playerId]);
}

async function markRead(playerId, ids = null) {
  const now = new Date().toISOString();
  if (Array.isArray(ids) && ids.length) {
    await db.run('UPDATE notifications SET read_at = $1 WHERE player_id = $2 AND read_at IS NULL AND id = ANY($3::int[])',
      [now, playerId, ids.map(Number).filter(Number.isInteger)]);
  } else {
    await db.run('UPDATE notifications SET read_at = $1 WHERE player_id = $2 AND read_at IS NULL', [now, playerId]);
  }
}

module.exports = { snapshot, notifyChanges, unread, markRead };
