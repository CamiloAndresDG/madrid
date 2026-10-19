'use strict';

// ---------- Estado y utilidades ----------

const S = {
  player: localStorage.getItem('f7_player') || '',
  admin: localStorage.getItem('f7_admin') || '',
  rules: null,
  adminSessionId: Number(sessionStorage.getItem('f7_admin_session')) || null,
  res: null,       // editor de resultados
  att: null,       // editor de asistencia
  sort: { key: 'points', dir: -1 },
};

// Enlace personal: /?t=TOKEN
(function readTokenFromUrl() {
  const url = new URL(location.href);
  const t = url.searchParams.get('t');
  if (t) {
    S.player = t;
    localStorage.setItem('f7_player', t);
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + (url.hash || '#/'));
  }
})();

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $dialog = document.getElementById('dialog');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.player) headers['X-Player-Token'] = S.player;
  if (S.admin) headers.Authorization = `Bearer ${S.admin}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/api/admin') && S.admin) {
    S.admin = ''; localStorage.removeItem('f7_admin');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 5000 : 2800);
}

const TZ = 'Europe/Madrid';
function fmtDate(dateStr, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const out = new Intl.DateTimeFormat('es-ES', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return out.charAt(0).toUpperCase() + out.slice(1);
}
function fmtShort(dateStr) { return fmtDate(dateStr, { weekday: 'short', day: 'numeric', month: 'short' }); }
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

const prioBadge = (p) => `<span class="prio prio-${p}" title="Prioridad ${p}">P${p}</span>`;
const PRIO_LEGEND = `<div class="prio-legend">
  <span>${prioBadge(1)} No vino la semana pasada</span>
  <span>${prioBadge(2)} Sí vino</span>
  <span>${prioBadge(3)} Sanción</span></div>`;

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); }
  catch { prompt('Copia el texto:', text); }
}

async function loadRules() {
  if (!S.rules) S.rules = await api('/api/rules');
  return S.rules;
}

// ---------- Router ----------

const routes = [
  [/^#\/?$/, viewHome],
  [/^#\/clasificacion$/, viewStats],
  [/^#\/resultados$/, viewResultsList],
  [/^#\/resultados\/(\d+)$/, viewResultsDetail],
  [/^#\/normas$/, viewRules],
  [/^#\/admin(?:\/(\w+))?$/, viewAdmin],
];

function renderNav() {
  const h = location.hash || '#/';
  const items = [];
  if (S.player) items.push(['#/', 'Convocatoria']);
  if (S.player || S.admin) items.push(['#/clasificacion', 'Clasificación'], ['#/resultados', 'Resultados']);
  items.push(['#/normas', 'Normas'], ['#/admin', 'Coordinación']);
  $nav.innerHTML = items.map(([href, label]) => {
    const active = href === '#/' ? (h === '#/' || h === '#') : h.startsWith(href);
    return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
  }).join('');
}

async function render() {
  renderNav();
  const h = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      try { await fn(...m.slice(1)); }
      catch (e) { $app.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', render);

// Delegación de eventos: data-act="nombre" -> actions.nombre(el, event)
const actions = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch((err) => toast(err.message, true)); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = actions[el.dataset.change];
  if (fn) Promise.resolve(fn(el, e)).catch((err) => toast(err.message, true));
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el && actions[el.dataset.input]) actions[el.dataset.input](el, e);
});

// ---------- Jugador: convocatoria ----------

async function viewHome() {
  if (!S.player) {
    $app.innerHTML = `<div class="card empty">
      <h1>⚽ Convocatorias Fútbol 7</h1>
      <p>Para apuntarte a los entrenamientos abre el <strong>enlace personal</strong> que te ha enviado Coordinación por WhatsApp.</p>
      <p class="small">¿Eres de coordinación? <a href="#/admin">Entra aquí</a>.</p></div>`;
    return;
  }
  let me;
  try { me = await api('/api/me'); }
  catch (e) {
    $app.innerHTML = `<div class="card empty"><h2>Enlace no válido</h2><p>${esc(e.message)}. Pide a Coordinación un enlace nuevo.</p>
      <button data-act="forgetPlayer">Olvidar este enlace</button></div>`;
    return;
  }
  const s = me.session;
  let html = `<div class="row spread" style="margin-bottom:.75rem"><h1 style="margin:0">Hola, ${esc(me.player.name.split(' ')[0])} 👋</h1></div>`;

  if (me.expelled) {
    html += `<div class="status-box danger"><strong>Tienes dos faltas graves esta temporada</strong>
      Según las normas de la sección quedas fuera del equipo. Habla con Coordinación.</div>`;
  }

  if (!s) {
    html += `<div class="card empty"><h2>No hay entrenamientos convocados</h2><p>La convocatoria se abre los domingos a las 17:00.</p></div>`;
  } else {
    const sess = s.session;
    const total = s.titulares.length + s.reservas.length;
    const mine = s.my_entry;
    let box;
    if (sess.cancelled) box = `<div class="status-box danger"><strong>Entrenamiento cancelado</strong></div>`;
    else if (mine && mine.role === 'titular') {
      box = `<div class="status-box ok"><strong>✅ Vas · titular (puesto ${mine.position})</strong>
        ${prioBadge(mine.priority)} <span class="small">${esc(mine.reason)}</span></div>`;
    } else if (mine) {
      box = `<div class="status-box warn"><strong>⏳ Estás en reservas (puesto ${mine.position})</strong>
        Si alguien se borra subes automáticamente. ${prioBadge(mine.priority)} <span class="small">${esc(mine.reason)}</span></div>`;
    } else if (s.my_response === 'no') {
      box = `<div class="status-box"><strong>Has dicho que no vas</strong>Si cambias de idea, apúntate (entrarás según tu prioridad y la hora).</div>`;
    } else {
      box = `<div class="status-box"><strong>Aún no has respondido</strong>${sess.is_open ? 'Apúntate solo si estás seguro/a de poder ir.' : ''}</div>`;
    }

    const canYes = sess.is_open && !mine && !me.expelled;
    const canNo = !sess.has_started && !sess.cancelled && s.my_response !== 'no';
    html += `<div class="card">
      <div class="row spread">
        <div>
          <div class="hero-date">${esc(fmtDate(sess.date))} · ${esc(sess.start_time)}</div>
          <div class="muted">📍 ${esc(sess.location)} · llega a las 21:45</div>
        </div>
        <div class="row">
          ${sess.finalized_at ? '<span class="chip ok">Lista final</span>' : '<span class="chip">Lista provisional</span>'}
          <span class="chip">${s.titulares.length}/${sess.capacity} plazas</span>
        </div>
      </div>
      ${!sess.is_open && !sess.has_started && !sess.cancelled ? `<p class="small muted" style="margin-top:.5rem">La convocatoria se abre el ${esc(fmtDateTime(sess.opens_at))}.</p>` : ''}
      ${box}
      <div class="row">
        <button class="btn btn-yes btn-big" data-act="answerYes" data-id="${sess.id}" ${canYes ? '' : 'disabled'}>Voy</button>
        <button class="btn btn-no btn-big" data-act="answerNo" data-id="${sess.id}" ${canNo ? '' : 'disabled'}>No voy</button>
      </div>
      <p class="small muted" style="margin:.75rem 0 0">Puedes borrarte sin penalización hasta el ${esc(fmtDateTime(sess.tuesday_deadline))}.
      La lista final se genera el lunes. ${sess.petos ? `🦺 Petos: ${esc(sess.petos)}.` : ''} ${sess.balones ? `⚽ Balones: ${esc(sess.balones)}.` : ''}</p>
    </div>`;

    html += `<div class="card"><div class="row spread"><h2 style="margin:0">Lista (${total})</h2>${PRIO_LEGEND}</div>
      ${renderList(s, me.player.id)}</div>`;
  }

  if (me.infractions.length) {
    html += `<div class="card"><h2>Mis incidencias</h2><ul class="list">${me.infractions.map((i) => `
      <li><div class="name">${esc(i.label)}<small>${esc(fmtShort(i.date))} · ${i.weeks === 2 ? '2 semanas en P3' : '1 semana en P3'}</small></div>
      ${infStatusChip(i.status)}</li>`).join('')}</ul></div>`;
  }
  $app.innerHTML = html;
}

function renderList(s, meId, { admin = false } = {}) {
  const row = (e) => `<li class="${e.player_id === meId ? 'me' : ''}">
    <span class="pos">${e.position}</span>${prioBadge(e.priority)}
    <span class="name">${esc(e.name)}${e.is_coordinator ? ' <span class="chip">coord.</span>' : ''}
      <small>${esc(e.reason)} · ${e.signed_up_at ? esc(fmtTime(e.signed_up_at)) : ''}${e.added_by_admin ? ' · añadido por coordinación' : ''}</small></span>
    ${admin ? `<button class="btn-sm btn-ghost" data-act="adminSetResponse" data-pid="${e.player_id}" data-answer="no" title="Quitar">✕</button>` : ''}
  </li>`;
  let html = `<div class="divider">Titulares</div>`;
  html += s.titulares.length ? `<ul class="list">${s.titulares.map(row).join('')}</ul>` : '<p class="muted small">Nadie apuntado todavía.</p>';
  if (s.reservas.length) html += `<div class="divider">Reservas</div><ul class="list">${s.reservas.map(row).join('')}</ul>`;
  if (s.no_van.length) {
    html += `<div class="divider">No van (${s.no_van.length})</div><p class="small muted">${s.no_van.map((n) => esc(n.name)).join(', ')}</p>`;
  }
  return html;
}

function infStatusChip(status) {
  return status === 'pending' ? '<span class="chip warn">Pendiente de revisar</span>'
    : status === 'justified' ? '<span class="chip ok">Justificada</span>'
      : '<span class="chip danger">Confirmada</span>';
}

actions.forgetPlayer = () => { localStorage.removeItem('f7_player'); S.player = ''; render(); };

actions.answerYes = async (el) => {
  el.disabled = true;
  try { await api(`/api/sessions/${el.dataset.id}/response`, { method: 'PUT', body: { answer: 'yes' } }); toast('¡Apuntado/a! ⚽'); }
  finally { render(); }
};

actions.answerNo = async (el) => {
  const me = await api('/api/me');
  const s = me.session;
  const sess = s.session;
  const now = new Date();
  let warning = '';
  if (s.my_entry) {
    if (now > new Date(sess.wednesday_deadline)) {
      warning = 'Te borras después de las 15h del miércoles. Si no hay motivo justificado supone <strong>2 semanas en prioridad 3</strong> y cuenta como <strong>falta grave</strong> (dos en la temporada = fuera del equipo).';
    } else if (now > new Date(sess.tuesday_deadline)) {
      warning = 'Te borras después de las 15h del martes. Si no hay motivo justificado tendrás <strong>prioridad 3</strong> la próxima semana.';
    }
    if (sess.finalized_at) {
      warning += `${warning ? '<br><br>' : ''}La lista final ya está publicada: <strong>avisa a Coordinación</strong> al borrarte
        (si no, ${s.my_entry.role === 'titular' ? '2 semanas' : '1 semana'} en prioridad 3).`;
    }
  }
  $dialog.innerHTML = `<form method="dialog" class="stack">
    <h2>¿No vas el ${esc(fmtDate(sess.date))}?</h2>
    ${warning ? `<div class="status-box warn small">${warning}</div>` : ''}
    <label class="field">Motivo (opcional, lo verá Coordinación)<textarea id="cancelReason" placeholder="Ej.: lesión, trabajo…"></textarea></label>
    ${s.my_entry && sess.finalized_at ? '<label><input type="checkbox" id="cancelNotified"> He avisado a Coordinación</label>' : ''}
    <div class="row" style="justify-content:flex-end">
      <button value="cancel" class="btn-ghost">Volver</button>
      <button value="ok" class="btn-no" id="confirmNo">No voy</button>
    </div></form>`;
  $dialog.showModal();
  $dialog.onclose = async () => {
    if ($dialog.returnValue !== 'ok') return;
    const body = {
      answer: 'no',
      reason: document.getElementById('cancelReason')?.value || '',
      notified: document.getElementById('cancelNotified')?.checked || false,
    };
    try {
      const r = await api(`/api/sessions/${sess.id}/response`, { method: 'PUT', body });
      toast(r.infraction ? `Anotado. Coordinación revisará: ${r.infraction.label}` : 'Anotado: no vas', !!r.infraction);
    } catch (e) { toast(e.message, true); }
    render();
  };
};

// ---------- Clasificación ----------

async function viewStats() {
  if (!S.player && !S.admin) return viewHome();
  const data = await api('/api/stats');
  S.statsData = data;
  renderStats();
}

function renderStats() {
  const data = S.statsData;
  const cols = [
    ['name', 'Jugador', false], ['attended', 'Asist.', true], ['current_quarter_count', 'Trim.', true],
    ['played', 'PJ', true], ['wins', 'G', true], ['draws', 'E', true], ['losses', 'P', true], ['points', 'Pts', true],
    ['goals', 'Goles', true], ['assists', 'Asist. gol', true], ['mvps', 'MVP', true], ['saves', 'Paradas', true],
  ];
  if (S.admin) cols.push(['infractions', 'Incid.', true]);
  const { key, dir } = S.sort;
  const rows = [...data.players].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb) || a.name.localeCompare(b.name);
  });
  const leader = (k) => Math.max(0, ...data.players.map((p) => p[k]));
  const top = [['points', 'Más puntos'], ['goals', 'Máximo goleador'], ['assists', 'Más asistencias'], ['attended', 'Más entrenos']]
    .map(([k, label]) => {
      const best = leader(k);
      const tied = best ? data.players.filter((p) => p[k] === best) : [];
      const who = !tied.length ? '—' : tied.length > 3 ? `${tied.length} empatados` : tied.map((p) => p.name).join(', ');
      return `<div class="card" style="margin:0"><div class="small muted">${label}</div><div style="font-size:1.4rem;font-weight:800">${best || '—'}</div><div class="small">${esc(who)}</div></div>`;
    }).join('');
  $app.innerHTML = `<h1>Clasificación de la temporada</h1>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:1rem">${top}</div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr>${cols.map(([k, l, n]) => `<th class="${n ? 'num' : ''}" data-act="sortStats" data-key="${k}">${l}${k === key ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => `<tr class="${p.active ? '' : 'dim'}">${cols.map(([k, , n]) => {
        let v = esc(p[k]);
        if (k === 'name') v = `${esc(p.name)}${p.expelled ? ' <span class="chip danger">fuera</span>' : ''}`;
        if (k === 'current_quarter_count') {
          const low = !p.attendance_exempt && p[k] < data.min_per_quarter;
          v = p.attendance_exempt ? '<span class="chip">exento</span>' : `<span class="chip ${low ? 'warn' : 'ok'}">${p[k]}/${data.min_per_quarter}</span>`;
        }
        return `<td class="${n ? 'num' : ''}">${v}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin-top:.75rem">Puntos: 3 por partido ganado y 1 por empate con tu equipo. «Trim.» = entrenos este trimestre
    (mínimo ${data.min_per_quarter} cada tres meses; si te quedaste fuera por lista llena no cuenta como falta).</p></div>`;
}
actions.sortStats = (el) => {
  const k = el.dataset.key;
  S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'name' ? 1 : -1) };
  renderStats();
};

