// Lista pegada desde WhatsApp → jugadores de la sección.
// Acepta líneas como «1. Camilo», «* Andrés D.», «- Daniel 🏳️‍🌈», «*Dani*»; ignora cabeceras y líneas vacías.

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9ñ' -]/g, ' ').replace(/\s+/g, ' ').trim();

// Una línea → nombre limpio (o null si no parece un nombre)
function cleanLine(line) {
  let s = String(line || '').replace(/[‍‎‏‪-‮︎️]/g, '').trim();
  if (!s || /:\s*$/.test(s)) return null;                         // «Convocatoria miércoles:»
  s = s.replace(/^\s*(?:[-*•·>~]+|\d{1,3}\s*[.)\-:]?)\s*/u, '');   // viñeta o número
  s = s.replace(/^\s*(?:[-*•·]+)\s*/u, '');                        // «1. - Camilo»
  s = s.replace(/[*_~]/g, '');                                     // negritas de WhatsApp
  s = s.replace(/\(.*?\)|\[.*?\]/g, ' ');                          // «Camilo (portero)»
  s = s.split(/\s[-–—|/]\s|[,;]/)[0];                              // «Camilo - llego tarde»
  s = s.replace(/[^\p{L}\p{M}\p{N}' .-]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/[.\-]+$/, '').trim();
  if (!s || !/\p{L}/u.test(s) || s.split(' ').length > 5) return null;
  return s;
}

function parse(text) {
  return String(text || '').split(/\r?\n/).map((raw) => ({ raw: raw.trim(), name: cleanLine(raw) })).filter((l) => l.name);
}

// Busca al jugador: nombre completo → nombre de pila único → iniciales/prefijos («Camilo D», «Andr»)
function matchName(name, players) {
  const q = norm(name);
  const qt = q.split(' ');
  const full = players.filter((p) => norm(p.name) === q);
  if (full.length === 1) return { status: 'match', player: full[0] };
  const first = players.filter((p) => norm(p.first_name || p.name.split(' ')[0]) === q);
  if (first.length === 1) return { status: 'match', player: first[0] };
  const prefix = players.filter((p) => {
    const pt = norm(p.name).split(' ');
    return qt.length <= pt.length && qt.every((t, i) => pt[i].startsWith(t.replace(/\.$/, '')));
  });
  if (prefix.length === 1 && (qt.length > 1 || qt[0].length >= 3)) return { status: 'match', player: prefix[0] };
  const options = [...new Map([...full, ...first, ...prefix].map((p) => [p.id, p])).values()];
  if (options.length) return { status: 'ambiguous', options };
  return { status: 'new' };
}

// Resultado para revisar antes de apuntar: cada línea con su jugador, sus opciones o «nuevo»
function preview(text, players) {
  const active = players.filter((p) => p.active !== 0 && p.active !== false);
  const seen = new Set();
  return parse(text).map((l) => {
    const m = matchName(l.name, active);
    const out = { raw: l.raw, name: l.name, status: m.status, player_id: m.player?.id || null,
      player_name: m.player?.name || null, options: (m.options || []).map((p) => ({ id: p.id, name: p.name })) };
    if (out.player_id && seen.has(out.player_id)) out.status = 'duplicate';
    if (out.player_id) seen.add(out.player_id);
    return out;
  });
}

// «pepe nuevo» → «Pepe Nuevo» para crear a alguien que aún no tiene ficha
const titleCase = (s) => s.split(' ').map((w) => w.charAt(0).toLocaleUpperCase('es') + w.slice(1)).join(' ');

module.exports = { titleCase, parse, cleanLine, matchName, preview, norm };
