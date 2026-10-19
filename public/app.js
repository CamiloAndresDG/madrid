'use strict';

// ---------- Estado y utilidades ----------

const S = {
  token: localStorage.getItem('f7_token') || '',   // sesión de la cuenta (ver /api/auth/*)
  me: null,                                        // datos de /api/me (jugador, roles)
  adminSessionId: Number(sessionStorage.getItem('f7_admin_session')) || null,
  res: null,       // editor de resultados
  att: null,       // editor de asistencia
  sort: { key: 'points', dir: -1 },
};

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $dialog = document.getElementById('dialog');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && !path.startsWith('/api/auth/')) {
    forgetSession();
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
  [/^#\/clasificacion(?:\/(yo))?$/, viewStats],
  [/^#\/resultados$/, viewResultsList],
  [/^#\/resultados\/(\d+)$/, viewResultsDetail],
  [/^#\/normas$/, viewRules],
  [/^#\/admin(?:\/(\w+))?$/, viewAdmin],
  [/^#\/entrar$/, viewLogin],
  [/^#\/registro$/, viewRegister],
  [/^#\/salir$/, () => actions.logout()],
];

function renderNav() {
  const h = location.hash || '#/';
  const items = [];
  if (S.token) items.push(['#/', 'Convocatoria'], ['#/clasificacion', 'Clasificación'], ['#/resultados', 'Resultados']);
  items.push(['#/normas', 'Normas']);
  if (S.token && canManage()) items.push(['#/admin', 'Coordinación']);
  if (!S.token) items.push(['#/entrar', 'Entrar'], ['#/registro', 'Crear cuenta']);
  if (S.token) items.push(['#/salir', 'Salir']);
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
  if (!S.token) {
    $app.innerHTML = `<div class="card empty">
      <h1>⚽ Convocatorias Fútbol 7</h1>
      <p>Apúntate a los entrenamientos desde tu cuenta. Si ya tienes una, entra con tu email y contraseña.</p>
      <div class="row" style="justify-content:center;margin-top:1rem">
        <a class="btn btn-primary" href="#/registro">Crear cuenta</a>
        <a class="btn" href="#/entrar">Entrar</a></div></div>`;
    return;
  }
  let me;
  try { me = await api('/api/me'); }
  catch (e) {
    $app.innerHTML = `<div class="card empty"><h2>Tu sesión ha caducado</h2><p>Vuelve a entrar para seguir.</p>
      <a class="btn btn-primary" href="#/entrar">Entrar</a></div>`;
    return;
  }
  S.me = me;
  const s = me.session;
  let html = `<div class="row spread" style="margin-bottom:.75rem"><h1 style="margin:0">Hola, ${esc(me.player.name.split(' ')[0])} 👋</h1></div>`;

  if (me.expelled) {
    html += `<div class="status-box danger"><strong>Tienes dos faltas graves esta temporada</strong>
      Según las normas de la sección quedas fuera del equipo. Habla con Coordinación.</div>`;
  }

  if (!s) {
    html += `<div class="card empty"><h2>No hay convocatoria publicada</h2><p>Te aparecerá aquí en cuanto Coordinación la publique.</p></div>`;
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
    html += `<div class="card featured">
      <div class="row spread">
        <div>
          <div class="hero-date">${esc(fmtDate(sess.date))} · ${esc(sess.start_time)}</div>
          <div class="muted">📍 ${esc(sess.location)} · llega a las ${esc(sess.arrival_time || '21:45')}</div>
          ${sess.notes ? `<div class="small" style="margin-top:.35rem;white-space:pre-wrap">📝 ${esc(sess.notes)}</div>` : ''}
        </div>
        <div class="row">
          ${sess.finalized_at ? '<span class="chip ok">Lista final</span>' : '<span class="chip">Lista provisional</span>'}
          <span class="chip">${s.titulares.length}/${sess.capacity} plazas</span>
        </div>
      </div>
      ${!sess.is_open && !sess.has_started && !sess.cancelled ? `<p class="small muted" style="margin-top:.5rem">Las inscripciones se abren el ${esc(fmtDateTime(sess.opens_at))}.</p>` : ''}
      ${box}
      <div class="row">
        <button class="btn btn-yes btn-big" data-act="answerYes" data-id="${sess.id}" ${canYes ? '' : 'disabled'}>Voy</button>
        <button class="btn btn-no btn-big" data-act="answerNo" data-id="${sess.id}" ${canNo ? '' : 'disabled'}>No voy</button>
      </div>
      <p class="small muted" style="margin:.75rem 0 0">Puedes borrarte sin penalización hasta el ${esc(fmtDateTime(sess.tuesday_deadline))}.
      La lista se va completando en directo por prioridad y hora de inscripción.</p>
    </div>`;

    const myKit = (s.equipment || []).filter((e) => e.holder_id === me.player.id);
    if (myKit.length) {
      html += `<div class="status-box warn"><strong>🎒 Te toca llevar: ${myKit.map((e) => esc(e.name)).join(', ')}</strong>
        Tráelo al próximo entreno.</div>`;
    }

    html += `<div class="card"><div class="row spread"><h2 style="margin:0">Quién va (${total})</h2>${PRIO_LEGEND}</div>
      ${renderList(s, me.player.id)}</div>`;
    html += teamsProposalHtml(s.teams_proposal, me.player.id);
    html += equipmentHtml(s.equipment, me.player.id);
  }

  if (me.infractions.length) {
    html += `<div class="card"><h2>Mis incidencias</h2><ul class="list">${me.infractions.map((i) => `
      <li><div class="name">${esc(i.label)}<small>${esc(fmtShort(i.date))} · ${i.weeks === 2 ? '2 semanas en P3' : '1 semana en P3'}</small></div>
      ${infStatusChip(i.status)}</li>`).join('')}</ul></div>`;
  }
  $app.innerHTML = html;
}

// Equipos provisionales: se recalculan con cada inscripción según las estadísticas
function teamsProposalHtml(tp, meId = null) {
  if (!tp) {
    return `<div class="card"><h2>Equipos</h2><p class="muted small">Se harán solos cuando haya al menos 4 personas apuntadas
      (2 equipos hasta 17; triangular de 3 equipos desde 18).</p></div>`;
  }
  return `<div class="card"><h2>Equipos provisionales</h2>
    <p class="small muted">${esc(tp.description)}. Se reequilibran con cada inscripción según las estadísticas de la temporada.</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">${tp.teams.map((t) => `
      <div class="team-card"><strong><span class="team-dot" style="background:${esc(t.color)}"></span> ${esc(t.name)}</strong>
        <span class="small muted">· ${t.players.length} jugadores</span>
        <ul class="list small">${t.players.map((p) => `<li style="padding:.2rem 0${p.player_id === meId ? ';font-weight:700' : ''}">${esc(p.name)}${p.player_id === meId ? ' (tú)' : ''}</li>`).join('')}</ul></div>`).join('')}</div>
    ${tp.schedule.length ? `<h3 style="margin-top:1rem">Orden de partidos</h3><ol class="list small">${tp.schedule.map((m) => `
      <li><span class="pos">${esc(m.start)}</span><span class="name">${esc(m.home)} – ${esc(m.away)}</span><span class="muted">${m.minutes} min</span></li>`).join('')}</ol>
      <p class="small muted">El equipo que descansa entra en el siguiente partido.</p>` : ''}</div>`;
}

// Material: quién se lo lleva ahora
function equipmentHtml(items, meId = null) {
  if (!items || !items.length) return '';
  return `<div class="card"><h2>Material</h2><ul class="list">${items.map((e) => `<li>
    <span class="name">🎒 ${esc(e.name)}<small>${e.assigned_at ? `desde ${esc(fmtDateTime(e.assigned_at))}` : 'sin asignar'}</small></span>
    <span class="${e.holder_id === meId ? 'chip warn' : 'chip'}">${e.holder_name ? esc(e.holder_name) + (e.holder_id === meId ? ' (tú)' : '') : 'En el club'}</span></li>`).join('')}</ul></div>`;
}

// Registro de actividad: «Camilo asignó a Andrés los Petos amarillos · mié 21 oct, 23:05»
function activityList(rows) {
  if (!rows.length) return '<p class="muted small">Sin actividad registrada.</p>';
  return `<ul class="list">${rows.map((a) => `<li style="align-items:flex-start">
    <span class="name"><strong>${esc(a.actor_name)}</strong> ${esc(a.summary)}
      <small>${esc(fmtDateTime(a.at))}${a.session_date ? ` · entreno del ${esc(fmtShort(a.session_date))}` : ''}</small></span></li>`).join('')}</ul>`;
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

// Cierra la sesión en este navegador (y en el servidor si se puede)
function forgetSession() {
  S.token = ''; S.me = null;
  try { localStorage.removeItem('f7_token'); } catch (e) { /* sin almacenamiento */ }
}
function canManage() { return !!(S.me && S.me.player && S.me.player.can_manage); }
actions.logout = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ya cerrada */ }
  forgetSession(); toast('Sesión cerrada'); location.hash = '#/';
};

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

// ---------- Clasificación: panel general y personal ----------

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const shortDate = (d) => fmtDate(d, { day: 'numeric', month: 'short' });
const STATUS_TEXT = {
  attended: 'Asistió', late: 'Llegó tarde', no_show: 'No se presentó', excused: 'Justificada', left_out: 'Fuera (lista llena)',
};

async function viewStats(sub) {
  if (!S.token) return viewHome();
  const [stats, dash] = await Promise.all([api('/api/stats'), api('/api/dashboard')]);
  S.statsData = stats;
  S.dash = dash;
  S.statsSub = sub === 'yo' ? 'yo' : 'general';
  renderDashboard();
}

function renderDashboard() {
  const sub = S.statsSub;
  $app.innerHTML = `<h1>Clasificación</h1>
    <nav class="seg-tabs" aria-label="Vista">
      <a href="#/clasificacion" class="${sub === 'general' ? 'active' : ''}">General</a>
      <a href="#/clasificacion/yo" class="${sub === 'yo' ? 'active' : ''}">Mi temporada</a>
    </nav>
    <div id="dashBody"></div>`;
  const body = document.getElementById('dashBody');
  if (sub === 'yo') renderPersonal(body); else renderGeneral(body);
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (location.hash.startsWith('#/clasificacion') && S.dash) renderDashboard(); }, 200);
});

const statTile = (label, value, sub = '') =>
  `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;

// Ranking con barras (top N); la persona que mira se resalta en su color
function barList(players, key, { top = 5, meId = null, unit = '' } = {}) {
  const sorted = players.filter((p) => p[key] > 0).sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name));
  if (!sorted.length) return '<p class="muted small">Todavía sin datos.</p>';
  const max = sorted[0][key];
  let rows = sorted.slice(0, top);
  const meIdx = sorted.findIndex((p) => p.player_id === meId);
  if (meIdx >= top) rows = [...rows, sorted[meIdx]];
  return `<ol class="barlist">${rows.map((p) => {
    const rank = sorted.findIndex((x) => x.player_id === p.player_id) + 1;
    return `<li class="${p.player_id === meId ? 'me' : ''}">
      <span class="rank">${rank}</span><span class="who">${esc(p.name)}${p.player_id === meId ? ' (tú)' : ''}</span>
      <span class="val">${p[key]}${unit}</span>
      <span class="track"><span style="width:${pct(p[key], max)}%"></span></span></li>`;
  }).join('')}</ol>`;
}

function renderGeneral(body) {
  const data = S.statsData;
  const g = S.dash.group;
  const meId = S.me?.player?.id;
  const active = data.players.filter((p) => p.active);
  const sessions = g.sessions;
  const totalGoals = sessions.reduce((a, s) => a + s.goals, 0);
  const avgAtt = sessions.length ? sessions.reduce((a, s) => a + s.attended, 0) / sessions.length : 0;
  const avgCap = sessions.length ? sessions.reduce((a, s) => a + s.capacity, 0) / sessions.length : 0;
  const eligible = active.filter((p) => !p.attendance_exempt);
  const meeting = eligible.filter((p) => p.current_quarter_count >= data.min_per_quarter).length;
  const infTotal = g.infractions_by_type.reduce((a, r) => a + r.n, 0);

  body.innerHTML = `
  <div class="kpis">
    ${statTile('Entrenamientos jugados', sessions.length)}
    ${statTile('Asistencia media', avgAtt ? avgAtt.toFixed(1) : '—', avgCap ? `${pct(avgAtt, avgCap)} % de las plazas` : '')}
    ${statTile('Goles en la temporada', totalGoals, sessions.length ? `${(totalGoals / sessions.length).toFixed(1)} por entreno` : '')}
    ${statTile('Cumplen el mínimo', `${meeting}/${eligible.length}`, `${data.min_per_quarter} entrenos este trimestre`)}
    ${statTile('Incidencias confirmadas', infTotal)}
  </div>
  <div class="grid grid-2">
    <div class="card"><h2>Asistencia por entreno</h2><p class="small muted">Personas que jugaron cada miércoles; la línea marca las plazas.</p><div id="chAtt"></div></div>
    <div class="card"><h2>Goles por entreno</h2><p class="small muted">Suma de todos los partidos del día.</p><div id="chGoals"></div></div>
  </div>
  <div class="card"><h2>Líderes</h2>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div><h3>Puntos</h3>${barList(active, 'points', { meId })}</div>
      <div><h3>Goles</h3>${barList(active, 'goals', { meId })}</div>
      <div><h3>Asistencias de gol</h3>${barList(active, 'assists', { meId })}</div>
      <div><h3>Entrenos</h3>${barList(active, 'attended', { meId })}</div>
      <div><h3>MVP</h3>${barList(active, 'mvps', { meId })}</div>
      <div><h3>Paradas</h3>${barList(active, 'saves', { meId })}</div>
    </div></div>
  ${g.infractions_by_type.length ? `<div class="card"><h2>Incidencias por tipo</h2>
    <ol class="barlist">${g.infractions_by_type.sort((a, b) => b.n - a.n).map((r) => `<li>
      <span class="rank"></span><span class="who">${esc(r.label)}</span><span class="val">${r.n}</span>
      <span class="track"><span style="width:${pct(r.n, Math.max(...g.infractions_by_type.map((x) => x.n)))}%"></span></span></li>`).join('')}</ol></div>` : ''}
  <div class="card"><h2>Clasificación completa</h2><div id="statsTable"></div></div>`;

  Charts.columns(document.getElementById('chAtt'), {
    data: sessions.map((s) => ({ x: shortDate(s.date), title: fmtDate(s.date), value: s.attended,
      detail: [s.late ? `${s.late} tarde` : '', s.no_show ? `${s.no_show} sin presentarse` : '', s.left_out ? `${s.left_out} fuera por lista llena` : ''].filter(Boolean) })),
    colorVar: '--chart-group', label: 'asistentes',
    refValue: sessions.length ? sessions[sessions.length - 1].capacity : 0, refLabel: 'plazas',
  });
  Charts.columns(document.getElementById('chGoals'), {
    data: sessions.map((s) => ({ x: shortDate(s.date), title: fmtDate(s.date), value: s.goals,
      detail: [`${s.matches} partido${s.matches === 1 ? '' : 's'}`] })),
    colorVar: '--chart-group', label: 'goles',
  });
  renderStatsTable();
}

function renderStatsTable() {
  const data = S.statsData;
  const meId = S.me?.player?.id;
  const cols = [
    ['name', 'Jugador', false], ['attended', 'Entrenos', true], ['current_quarter_count', 'Trim.', true],
    ['played', 'PJ', true], ['wins', 'G', true], ['draws', 'E', true], ['losses', 'P', true], ['points', 'Pts', true],
    ['goals', 'Goles', true], ['assists', 'Asist.', true], ['mvps', 'MVP', true], ['saves', 'Paradas', true],
  ];
  if (canManage()) cols.push(['infractions', 'Incid.', true]);
  const { key, dir } = S.sort;
  const rows = [...data.players].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb) || a.name.localeCompare(b.name);
  });
  document.getElementById('statsTable').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${cols.map(([k, l, n]) => `<th class="${n ? 'num' : ''}" data-act="sortStats" data-key="${k}" tabindex="0">${l}${k === key ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((p) => `<tr class="${p.active ? '' : 'dim'}"${p.player_id === meId ? ' style="font-weight:700"' : ''}>${cols.map(([k, , n]) => {
      let v = esc(p[k]);
      if (k === 'name') v = `${esc(p.name)}${p.expelled ? ' <span class="chip danger">fuera</span>' : ''}`;
      if (k === 'current_quarter_count') {
        const low = !p.attendance_exempt && p[k] < data.min_per_quarter;
        v = p.attendance_exempt ? '<span class="chip">exento</span>' : `<span class="chip ${low ? 'warn' : 'ok'}">${p[k]}/${data.min_per_quarter}</span>`;
      }
      return `<td class="${n ? 'num' : ''}">${v}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin-top:.75rem">Puntos: 3 por partido ganado y 1 por empate con tu equipo. «Trim.» = entrenos este trimestre
    (mínimo ${data.min_per_quarter}; quedarse fuera por lista llena cuenta a favor).</p>`;
}
actions.sortStats = (el) => {
  const k = el.dataset.key;
  S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'name' ? 1 : -1) };
  renderStatsTable();
};

function renderPersonal(body) {
  const data = S.statsData;
  const meId = S.me?.player?.id;
  const me = data.players.find((p) => p.player_id === meId);
  const d = S.dash.me;
  if (!me) { body.innerHTML = '<div class="card empty">No hay datos de tu temporada todavía.</div>'; return; }
  const active = data.players.filter((p) => p.active);
  const rankOf = (key) => 1 + active.filter((p) => p[key] > me[key]).length;
  const held = S.dash.group.sessions.length;
  const played = d.history.filter((h) => h.team);
  const form = played.slice(-10).map((h) => {
    const r = h.wins > h.losses ? 'w' : h.wins < h.losses ? 'l' : 'd';
    return `<span class="${r}" title="${esc(fmtDate(h.date))}: ${h.wins}G ${h.draws}E ${h.losses}P">${{ w: 'G', d: 'E', l: 'P' }[r]}</span>`;
  }).join('');
  const qMin = data.min_per_quarter;
  const qCount = me.current_quarter_count;

  body.innerHTML = `
  <div class="grid grid-2">
    <div class="card featured">
      <div class="stat-label">Tus puntos esta temporada</div>
      <div class="hero-figure">${me.points}</div>
      <p class="muted" style="margin:.4rem 0 0">Puesto <strong>${rankOf('points')}</strong> de ${active.length} · ${me.wins} G · ${me.draws} E · ${me.losses} P</p>
      ${form ? `<div class="stat-label" style="margin-top:1rem">Últimos entrenos (G/E/P)</div><div class="form-strip">${form}</div>` : ''}
    </div>
    <div class="card">
      <h2>Este trimestre</h2>
      ${me.attendance_exempt ? '<p class="muted">Estás exento/a del mínimo de asistencia.</p>' : `
      <p><strong>${qCount}</strong> de ${qMin} entrenos mínimos ${qCount >= qMin ? '✅' : ''}</p>
      <div class="meter ${qCount >= qMin ? '' : 'warn'}" role="meter" aria-valuemin="0" aria-valuemax="${qMin}" aria-valuenow="${qCount}"><span style="width:${Math.min(100, pct(qCount, qMin))}%"></span></div>
      <p class="small muted" style="margin-top:.5rem">${qCount >= qMin ? 'Cumples el mínimo.' : `Te faltan ${qMin - qCount} para el mínimo.`} Quedarse fuera por lista llena cuenta a favor.</p>`}
      <div class="kpis" style="margin:1rem 0 0">
        ${statTile('Racha actual', d.streak, `mejor: ${d.best_streak}`)}
        ${statTile('Incidencias', me.infractions, me.serious_infractions ? `${me.serious_infractions} grave(s)` : 'ninguna grave')}
      </div>
    </div>
  </div>
  <div class="kpis">
    ${statTile('Entrenos', me.attended, held ? `${pct(me.attended, held)} % de ${held}` : '')}
    ${statTile('Goles', me.goals, `puesto ${rankOf('goals')} · ${me.played ? (me.goals / Math.max(1, played.length)).toFixed(1) : '0'} por entreno`)}
    ${statTile('Asistencias', me.assists, `puesto ${rankOf('assists')}`)}
    ${statTile('MVP', me.mvps, `puesto ${rankOf('mvps')}`)}
    ${statTile('Victorias', me.played ? `${pct(me.wins, me.played)} %` : '—', `${me.played} partidos`)}
    ${statTile('Paradas', me.saves)}
  </div>
  <div class="grid grid-2">
    <div class="card"><h2>Puntos acumulados</h2><p class="small muted">Tú frente a la media del grupo.</p><div id="chCum"></div></div>
    <div class="card"><h2>Tus goles por entreno</h2><div id="chMyGoals"></div></div>
  </div>
  <div class="card"><h2>Historial</h2>${d.history.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Fecha</th><th>Estado</th><th>Equipo</th><th class="num">G-E-P</th><th class="num">Pts</th><th class="num">Goles</th><th class="num">Asist.</th><th class="num">Paradas</th><th></th></tr></thead>
    <tbody>${[...d.history].reverse().map((h) => `<tr>
      <td>${esc(shortDate(h.date))}</td>
      <td>${h.status ? esc(STATUS_TEXT[h.status] || h.status) : '<span class="muted">No apuntado</span>'}</td>
      <td>${h.team ? `<span class="team-dot" style="background:${esc(h.team.color || '#ccc')}"></span> ${esc(h.team.name)}` : '—'}</td>
      <td class="num">${h.team ? `${h.wins}-${h.draws}-${h.losses}` : '—'}</td>
      <td class="num">${h.points}</td><td class="num">${h.goals}</td><td class="num">${h.assists}</td><td class="num">${h.saves}</td>
      <td>${h.mvp ? '⭐ MVP' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Aún no hay entrenamientos jugados.</p>'}</div>`;

  Charts.line(document.getElementById('chCum'), {
    data: d.cumulative.map((c) => ({ x: shortDate(c.date), title: fmtDate(c.date), me: c.me, group: c.group })),
    series: [{ key: 'me', label: 'Tú', colorVar: '--chart-me' }, { key: 'group', label: 'Media del grupo', colorVar: '--chart-group' }],
    format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
  });
  Charts.columns(document.getElementById('chMyGoals'), {
    data: d.history.map((h) => ({ x: shortDate(h.date), title: fmtDate(h.date), value: h.goals,
      detail: [h.assists ? `${h.assists} asistencia${h.assists === 1 ? '' : 's'}` : '', h.mvp ? 'MVP' : ''].filter(Boolean) })),
    colorVar: '--chart-me', label: 'goles',
  });
}

// ---------- Resultados ----------

async function viewResultsList() {
  if (!S.token) return viewHome();
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
  ['convocatoria', 'Convocatoria'], ['asistencia', 'Asistencia'], ['resultados', 'Resultados'], ['material', 'Material'],
  ['incidencias', 'Incidencias'], ['jugadores', 'Jugadores'], ['actividad', 'Actividad'], ['clasificacion', 'Clasificación'],
];

async function viewAdmin(tab = 'convocatoria') {
  if (!S.token) return viewLogin();
  if (!S.me) { try { S.me = await api('/api/me'); } catch (e) { return viewLogin(); } }
  if (!canManage()) {
    $app.innerHTML = `<div class="card empty"><h2>Sección de coordinación</h2>
      <p>Solo para cuentas con rol de <strong>coordinador/a</strong> o <strong>gestor/a</strong>.</p>
      <a class="btn" href="#/">Volver</a></div>`;
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
  const fn = {
    convocatoria: adminConvocatoria, asistencia: adminAsistencia, resultados: adminResultados, material: adminMaterial,
    incidencias: adminIncidencias, jugadores: adminJugadores, actividad: adminActividad,
  }[tab];
  if (!fn) { location.hash = '#/admin'; return; }
  $app.innerHTML = head + '<div id="adminBody"><p class="muted">Cargando…</p></div>';
  await fn(document.getElementById('adminBody'));
}

function adminTabsHtml(tab, ov) {
  return `<div class="row spread"><h1 style="margin:0">Coordinación</h1><button class="btn-sm btn-ghost" data-act="logout">Salir</button></div>
  <nav class="tabs">${ADMIN_TABS.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'incidencias' && ov?.pending_infractions ? `<span class="badge">${ov.pending_infractions}</span>` : ''}</a>`).join('')}</nav>`;
}

function sessionPicker(ov, tab) {
  if (['incidencias', 'jugadores', 'actividad'].includes(tab)) return '';
  return `<div class="row" style="margin-bottom:1rem">
    <select data-change="pickSession" aria-label="Entrenamiento">${ov.sessions.map((s) => `<option value="${s.id}" ${s.id === S.adminSessionId ? 'selected' : ''}>
      ${esc(fmtShort(s.date))}${s.cancelled ? ' (cancelado)' : !s.is_published ? ' (borrador)' : ''}${s.id === ov.current_id ? ' · próximo' : ''}</option>`).join('')}</select>
    <button class="btn-primary btn-sm" data-act="newSession">+ Nuevo entrenamiento</button></div>`;
}

actions.pickSession = (el) => {
  S.adminSessionId = Number(el.value); sessionStorage.setItem('f7_admin_session', el.value);
  S.res = null; S.att = null; render();
};
actions.newSession = () => {
  $dialog.innerHTML = `<form method="dialog" class="stack"><h2>Nueva convocatoria</h2>
    <div class="grid grid-2" style="gap:.75rem">
      <label class="field">Fecha<input type="date" id="nsDate" value="${S.overview.next_wednesday}" required></label>
      <label class="field">Plazas<input type="number" id="nsCap" min="2" max="40" value="16"></label>
      <label class="field">Hora de inicio<input type="time" id="nsTime" value="22:00"></label>
      <label class="field">Hora de llegada<input type="time" id="nsArrive" value="21:45"></label>
    </div>
    <label class="field">Lugar<input id="nsLoc" value="Polideportivo Marqués de Samaranch"></label>
    <label class="field">Notas para el equipo (opcional)<textarea id="nsNotes" placeholder="Ej.: traed camiseta clara y oscura"></textarea></label>
    <fieldset class="stack" style="border:1px solid var(--border);border-radius:12px;padding:.75rem">
      <legend class="small muted">Publicación</legend>
      <label><input type="radio" name="nsPub" value="open" checked> Publicar y abrir inscripciones ya</label>
      <label><input type="radio" name="nsPub" value="sunday"> Publicar, inscripciones desde el domingo a las 17:00</label>
      <label><input type="radio" name="nsPub" value="draft"> Guardar como borrador (no la ven los jugadores)</label>
    </fieldset>
    <p class="small muted">16 plazas = un partido de 2 equipos; 21 = triangular de 3 equipos con partidos de 8 minutos.</p>
    <div class="row" style="justify-content:flex-end"><button value="cancel" class="btn-ghost">Cancelar</button><button value="ok" class="btn-primary">Crear</button></div></form>`;
  $dialog.showModal();
  $dialog.onclose = async () => {
    if ($dialog.returnValue !== 'ok') return;
    const pub = document.querySelector('input[name="nsPub"]:checked').value;
    try {
      const r = await api('/api/admin/sessions', { method: 'POST', body: {
        date: document.getElementById('nsDate').value,
        capacity: Number(document.getElementById('nsCap').value),
        start_time: document.getElementById('nsTime').value,
        arrival_time: document.getElementById('nsArrive').value,
        location: document.getElementById('nsLoc').value,
        notes: document.getElementById('nsNotes').value,
        publish: pub !== 'draft', open_now: pub === 'open',
      } });
      S.adminSessionId = r.id; sessionStorage.setItem('f7_admin_session', r.id);
      toast(pub === 'draft' ? 'Borrador guardado' : 'Convocatoria publicada'); location.hash = '#/admin/convocatoria'; render();
    } catch (e) { toast(e.message, true); }
  };
};

function noSession(el) {
  el.innerHTML = '<div class="card empty"><h2>No hay entrenamientos</h2><p>Crea el primero con «+ Nuevo entrenamiento».</p></div>';
}

// --- Convocatoria ---
// Fecha/hora ISO -> valor de <input type="datetime-local"> en la hora del navegador
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function adminConvocatoria(el) {
  if (!S.adminSessionId) return noSession(el);
  const d = await api(`/api/admin/sessions/${S.adminSessionId}`);
  S.detail = d;
  const s = d.session;
  const players = (await api('/api/admin/players')).filter((p) => p.active);
  S.players = players;
  const inList = new Set([...d.titulares, ...d.reservas].map((e) => e.player_id));
  const yes = d.titulares.length + d.reservas.length;
  const pubChip = s.cancelled ? '<span class="chip danger">Cancelado</span>'
    : !s.is_published ? '<span class="chip warn">Borrador · no la ven los jugadores</span>'
      : s.is_open ? '<span class="chip ok">Publicada · inscripciones abiertas</span>'
        : s.has_started ? '<span class="chip">Publicada · cerrada</span>'
          : `<span class="chip">Publicada · abre ${esc(fmtDateTime(s.opens_at))}</span>`;
  const pubButtons = s.cancelled || s.has_started ? '' : !s.is_published
    ? `<button class="btn-primary" data-act="publishSession" data-open="1">🚀 Publicar y abrir inscripciones ya</button>
       <button data-act="publishSession" data-open="0">Publicar (abre ${esc(fmtDateTime(s.opens_at))})</button>`
    : `${!s.is_open ? '<button class="btn-primary" data-act="publishSession" data-open="1">Abrir inscripciones ya</button>' : ''}
       ${yes ? '' : '<button class="btn-ghost" data-act="unpublishSession">Pasar a borrador</button>'}`;
  el.innerHTML = `
  <div class="card featured">
    <div class="row spread">
      <div><div class="hero-date">${esc(fmtDate(s.date))} · ${esc(s.start_time)}</div>
        <div class="small muted">Sin penalización hasta ${esc(fmtDateTime(s.tuesday_deadline))}${d.created_by_name ? ` · creada por ${esc(d.created_by_name)}` : ''}</div></div>
      <div class="row">${pubChip}${s.finalized_at ? `<span class="chip ok">Lista final · ${esc(fmtDateTime(s.finalized_at))}</span>` : ''}</div>
    </div>
    ${pubButtons ? `<div class="row" style="margin-top:1rem">${pubButtons}</div>` : ''}
  </div>

  <div class="card"><h2>Detalles</h2>
    <form id="sessionForm" class="stack">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem">
        <label class="field">Fecha<input type="date" name="date" value="${esc(s.date)}" required></label>
        <label class="field">Hora de inicio<input type="time" name="start_time" value="${esc(s.start_time)}" required></label>
        <label class="field">Hora de llegada<input type="time" name="arrival_time" value="${esc(s.arrival_time || '21:45')}" required></label>
        <label class="field">Plazas<input type="number" name="capacity" min="2" max="40" value="${s.capacity}" required></label>
        <label class="field">Inscripciones desde<input type="datetime-local" name="opens_at" value="${esc(toLocalInput(s.opens_at))}"></label>
      </div>
      <label class="field">Lugar<input name="location" value="${esc(s.location)}" required></label>
      <label class="field">Notas para el equipo<textarea name="notes" placeholder="Opcional: lo verán los jugadores">${esc(s.notes || '')}</textarea></label>
      <div class="row"><button class="btn-primary" type="submit">Guardar cambios</button>
        <span class="small muted">Cada cambio queda registrado en «Actividad».</span></div>
    </form>
  </div>

  <div class="row" style="margin-bottom:1rem">
    <button data-act="finalize">${s.finalized_at ? '↻ Regenerar lista final' : '📋 Congelar lista final'}</button>
    ${s.finalized_at ? '<button data-act="unfinalize">Volver a provisional</button>' : ''}
    <button class="btn-ghost" data-act="toggleCancel">${s.cancelled ? 'Reactivar' : 'Cancelar entrenamiento'}</button>
    <button class="btn-ghost" data-act="deleteSession">Eliminar</button>
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
      ${teamsProposalHtml(d.teams_proposal)}
      <div class="card"><div class="row spread"><h2 style="margin:0">Mensaje para WhatsApp</h2><button class="btn-sm" data-act="copyWa">Copiar</button></div>
        <pre class="wa">${esc(d.whatsapp)}</pre></div>
      <div class="card"><h2>Sin responder (${d.sin_responder.length})</h2><p class="small">${d.sin_responder.map((p) => esc(p.name)).join(', ') || '—'}</p>
        ${d.no_van.length ? `<h3>No van</h3><ul class="list">${d.no_van.map((n) => `<li><span class="name">${esc(n.name)}<small>${esc(n.cancel_reason || '')} ${esc(fmtTime(n.updated_at))}</small></span></li>`).join('')}</ul>` : ''}
      </div>
      ${d.infractions.length ? `<div class="card"><h2>Incidencias de este entreno</h2><ul class="list">${d.infractions.map((i) => `<li><span class="name">${esc(i.name)}<small>${esc(S.rules?.infraction_types[i.type]?.label || i.type)}</small></span>${infStatusChip(i.status)}</li>`).join('')}</ul><a href="#/admin/incidencias" class="small">Revisar incidencias →</a></div>` : ''}
      <div class="card"><h2>Actividad de esta convocatoria</h2>${activityList(d.activity)}</div>
    </div>
  </div>`;

  document.getElementById('sessionForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.capacity = Number(body.capacity);
    body.opens_at = body.opens_at ? new Date(body.opens_at).toISOString() : null;
    try {
      await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'PATCH', body });
      toast('Cambios guardados'); render();
    } catch (err) { toast(err.message, true); }
  };
}
actions.publishSession = async (el) => {
  await api(`/api/admin/sessions/${S.adminSessionId}/publish`, { method: 'POST', body: { open_now: el.dataset.open === '1' } });
  toast(el.dataset.open === '1' ? 'Publicada: ya pueden apuntarse' : 'Publicada'); render();
};
actions.unpublishSession = async () => {
  await api(`/api/admin/sessions/${S.adminSessionId}/unpublish`, { method: 'POST' });
  toast('Ahora es un borrador'); render();
};
actions.copyWa = () => copyText(S.detail.whatsapp);
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

// --- Material ---
async function adminMaterial(el) {
  const [data, players] = await Promise.all([api('/api/admin/equipment'), api('/api/admin/players')]);
  const active = players.filter((p) => p.active);
  const sess = S.overview.sessions.find((x) => x.id === S.adminSessionId);
  const opts = (sel) => `<option value="">En el club (nadie se lo lleva)</option>${active.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  el.innerHTML = `
  <div class="card"><h2>¿Quién se lleva el material?</h2>
    <p class="small muted">Al terminar el entreno, elige quién se lleva cada cosa. Queda registrado quién lo asignó y cuándo
      ${sess ? `(se asociará al entreno del ${esc(fmtShort(sess.date))}, el elegido arriba)` : ''}.</p>
    <ul class="list">${data.items.filter((i) => i.active).map((i) => `<li style="flex-wrap:wrap">
      <span class="name"><strong>🎒 ${esc(i.name)}</strong>
        <small>${i.holder_name ? `Lo tiene <b>${esc(i.holder_name)}</b>` : 'En el club'}${i.assigned_at ? ` · ${esc(i.assigned_by_name || '—')} lo asignó el ${esc(fmtDateTime(i.assigned_at))}` : ''}</small></span>
      <span class="row">
        <select id="eqHolder${i.id}" aria-label="Quién se lleva ${esc(i.name)}">${opts(i.holder_id)}</select>
        <button class="btn-primary btn-sm" data-act="assignEquipment" data-id="${i.id}">Asignar</button>
        <button class="btn-ghost btn-sm" data-act="toggleEquipment" data-id="${i.id}" data-active="0" title="Ya no se usa">Retirar</button>
      </span></li>`).join('') || '<li class="muted">No hay material activo.</li>'}</ul>
    <div class="row" style="margin-top:1rem">
      <input id="eqNew" placeholder="Nuevo material (p. ej. Conos)" style="flex:1">
      <button class="btn-sm" data-act="addEquipment">Añadir material</button>
    </div>
    ${data.items.some((i) => !i.active) ? `<p class="small muted" style="margin-top:.75rem">Retirado: ${data.items.filter((i) => !i.active).map((i) => `${esc(i.name)} <a href="#" data-act="toggleEquipment" data-id="${i.id}" data-active="1">reactivar</a>`).join(' · ')}</p>` : ''}
  </div>
  <div class="card"><h2>Historial del material</h2>${data.history.length ? `<ul class="list">${data.history.map((h) => `<li>
    <span class="name"><strong>${esc(h.assigned_by_name || '—')}</strong> ${h.holder_name ? `asignó a <strong>${esc(h.holder_name)}</strong>` : 'dejó en el club'} los «${esc(h.equipment_name)}»
      <small>${esc(fmtDateTime(h.assigned_at))}${h.session_date ? ` · tras el entreno del ${esc(fmtShort(h.session_date))}` : ''}${h.note ? ` · ${esc(h.note)}` : ''}</small></span></li>`).join('')}</ul>` : '<p class="muted small">Aún no se ha asignado nada.</p>'}</div>`;
}
actions.assignEquipment = async (el) => {
  const holder = document.getElementById(`eqHolder${el.dataset.id}`).value;
  await api(`/api/admin/equipment/${el.dataset.id}/assign`, { method: 'POST', body: { holder_id: holder ? Number(holder) : null, session_id: S.adminSessionId } });
  toast('Material asignado'); render();
};
actions.toggleEquipment = async (el) => {
  await api(`/api/admin/equipment/${el.dataset.id}`, { method: 'PATCH', body: { active: el.dataset.active === '1' } });
  render();
};
actions.addEquipment = async () => {
  const name = document.getElementById('eqNew').value.trim();
  if (!name) return;
  await api('/api/admin/equipment', { method: 'POST', body: { name } });
  toast('Material añadido'); render();
};

// --- Actividad ---
const AUDIT_FILTERS = [['', 'Todo'], ['session', 'Convocatorias'], ['attendance', 'Asistencia'], ['results', 'Resultados'],
  ['infraction', 'Incidencias'], ['equipment', 'Material'], ['player', 'Jugadores y roles']];
async function adminActividad(el) {
  const filter = S.auditFilter || '';
  const rows = await api(`/api/admin/audit?limit=300${filter ? `&entity=${encodeURIComponent(filter)}` : ''}`);
  el.innerHTML = `<div class="card"><div class="row spread"><h2 style="margin:0">Actividad de coordinación</h2>
    <select data-change="auditFilter" aria-label="Filtrar">${AUDIT_FILTERS.map(([k, l]) => `<option value="${k}" ${k === filter ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <p class="small muted">Cada cambio que hace coordinación queda aquí con su autor, la fecha y la hora.</p>
    ${activityList(rows)}</div>`;
}
actions.auditFilter = (el) => { S.auditFilter = el.value; render(); };

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
  <div class="card"><div class="row spread"><h2 style="margin:0">Equipos</h2>
    <span class="row">${S.detail?.teams_proposal ? '<button class="btn-sm" data-act="useProposedTeams">Usar equipos propuestos</button>' : ''}
    <button class="btn-sm" data-act="resAddTeam">+ Equipo</button></span></div>
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
// Carga los equipos equilibrados (y el orden del triangular) en el editor de resultados
actions.useProposedTeams = () => {
  const tp = S.detail.teams_proposal;
  const R = S.res;
  R.teams = tp.teams.map((t) => ({ name: t.name, color: t.color }));
  R.assign = {};
  tp.teams.forEach((t, i) => t.players.forEach((pl) => {
    R.assign[pl.player_id] = i;
    if (!R.players.some((x) => x.id === pl.player_id)) R.players.push({ id: pl.player_id, name: pl.name });
  }));
  R.players.sort((a, b) => a.name.localeCompare(b.name));
  const idx = new Map(tp.teams.map((t, i) => [t.name, i]));
  R.matches = tp.schedule.length
    ? tp.schedule.map((m) => ({ home: idx.get(m.home), away: idx.get(m.away), home_goals: 0, away_goals: 0 }))
    : [{ home: 0, away: 1, home_goals: 0, away_goals: 0 }];
  toast('Equipos propuestos cargados: apunta los marcadores'); renderResEditor();
};
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
  const typeOpts = (sel) => Object.entries(rules.infraction_types).map(([k, t]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  const row = (i) => `<li style="flex-wrap:wrap">
    <span class="name"><strong>${esc(i.name)}</strong> · ${esc(fmtShort(i.date))}
      <small>${i.weeks === 2 ? '2 semanas' : '1 semana'} en P3${i.serious ? ' · <b>grave</b>' : ''} · ${i.source === 'auto' ? 'automática al borrarse' : i.source === 'attendance' ? 'desde asistencia' : 'manual'}
        ${i.created_by_name ? ` · registrada por ${esc(i.created_by_name)}` : ''}${i.updated_by_name ? ` · último cambio: ${esc(i.updated_by_name)}, ${esc(fmtDateTime(i.updated_at))}` : ''}</small>
      <select data-change="infType" data-id="${i.id}" aria-label="Tipo de incidencia" style="margin-top:.35rem;max-width:100%">${typeOpts(i.type)}</select>
      ${i.note ? `<small>📝 ${esc(i.note)}</small>` : ''}</span>
    ${infStatusChip(i.status)}
    <span class="row">
      ${i.status !== 'confirmed' ? `<button class="btn-sm" data-act="infStatus" data-id="${i.id}" data-status="confirmed">Confirmar</button>` : ''}
      ${i.status !== 'justified' ? `<button class="btn-sm" data-act="infStatus" data-id="${i.id}" data-status="justified">Justificada</button>` : ''}
      <button class="btn-sm btn-ghost" data-act="infNote" data-id="${i.id}" title="Editar nota">📝</button>
      <button class="btn-sm btn-ghost" data-act="infDelete" data-id="${i.id}" title="Eliminar">🗑</button>
    </span></li>`;
  S.infractionsById = new Map(list.map((x) => [x.id, x]));
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
actions.infType = async (el) => {
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'PATCH', body: { type: el.value } });
  toast('Tipo cambiado'); render();
};
actions.infNote = async (el) => {
  const inf = S.infractionsById.get(Number(el.dataset.id));
  const note = prompt(`Nota de la incidencia de ${inf.name}:`, inf.note || '');
  if (note === null) return;
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'PATCH', body: { note } });
  toast('Nota guardada'); render();
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
const ROLE_LABELS = { coordinador: 'Coordinador/a', gestor: 'Gestor/a', petos: 'Petos', balones: 'Balones' };

async function adminJugadores(el) {
  const players = await api('/api/admin/players');
  S.adminPlayers = players;
  const isCoord = !!(S.me && S.me.player.roles.includes('coordinador'));
  const roleBoxes = (p) => Object.keys(ROLE_LABELS).map((code) => `
    <label style="white-space:nowrap"><input type="checkbox" ${p.roles.includes(code) ? 'checked' : ''} ${isCoord ? '' : 'disabled'}
      data-change="toggleRole" data-id="${p.id}" data-role="${code}"> ${ROLE_LABELS[code]}</label>`).join('');
  el.innerHTML = `
  <div class="card"><h2>Jugadores (${players.filter((p) => p.active).length} activos)</h2>
    <p class="small muted">Cada persona se registra con su propia cuenta. Aquí se asignan los roles:
    <strong>coordinador/a</strong> (todo), <strong>gestor/a</strong> (convocatorias, asistencia, resultados e incidencias),
    <strong>petos</strong> y <strong>balones</strong> (responsables del material).
    ${isCoord ? '' : '<br>Solo un coordinador puede cambiar los roles.'}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Contacto</th><th>Roles</th><th>Activo</th><th title="Exento del mínimo de asistencia">Exento</th><th class="num">Graves</th></tr></thead>
      <tbody>${players.map((p) => `<tr class="${p.active ? '' : 'dim'}">
        <td>${esc(p.name)}<div class="small muted">${p.last_login_at ? 'Último acceso ' + esc(fmtDateTime(p.last_login_at)) : 'Aún no ha entrado'}</div></td>
        <td class="small">${esc(p.email || '—')}<br>${esc(p.phone || '')}</td>
        <td><div style="display:flex;flex-direction:column;gap:.25rem">${roleBoxes(p)}</div></td>
        <td><input type="checkbox" ${p.active ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="active"></td>
        <td><input type="checkbox" ${p.attendance_exempt ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="attendance_exempt"></td>
        <td class="num">${p.serious_infractions ? `<span class="chip ${p.expelled ? 'danger' : 'warn'}">${p.serious_infractions}</span>` : '0'}</td>
      </tr>`).join('')}</tbody></table></div></div>`;
}

// Cambia un rol: se envía el conjunto completo de roles del jugador
actions.toggleRole = async (el) => {
  const pid = Number(el.dataset.id);
  const p = S.adminPlayers.find((x) => x.id === pid);
  const roles = new Set(p.roles);
  if (el.checked) roles.add(el.dataset.role); else roles.delete(el.dataset.role);
  try {
    const r = await api(`/api/admin/players/${pid}/roles`, { method: 'PUT', body: { roles: [...roles] } });
    p.roles = r.roles; toast('Roles guardados');
  } catch (err) { toast(err.message, true); }
  if (S.me && pid === S.me.player.id) S.me = await api('/api/me');
  render();
};
actions.playerField = async (el) => {
  const v = el.type === 'checkbox' ? el.checked : el.value;
  await api(`/api/admin/players/${el.dataset.id}`, { method: 'PATCH', body: { [el.dataset.f]: v } });
  toast('Guardado');
  if (el.type === 'checkbox') render();
};

// ---------- Cuentas: entrar y registrarse ----------

const FIELD = (label, id, type = 'text', extra = '') =>
  `<label class="field">${label}<input id="${id}" type="${type}" ${extra}></label>`;

async function viewLogin() {
  $app.innerHTML = `<div class="card" style="max-width:420px;margin:1.5rem auto">
    <h1>Entrar</h1>
    <form id="loginForm" class="stack">
      ${FIELD('Email', 'loginEmail', 'email', 'autocomplete="email" required')}
      ${FIELD('Contraseña', 'loginPw', 'password', 'autocomplete="current-password" required')}
      <button class="btn-primary" type="submit">Entrar</button>
    </form>
    <p class="small muted" style="margin-top:1rem">¿Aún no tienes cuenta? <a href="#/registro">Regístrate</a></p></div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: {
        email: document.getElementById('loginEmail').value, password: document.getElementById('loginPw').value } });
      S.token = r.token; localStorage.setItem('f7_token', r.token); S.me = null;
      toast(`Hola, ${r.player.name.split(' ')[0]}`); location.hash = '#/';
    } catch (err) { toast(err.message, true); }
  };
}

async function viewRegister() {
  $app.innerHTML = `<div class="card" style="max-width:480px;margin:1.5rem auto">
    <h1>Crear cuenta</h1>
    <p class="small muted">Tus datos solo los ve Coordinación. Con el email y la contraseña entrarás después.</p>
    <form id="regForm" class="stack">
      <div class="grid grid-2" style="gap:.75rem">
        ${FIELD('Nombre', 'regFirst', 'text', 'autocomplete="given-name" required')}
        ${FIELD('Apellidos', 'regLast', 'text', 'autocomplete="family-name" required')}
      </div>
      ${FIELD('Teléfono', 'regPhone', 'tel', 'autocomplete="tel" placeholder="600 000 000" required')}
      ${FIELD('Email', 'regEmail', 'email', 'autocomplete="email" required')}
      <div class="grid grid-2" style="gap:.75rem">
        ${FIELD('Contraseña (mín. 8)', 'regPw', 'password', 'autocomplete="new-password" minlength="8" required')}
        ${FIELD('Repite la contraseña', 'regPw2', 'password', 'autocomplete="new-password" minlength="8" required')}
      </div>
      <button class="btn-primary" type="submit">Crear cuenta</button>
    </form>
    <p class="small muted" style="margin-top:1rem">¿Ya tienes cuenta? <a href="#/entrar">Entrar</a></p></div>`;
  document.getElementById('regForm').onsubmit = async (e) => {
    e.preventDefault();
    const pw = document.getElementById('regPw').value;
    if (pw !== document.getElementById('regPw2').value) return toast('Las contraseñas no coinciden', true);
    try {
      const r = await api('/api/auth/register', { method: 'POST', body: {
        first_name: document.getElementById('regFirst').value,
        last_name: document.getElementById('regLast').value,
        phone: document.getElementById('regPhone').value,
        email: document.getElementById('regEmail').value,
        password: pw,
      } });
      S.token = r.token; localStorage.setItem('f7_token', r.token); S.me = null;
      toast('Cuenta creada. ¡Te damos la bienvenida!'); location.hash = '#/';
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- Modo claro / oscuro ----------
function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('f7_theme', next); } catch (e) { /* sin almacenamiento: solo esta visita */ }
  document.getElementById('themeToggle').textContent = next === 'dark' ? '☀️' : '🌙';
});
document.getElementById('themeToggle').textContent = currentTheme() === 'dark' ? '☀️' : '🌙';

// ---------- Inicio ----------
loadRules().catch(() => {});
(async () => {
  if (S.token) { try { S.me = await api('/api/me'); } catch (e) { /* sesión caducada: api() la cierra */ } }
  render();
})();