// ---------- Resultados ----------

async function viewResultsList() {
  if (!S.player && !S.admin) return viewHome();
  const sessions = (await api('/api/sessions')).filter((s) => s.has_results);
  $app.innerHTML = `<h1>Resultados</h1>${sessions.length ? `<div class="card"><ul class="list">${sessions.map((s) => `
    <li><span class="name"><a href="#/resultados/${s.id}">${esc(fmtDate(s.date))}</a></span><span class="chip">${s.yes_count} apuntados</span></li>`).join('')}
    </ul></div>` : '<div class="card empty">Todavía no hay resultados.</div>'}`;
}

async function viewResultsDetail(id) {
  const r = await api(`/api/sessions/${id}/results`);
  $app.innerHTML = `<p><a href="#/resultados">← Resultados</a></p><h1>${esc(fmtDate(r.session.date))}</h1>${renderResults(r)}`;
}

function renderResults(r) {
  if (!r.teams.length) return '<div class="card empty">Sin resultados registrados.</div>';
  const teamName = new Map(r.teams.map((t) => [t.id, t]));
  const dot = (t) => `<span class="team-dot" style="background:${esc(t?.color || '#ccc')}"></span>`;
  const winner = r.table[0] && r.table[0].pts > (r.table[1]?.pts ?? -1) ? r.table[0] : null;
  return `
  ${winner ? `<div class="status-box ok"><strong>🏆 Ganador del día: ${esc(winner.name)}</strong>${winner.pts} puntos</div>` : ''}
  <div class="grid grid-2">
    <div class="card"><h2>Clasificación del día</h2><div class="table-wrap"><table>
      <thead><tr><th>Equipo</th><th class="num">PJ</th><th class="num">G</th><th class="num">E</th><th class="num">P</th><th class="num">GF</th><th class="num">GC</th><th class="num">Pts</th></tr></thead>
      <tbody>${r.table.map((t) => `<tr><td>${dot(t)} ${esc(t.name)}</td><td class="num">${t.pj}</td><td class="num">${t.w}</td><td class="num">${t.d}</td><td class="num">${t.l}</td><td class="num">${t.gf}</td><td class="num">${t.gc}</td><td class="num"><strong>${t.pts}</strong></td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="card"><h2>Partidos</h2><ul class="list">${r.matches.map((m) => {
      const h = teamName.get(m.home_team_id), a = teamName.get(m.away_team_id);
      return `<li><span class="name">${dot(h)} ${esc(h?.name)}</span><span class="score">${m.home_goals} – ${m.away_goals}</span><span class="name" style="text-align:right">${esc(a?.name)} ${dot(a)}</span></li>`;
    }).join('')}</ul></div>
  </div>
  <div class="grid grid-2">
    <div class="card"><h2>Equipos</h2>${r.teams.map((t) => `<p><strong>${dot(t)} ${esc(t.name)}</strong><br><span class="small">${t.players.map((p) => esc(p.name)).join(', ') || '—'}</span></p>`).join('')}</div>
    <div class="card"><h2>Estadísticas</h2>${r.stats.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Jugador</th><th class="num">Goles</th><th class="num">Asist.</th><th class="num">Paradas</th><th></th></tr></thead>
      <tbody>${r.stats.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.goals}</td><td class="num">${s.assists}</td><td class="num">${s.saves}</td><td>${s.mvp ? '⭐ MVP' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">—</p>'}
    </div>
  </div>
  ${r.notes ? `<div class="card"><h2>Notas</h2><p style="white-space:pre-wrap">${esc(r.notes)}</p></div>` : ''}`;
}

// ---------- Normas ----------

async function viewRules() {
  const { infraction_types: T } = await loadRules();
  $app.innerHTML = `<h1>Normas de los entrenamientos</h1>
  <div class="card"><h2>Entrenamientos</h2><ul class="rules">
    <li>Miércoles de 22:00 a 23:00 en el Polideportivo Marqués de Samaranch. Llega a las 21:45 para cambiarte.</li>
    <li>La convocatoria se abre el <strong>domingo a las 17:00</strong>. Si no estás seguro/a de poder ir, no te apuntes.</li>
    <li>Convocatorias de 14 o 16 personas. Si está llena quedas en reservas: subes automáticamente si alguien se borra.</li>
    <li>El <strong>lunes</strong> se genera la lista final.</li>
    <li>No te borres con menos de un día de antelación.</li></ul></div>
  <div class="card"><h2>Sistema de prioridades</h2>
    <p>El orden para entrar se decide primero por prioridad y después por la hora de inscripción.</p>
    <ul class="rules">
      <li>${prioBadge(1)} Quien <strong>no</strong> asistió al entrenamiento de la semana anterior, y al menos un coordinador.</li>
      <li>${prioBadge(2)} Quien <strong>sí</strong> asistió al entrenamiento de la semana anterior.</li>
      <li>${prioBadge(3)} Quien la semana anterior cometió alguna de estas infracciones:</li>
    </ul>
    <ul class="list">${Object.values(T).map((t) => `<li><span class="name">${esc(t.label)}</span>
      <span class="chip ${t.serious ? 'danger' : t.weeks === 2 ? 'warn' : ''}">${t.weeks === 2 ? '2 semanas' : '1 semana'}${t.serious ? ' · grave' : ''}</span></li>`).join('')}</ul>
    <p class="small muted" style="margin-top:.75rem">Quien cometa dos faltas graves en la temporada queda automáticamente fuera del equipo.</p></div>
  <div class="card"><h2>Asistencia</h2><ul class="rules">
    <li>Mínimo <strong>4 entrenamientos cada tres meses</strong> para seguir inscrito/a.</li>
    <li>Por motivos justificados (lesiones, períodos fuera…) no se tiene en cuenta.</li>
    <li>Si te quedaste fuera porque la convocatoria estaba llena, no cuenta como falta.</li></ul></div>`;
}

// ---------- Coordinación ----------

const ADMIN_TABS = [
  ['convocatoria', 'Convocatoria'], ['asistencia', 'Asistencia'], ['resultados', 'Resultados'],
  ['incidencias', 'Incidencias'], ['jugadores', 'Jugadores'], ['clasificacion', 'Clasificación'],
];

async function viewAdmin(tab = 'convocatoria') {
  if (!S.admin) {
    $app.innerHTML = `<div class="card" style="max-width:420px;margin:2rem auto">
      <h1>Coordinación</h1><form id="loginForm" class="stack">
      <label class="field">Contraseña<input type="password" id="pw" autocomplete="current-password" required></label>
      <button class="btn-primary" type="submit">Entrar</button></form></div>`;
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/admin/login', { method: 'POST', body: { password: document.getElementById('pw').value } });
        S.admin = r.token; localStorage.setItem('f7_admin', r.token); render();
      } catch (err) { toast(err.message, true); }
    };
    return;
  }
  if (tab === 'clasificacion') {
    await viewStats();
    $app.insertAdjacentHTML('afterbegin', adminTabsHtml(tab, null));
    return;
  }
  const ov = await api('/api/admin/overview');
  S.overview = ov;
  if (!S.adminSessionId || !ov.sessions.some((s) => s.id === S.adminSessionId)) {
    S.adminSessionId = ov.current_id || ov.sessions[0]?.id || null;
  }
  const head = adminTabsHtml(tab, ov) + sessionPicker(ov, tab);
  const fn = { convocatoria: adminConvocatoria, asistencia: adminAsistencia, resultados: adminResultados, incidencias: adminIncidencias, jugadores: adminJugadores }[tab];
  if (!fn) { location.hash = '#/admin'; return; }
  $app.innerHTML = head + '<div id="adminBody"><p class="muted">Cargando…</p></div>';
  await fn(document.getElementById('adminBody'));
}

function adminTabsHtml(tab, ov) {
  return `<div class="row spread"><h1 style="margin:0">Coordinación</h1><button class="btn-sm btn-ghost" data-act="logout">Salir</button></div>
  <nav class="tabs">${ADMIN_TABS.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'incidencias' && ov?.pending_infractions ? `<span class="badge">${ov.pending_infractions}</span>` : ''}</a>`).join('')}</nav>`;
}

function sessionPicker(ov, tab) {
  if (['incidencias', 'jugadores'].includes(tab)) return '';
  return `<div class="row" style="margin-bottom:1rem">
    <select data-change="pickSession" aria-label="Entrenamiento">${ov.sessions.map((s) => `<option value="${s.id}" ${s.id === S.adminSessionId ? 'selected' : ''}>
      ${esc(fmtShort(s.date))}${s.cancelled ? ' (cancelado)' : ''}${s.id === ov.current_id ? ' · próximo' : ''}</option>`).join('')}</select>
    <button class="btn-primary btn-sm" data-act="newSession">+ Nuevo entrenamiento</button></div>`;
}

actions.logout = () => { S.admin = ''; localStorage.removeItem('f7_admin'); render(); };
actions.pickSession = (el) => {
  S.adminSessionId = Number(el.value); sessionStorage.setItem('f7_admin_session', el.value);
  S.res = null; S.att = null; render();
};
actions.newSession = () => {
  $dialog.innerHTML = `<form method="dialog" class="stack"><h2>Nuevo entrenamiento</h2>
    <label class="field">Fecha<input type="date" id="nsDate" value="${S.overview.next_wednesday}" required></label>
    <div class="row">
      <label class="field">Hora<input type="time" id="nsTime" value="22:00"></label>
      <label class="field">Plazas<select id="nsCap"><option>16</option><option>14</option><option>18</option><option>21</option></select></label>
    </div>
    <label class="field">Lugar<input id="nsLoc" value="Polideportivo Marqués de Samaranch"></label>
    <div class="row" style="justify-content:flex-end"><button value="cancel" class="btn-ghost">Cancelar</button><button value="ok" class="btn-primary">Crear</button></div></form>`;
  $dialog.showModal();
  $dialog.onclose = async () => {
    if ($dialog.returnValue !== 'ok') return;
    try {
      const r = await api('/api/admin/sessions', { method: 'POST', body: {
        date: document.getElementById('nsDate').value, start_time: document.getElementById('nsTime').value,
        capacity: Number(document.getElementById('nsCap').value), location: document.getElementById('nsLoc').value,
      } });
      S.adminSessionId = r.id; sessionStorage.setItem('f7_admin_session', r.id);
      toast('Entrenamiento creado'); location.hash = '#/admin/convocatoria'; render();
    } catch (e) { toast(e.message, true); }
  };
};

function noSession(el) {
  el.innerHTML = '<div class="card empty"><h2>No hay entrenamientos</h2><p>Crea el primero con «+ Nuevo entrenamiento».</p></div>';
}

// --- Convocatoria ---
async function adminConvocatoria(el) {
  if (!S.adminSessionId) return noSession(el);
  const d = await api(`/api/admin/sessions/${S.adminSessionId}`);
  S.detail = d;
  const s = d.session;
  const players = (await api('/api/admin/players')).filter((p) => p.active);
  S.players = players;
  const opts = (sel) => `<option value="">—</option>${players.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  const inList = new Set([...d.titulares, ...d.reservas].map((e) => e.player_id));
  el.innerHTML = `
  <div class="card">
    <div class="row spread">
      <div><div class="hero-date">${esc(fmtDate(s.date))} · ${esc(s.start_time)}</div>
        <div class="small muted">Abre ${esc(fmtDateTime(s.opens_at))} · lista final el ${esc(fmtShort(s.list_day))} · sin penalización hasta ${esc(fmtDateTime(s.tuesday_deadline))}</div></div>
      <div class="row">${s.cancelled ? '<span class="chip danger">Cancelado</span>' : s.finalized_at ? `<span class="chip ok">Lista final · ${esc(fmtDateTime(s.finalized_at))}</span>` : '<span class="chip">Provisional</span>'}</div>
    </div>
    <div class="row" style="margin-top:.75rem">
      <label class="field">Plazas<input type="number" min="2" max="40" value="${s.capacity}" data-change="patchSession" data-field="capacity"></label>
      <label class="field">🦺 Petos<select data-change="patchSession" data-field="petos_player_id">${opts(s.petos_player_id)}</select></label>
      <label class="field">⚽ Balones<select data-change="patchSession" data-field="balones_player_id">${opts(s.balones_player_id)}</select></label>
    </div>
    <div class="row" style="margin-top:1rem">
      <button class="btn-primary" data-act="finalize">${s.finalized_at ? '↻ Regenerar lista final' : '📋 Generar lista final (lunes)'}</button>
      ${s.finalized_at ? '<button data-act="unfinalize">Volver a provisional</button>' : ''}
      <button class="btn-ghost" data-act="toggleCancel">${s.cancelled ? 'Reactivar' : 'Cancelar entrenamiento'}</button>
      <button class="btn-ghost" data-act="deleteSession">Eliminar</button>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card"><div class="row spread"><h2 style="margin:0">Lista (${d.titulares.length}/${s.capacity}${d.reservas.length ? ` + ${d.reservas.length} reservas` : ''})</h2></div>
      ${d.previous ? `<p class="small muted">Prioridades según el entreno del ${esc(fmtShort(d.previous.date))}.</p>` : ''}
      ${PRIO_LEGEND}${renderList(d, null, { admin: true })}
      <div class="row" style="margin-top:1rem">
        <select id="addPlayer"><option value="">Añadir a alguien…</option>${players.filter((p) => !inList.has(p.id)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <button class="btn-sm" data-act="adminAdd">Añadir</button>
      </div></div>
    <div class="stack">
      <div class="card"><div class="row spread"><h2 style="margin:0">Mensaje para WhatsApp</h2><button class="btn-sm" data-act="copyWa">Copiar</button></div>
        <pre class="wa">${esc(d.whatsapp)}</pre></div>
      <div class="card"><h2>Sin responder (${d.sin_responder.length})</h2><p class="small">${d.sin_responder.map((p) => esc(p.name)).join(', ') || '—'}</p>
        ${d.no_van.length ? `<h3>No van</h3><ul class="list">${d.no_van.map((n) => `<li><span class="name">${esc(n.name)}<small>${esc(n.cancel_reason || '')} ${esc(fmtTime(n.updated_at))}</small></span></li>`).join('')}</ul>` : ''}
      </div>
      ${d.infractions.length ? `<div class="card"><h2>Incidencias de este entreno</h2><ul class="list">${d.infractions.map((i) => `<li><span class="name">${esc(i.name)}<small>${esc(S.rules?.infraction_types[i.type]?.label || i.type)}</small></span>${infStatusChip(i.status)}</li>`).join('')}</ul><a href="#/admin/incidencias" class="small">Revisar incidencias →</a></div>` : ''}
    </div>
  </div>`;
}
actions.copyWa = () => copyText(S.detail.whatsapp);
actions.patchSession = async (el) => {
  const v = el.type === 'number' ? Number(el.value) : (el.value === '' ? null : Number(el.value));
  await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'PATCH', body: { [el.dataset.field]: v } });
  toast('Guardado'); render();
};
actions.finalize = async () => {
  const r = await api(`/api/admin/sessions/${S.adminSessionId}/finalize`, { method: 'POST' });
  await copyText(r.whatsapp).catch(() => {});
  toast('Lista final generada y copiada'); render();
};
actions.unfinalize = async () => {
  await api(`/api/admin/sessions/${S.adminSessionId}/unfinalize`, { method: 'POST' }); render();
};
actions.toggleCancel = async () => {
  await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'PATCH', body: { cancelled: !S.detail.session.cancelled } }); render();
};
actions.deleteSession = async () => {
  if (!confirm('¿Eliminar este entrenamiento y todos sus datos (lista, asistencia, resultados)?')) return;
  await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'DELETE' });
  S.adminSessionId = null; render();
};
actions.adminSetResponse = async (el) => {
  await api(`/api/admin/sessions/${S.adminSessionId}/responses/${el.dataset.pid}`, { method: 'PUT', body: { answer: el.dataset.answer } });
  render();
};
actions.adminAdd = async () => {
  const pid = document.getElementById('addPlayer').value;
  if (!pid) return;
  await api(`/api/admin/sessions/${S.adminSessionId}/responses/${pid}`, { method: 'PUT', body: { answer: 'yes' } });
  render();
};

// --- Asistencia ---
async function adminAsistencia(el) {
  if (!S.adminSessionId) return noSession(el);
  const [d, rules] = [await api(`/api/admin/sessions/${S.adminSessionId}`), await loadRules()];
  S.detail = d;
  const saved = new Map(d.attendance.map((a) => [a.player_id, a.status]));
  if (!S.att || S.att.sid !== S.adminSessionId) {
    const rows = [...d.titulares, ...d.reservas].map((e) => ({
      player_id: e.player_id, name: e.name, role: e.role,
      status: saved.get(e.player_id) || (e.role === 'titular' ? 'attended' : 'left_out'),
    }));
    // Personas con asistencia guardada que ya no están en la lista (p. ej. se borraron tarde)
    for (const [pid, status] of saved) {
      if (!rows.some((r) => r.player_id === pid)) {
        const n = d.no_van.find((x) => x.player_id === pid)?.name || `#${pid}`;
        rows.push({ player_id: pid, name: n, role: 'otro', status });
      }
    }
    S.att = { sid: S.adminSessionId, rows };
  }
  const tone = { late: 'meh', no_show: 'bad', excused: '', attended: '', left_out: '' };
  el.innerHTML = `<div class="card">
    <div class="row spread"><h2 style="margin:0">Pasar lista</h2>${d.attendance.length ? '<span class="chip ok">Guardada</span>' : '<span class="chip warn">Sin guardar</span>'}</div>
    <p class="small muted">«Llegó tarde» (después de las 21:50 sin avisar) y «No se presentó» crean la incidencia automáticamente.
    La asistencia decide las prioridades de la semana que viene.</p>
    <ul class="list">${S.att.rows.map((r, i) => `<li style="flex-wrap:wrap">
      <span class="name">${esc(r.name)}<small>${r.role}</small></span>
      <span class="seg">${Object.entries(rules.attendance_statuses).map(([k, l]) => `<button class="${r.status === k ? `on ${tone[k]}` : ''}" data-act="setAtt" data-i="${i}" data-status="${k}">${l}</button>`).join('')}</span>
    </li>`).join('')}</ul>
    <div class="row" style="margin-top:1rem">
      <select id="attAdd"><option value="">Añadir a alguien que vino…</option>${d.no_van.concat(d.sin_responder.map((p) => ({ player_id: p.id, name: p.name })))
        .filter((p) => !S.att.rows.some((r) => r.player_id === p.player_id)).map((p) => `<option value="${p.player_id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn-sm" data-act="attAdd">Añadir</button>
    </div>
    <div class="row" style="margin-top:1rem"><button class="btn-primary" data-act="saveAtt">Guardar asistencia</button></div>
  </div>`;
}
actions.setAtt = (el) => { S.att.rows[Number(el.dataset.i)].status = el.dataset.status; adminAsistencia(document.getElementById('adminBody')); };
actions.attAdd = () => {
  const sel = document.getElementById('attAdd');
  if (!sel.value) return;
  S.att.rows.push({ player_id: Number(sel.value), name: sel.selectedOptions[0].textContent, role: 'otro', status: 'attended' });
  adminAsistencia(document.getElementById('adminBody'));
};
actions.saveAtt = async () => {
  await api(`/api/admin/sessions/${S.adminSessionId}/attendance`, { method: 'PUT', body: { items: S.att.rows.map(({ player_id, status }) => ({ player_id, status })) } });
  S.att = null; toast('Asistencia guardada'); render();
};

// --- Resultados ---
const TEAM_COLORS = ['#f97316', '#f8fafc', '#2563eb', '#16a34a', '#facc15', '#111827'];

async function adminResultados(el) {
  if (!S.adminSessionId) return noSession(el);
  const d = await api(`/api/admin/sessions/${S.adminSessionId}`);
  S.detail = d;
  if (!S.res || S.res.sid !== S.adminSessionId) {
    const r = d.results;
    const idx = new Map(r.teams.map((t, i) => [t.id, i]));
    const stats = {};
    for (const st of r.stats) stats[st.player_id] = { goals: st.goals, assists: st.assists, saves: st.saves, mvp: !!st.mvp };
    const assign = {};
    r.teams.forEach((t, i) => t.players.forEach((p) => { assign[p.id] = i; }));
    // Jugadores: los que asistieron (o titulares si no se pasó lista) + los que ya estaban en un equipo
    const names = new Map();
    const attended = d.attendance.length
      ? d.attendance.filter((a) => a.status === 'attended' || a.status === 'late').map((a) => a.player_id)
      : d.titulares.map((e) => e.player_id);
    const all = [...d.titulares, ...d.reservas, ...d.no_van];
    for (const pid of attended) names.set(pid, all.find((e) => e.player_id === pid)?.name || `#${pid}`);
    r.teams.forEach((t) => t.players.forEach((p) => names.set(p.id, p.name)));
    S.res = {
      sid: S.adminSessionId,
      teams: r.teams.length ? r.teams.map((t) => ({ name: t.name, color: t.color || '#cccccc' }))
        : [{ name: 'Petos', color: TEAM_COLORS[0] }, { name: 'Sin petos', color: TEAM_COLORS[1] }],
      matches: r.matches.map((m) => ({ home: idx.get(m.home_team_id), away: idx.get(m.away_team_id), home_goals: m.home_goals, away_goals: m.away_goals })),
      players: [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      assign, stats, notes: r.notes || '',
    };
  }
  renderResEditor(el);
}

function renderResEditor(el = document.getElementById('adminBody')) {
  const R = S.res;
  const teamOpts = (sel) => R.teams.map((t, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const st = (pid) => R.stats[pid] || { goals: 0, assists: 0, saves: 0, mvp: false };
  el.innerHTML = `
  <div class="card"><div class="row spread"><h2 style="margin:0">Equipos</h2><button class="btn-sm" data-act="resAddTeam">+ Equipo</button></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:.75rem">${R.teams.map((t, i) => `
      <div class="team-card row"><input type="color" value="${esc(t.color)}" data-input="resTeam" data-i="${i}" data-f="color" style="width:44px;padding:2px">
        <input value="${esc(t.name)}" data-input="resTeam" data-i="${i}" data-f="name" style="flex:1;min-width:0">
        ${R.teams.length > 2 ? `<button class="btn-sm btn-ghost" data-act="resDelTeam" data-i="${i}">✕</button>` : ''}
        <span class="small muted" style="width:100%">${R.players.filter((p) => R.assign[p.id] === i).length} jugadores</span></div>`).join('')}</div></div>

  <div class="card"><div class="row spread"><h2 style="margin:0">Partidos</h2><button class="btn-sm" data-act="resAddMatch">+ Partido</button></div>
    ${R.matches.length ? `<ul class="list">${R.matches.map((m, i) => `<li style="flex-wrap:wrap">
      <select data-change="resMatch" data-i="${i}" data-f="home">${teamOpts(m.home)}</select>
      <input type="number" min="0" value="${m.home_goals}" data-input="resMatch" data-i="${i}" data-f="home_goals">
      <span>–</span>
      <input type="number" min="0" value="${m.away_goals}" data-input="resMatch" data-i="${i}" data-f="away_goals">
      <select data-change="resMatch" data-i="${i}" data-f="away">${teamOpts(m.away)}</select>
      <button class="btn-sm btn-ghost" data-act="resDelMatch" data-i="${i}">✕</button></li>`).join('')}</ul>`
      : '<p class="muted small">Añade los partidos jugados (si hacéis triangular, uno por cruce).</p>'}</div>

  <div class="card"><h2>Jugadores</h2>
    <p class="small muted">Asigna cada persona a su equipo y apunta goles, asistencias, paradas y MVP.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Jugador</th><th>Equipo</th><th class="num">Goles</th><th class="num">Asist.</th><th class="num">Paradas</th><th>MVP</th></tr></thead>
      <tbody>${R.players.map((p) => `<tr>
        <td>${esc(p.name)}</td>
        <td><select data-change="resAssign" data-pid="${p.id}"><option value="">—</option>${teamOpts(R.assign[p.id])}</select></td>
        ${['goals', 'assists', 'saves'].map((f) => `<td class="num"><input type="number" min="0" value="${st(p.id)[f]}" data-input="resStat" data-pid="${p.id}" data-f="${f}"></td>`).join('')}
        <td><input type="checkbox" ${st(p.id).mvp ? 'checked' : ''} data-change="resStat" data-pid="${p.id}" data-f="mvp"></td>
      </tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:.75rem">
      <select id="resAddPlayer"><option value="">Añadir jugador…</option>${(S.players || []).filter((p) => !R.players.some((x) => x.id === p.id)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn-sm" data-act="resAddPlayer">Añadir</button></div>
  </div>

  <div class="card"><h2>Notas del entreno</h2>
    <textarea data-input="resNotes" placeholder="Incidencias, lesiones, jugadas destacadas…">${esc(R.notes)}</textarea></div>
  <div class="row"><button class="btn-primary" data-act="resSave">Guardar resultados</button></div>`;
  if (!S.players) api('/api/admin/players').then((ps) => { S.players = ps.filter((p) => p.active); renderResEditor(); });
}
actions.resTeam = (el) => { S.res.teams[el.dataset.i][el.dataset.f] = el.value; };
actions.resAddTeam = () => { const n = S.res.teams.length; S.res.teams.push({ name: `Equipo ${n + 1}`, color: TEAM_COLORS[n % TEAM_COLORS.length] }); renderResEditor(); };
actions.resDelTeam = (el) => {
  const i = Number(el.dataset.i);
  S.res.teams.splice(i, 1);
  S.res.matches = S.res.matches.filter((m) => m.home !== i && m.away !== i).map((m) => ({ ...m, home: m.home > i ? m.home - 1 : m.home, away: m.away > i ? m.away - 1 : m.away }));
  for (const k of Object.keys(S.res.assign)) {
    if (S.res.assign[k] === i) delete S.res.assign[k];
    else if (S.res.assign[k] > i) S.res.assign[k]--;
  }
  renderResEditor();
};
actions.resAddMatch = () => { S.res.matches.push({ home: 0, away: 1, home_goals: 0, away_goals: 0 }); renderResEditor(); };
actions.resDelMatch = (el) => { S.res.matches.splice(Number(el.dataset.i), 1); renderResEditor(); };
actions.resMatch = (el) => {
  const m = S.res.matches[el.dataset.i];
  m[el.dataset.f] = Number(el.value) || 0;
};
actions.resAssign = (el) => {
  if (el.value === '') delete S.res.assign[el.dataset.pid]; else S.res.assign[el.dataset.pid] = Number(el.value);
};
actions.resStat = (el) => {
  const pid = el.dataset.pid;
  S.res.stats[pid] ??= { goals: 0, assists: 0, saves: 0, mvp: false };
  S.res.stats[pid][el.dataset.f] = el.type === 'checkbox' ? el.checked : Number(el.value) || 0;
};
actions.resNotes = (el) => { S.res.notes = el.value; };
actions.resAddPlayer = () => {
  const sel = document.getElementById('resAddPlayer');
  if (!sel.value) return;
  S.res.players.push({ id: Number(sel.value), name: sel.selectedOptions[0].textContent });
  renderResEditor();
};
actions.resSave = async () => {
  const R = S.res;
  const bad = R.matches.find((m) => m.home === m.away);
  if (bad) return toast('Un partido tiene el mismo equipo a los dos lados', true);
  const body = {
    teams: R.teams.map((t, i) => ({ ...t, player_ids: Object.entries(R.assign).filter(([, ti]) => ti === i).map(([pid]) => Number(pid)) })),
    matches: R.matches,
    stats: Object.entries(R.stats).map(([pid, s]) => ({ player_id: Number(pid), ...s })),
    notes: R.notes,
  };
  await api(`/api/admin/sessions/${S.adminSessionId}/results`, { method: 'PUT', body });
  S.res = null; toast('Resultados guardados'); location.hash = `#/resultados/${S.adminSessionId}`;
};

// --- Incidencias ---
async function adminIncidencias(el) {
  const [list, rules, players] = [await api('/api/admin/infractions'), await loadRules(), await api('/api/admin/players')];
  const sessions = S.overview.sessions;
  const pending = list.filter((i) => i.status === 'pending');
  const rest = list.filter((i) => i.status !== 'pending');
  const expelled = players.filter((p) => p.expelled);
  const row = (i) => `<li style="flex-wrap:wrap">
    <span class="name"><strong>${esc(i.name)}</strong> · ${esc(fmtShort(i.date))}
      <small>${esc(i.label)} · ${i.weeks === 2 ? '2 semanas' : '1 semana'} en P3${i.serious ? ' · <b>grave</b>' : ''} · ${i.source === 'auto' ? 'automática al borrarse' : i.source === 'attendance' ? 'desde asistencia' : 'manual'}</small>
      ${i.note ? `<small>📝 ${esc(i.note)}</small>` : ''}</span>
    ${infStatusChip(i.status)}
    <span class="row">
      ${i.status !== 'confirmed' ? `<button class="btn-sm" data-act="infStatus" data-id="${i.id}" data-status="confirmed">Confirmar</button>` : ''}
      ${i.status !== 'justified' ? `<button class="btn-sm" data-act="infStatus" data-id="${i.id}" data-status="justified">Justificada</button>` : ''}
      <button class="btn-sm btn-ghost" data-act="infDelete" data-id="${i.id}" title="Eliminar">🗑</button>
    </span></li>`;
  el.innerHTML = `
  ${expelled.length ? `<div class="status-box danger"><strong>Fuera del equipo por 2 faltas graves</strong>${expelled.map((p) => esc(p.name)).join(', ')}.
    No pueden apuntarse mientras tengan 2 faltas graves confirmadas.</div>` : ''}
  <div class="card"><h2>Pendientes de revisar (${pending.length})</h2>
    <p class="small muted">Se crean solas cuando alguien se borra fuera de plazo o sin avisar. Solo cuentan para la prioridad cuando las confirmas.</p>
    ${pending.length ? `<ul class="list">${pending.map(row).join('')}</ul>` : '<p class="muted">Nada pendiente 👌</p>'}</div>
  <div class="card"><h2>Registrar incidencia</h2>
    <div class="row">
      <select id="infSession">${sessions.map((s) => `<option value="${s.id}" ${s.id === S.adminSessionId ? 'selected' : ''}>${esc(fmtShort(s.date))}</option>`).join('')}</select>
      <select id="infPlayer"><option value="">Jugador…</option>${players.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <select id="infType">${Object.entries(rules.infraction_types).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select>
    </div>
    <div class="row" style="margin-top:.5rem"><input id="infNote" placeholder="Nota (opcional)" style="flex:1"><button class="btn-primary" data-act="infCreate">Registrar</button></div></div>
  <div class="card"><h2>Historial (${rest.length})</h2>${rest.length ? `<ul class="list">${rest.map(row).join('')}</ul>` : '<p class="muted">Sin incidencias.</p>'}</div>`;
}
actions.infStatus = async (el) => {
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'PATCH', body: { status: el.dataset.status } });
  toast('Actualizada'); render();
};
actions.infDelete = async (el) => {
  if (!confirm('¿Eliminar esta incidencia?')) return;
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'DELETE' }); render();
};
actions.infCreate = async () => {
  const body = {
    session_id: Number(document.getElementById('infSession').value), player_id: Number(document.getElementById('infPlayer').value),
    type: document.getElementById('infType').value, note: document.getElementById('infNote').value,
  };
  if (!body.player_id) return toast('Elige un jugador', true);
  await api('/api/admin/infractions', { method: 'POST', body });
  toast('Incidencia registrada'); render();
};

// --- Jugadores ---
async function adminJugadores(el) {
  const players = await api('/api/admin/players');
  const link = (p) => `${location.origin}/?t=${p.token}`;
  S.playerLinks = new Map(players.map((p) => [p.id, { name: p.name, link: link(p) }]));
  el.innerHTML = `
  <div class="card"><h2>Añadir jugadores</h2>
    <textarea id="newNames" placeholder="Un nombre por línea"></textarea>
    <div class="row" style="margin-top:.5rem"><label><input type="checkbox" id="newCoord"> Son coordinadores</label>
    <button class="btn-primary" data-act="addPlayers">Añadir</button></div></div>
  <div class="card"><div class="row spread"><h2 style="margin:0">Jugadores (${players.filter((p) => p.active).length} activos)</h2>
    <button class="btn-sm" data-act="copyAllLinks">Copiar todos los enlaces</button></div>
    <p class="small muted">Cada persona tiene un enlace personal para confirmar asistencia. Envíaselo por privado.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Enlace</th><th>Coord.</th><th>Activo</th><th title="Exento del mínimo de asistencia (lesión, fuera…)">Exento</th><th class="num">Graves</th><th></th></tr></thead>
      <tbody>${players.map((p) => `<tr class="${p.active ? '' : 'dim'}">
        <td><input value="${esc(p.name)}" data-change="playerField" data-id="${p.id}" data-f="name" style="min-width:140px"></td>
        <td><button class="btn-sm" data-act="copyLink" data-id="${p.id}">Copiar enlace</button></td>
        <td><input type="checkbox" ${p.is_coordinator ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="is_coordinator"></td>
        <td><input type="checkbox" ${p.active ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="active"></td>
        <td><input type="checkbox" ${p.attendance_exempt ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="attendance_exempt"></td>
        <td class="num">${p.serious_infractions ? `<span class="chip ${p.expelled ? 'danger' : 'warn'}">${p.serious_infractions}</span>` : '0'}</td>
        <td><button class="btn-sm btn-ghost" data-act="regenToken" data-id="${p.id}" title="Invalida el enlace anterior">Nuevo enlace</button></td>
      </tr>`).join('')}</tbody></table></div></div>`;
}
actions.addPlayers = async () => {
  const names = document.getElementById('newNames').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  const r = await api('/api/admin/players', { method: 'POST', body: { names, is_coordinator: document.getElementById('newCoord').checked } });
  toast(`${r.created} añadidos`); render();
};
actions.playerField = async (el) => {
  const v = el.type === 'checkbox' ? el.checked : el.value;
  await api(`/api/admin/players/${el.dataset.id}`, { method: 'PATCH', body: { [el.dataset.f]: v } });
  toast('Guardado');
  if (el.type === 'checkbox') render();
};
actions.copyLink = (el) => {
  const p = S.playerLinks.get(Number(el.dataset.id));
  copyText(`Hola ${p.name.split(' ')[0]}! Este es tu enlace personal para confirmar asistencia a los entrenos de Fútbol 7: ${p.link}`);
};
actions.copyAllLinks = () => copyText([...S.playerLinks.values()].map((p) => `${p.name}: ${p.link}`).join('\n'));
actions.regenToken = async (el) => {
  if (!confirm('El enlace anterior dejará de funcionar. ¿Continuar?')) return;
  await api(`/api/admin/players/${el.dataset.id}/token`, { method: 'POST' }); render();
};

// ---------- Inicio ----------
loadRules().catch(() => {});
render();
