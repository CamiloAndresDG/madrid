'use strict';
// Gráficos SVG sin librerías para los paneles de temporada.
// Colores por entidad (nunca por posición): --chart-me = la persona, --chart-group = el grupo.
// Todo texto va en tokens de texto; las etiquetas se insertan con textContent.

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const div = (cls, text) => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  };

  // Ticks "redondos" para el eje Y (0 incluido)
  function niceTicks(max, count = 4) {
    if (max <= 0) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
    if (ticks[ticks.length - 1] < max) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 100) / 100);
    return ticks;
  }

  // Tooltip único por gráfico: el valor manda, la etiqueta acompaña
  function makeTooltip(host) {
    const tip = div('chart-tip');
    tip.hidden = true;
    host.appendChild(tip);
    return {
      show(x, y, title, rows) {
        tip.replaceChildren();
        tip.appendChild(div('chart-tip-title', title));
        for (const r of rows) {
          const row = div('chart-tip-row');
          if (r.color) { const k = div('chart-tip-key'); k.style.background = r.color; row.appendChild(k); }
          const v = document.createElement('strong'); v.textContent = r.value; row.appendChild(v);
          row.appendChild(div('chart-tip-label', r.label));
          tip.appendChild(row);
        }
        tip.hidden = false;
        const hw = host.clientWidth, tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(x - tw / 2, 0), hw - tw)}px`;
        tip.style.top = `${Math.max(y - tip.offsetHeight - 10, 0)}px`;
      },
      hide() { tip.hidden = true; },
    };
  }

  // Tabla equivalente (accesible sin color ni ratón)
  function tableView(columns, rows) {
    const det = document.createElement('details');
    det.className = 'chart-table';
    const sum = document.createElement('summary'); sum.textContent = 'Ver tabla'; det.appendChild(sum);
    const wrap = div('table-wrap');
    const t = document.createElement('table');
    const tr = document.createElement('tr');
    columns.forEach((c, i) => { const th = document.createElement('th'); th.textContent = c; if (i) th.className = 'num'; tr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(tr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    for (const r of rows) {
      const row = document.createElement('tr');
      r.forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i) td.className = 'num'; row.appendChild(td); });
      tb.appendChild(row);
    }
    t.appendChild(tb); wrap.appendChild(t); det.appendChild(wrap);
    return det;
  }

  function legend(series) {
    const l = div('chart-legend');
    for (const s of series) {
      const item = div('chart-legend-item');
      const key = div(s.type === 'bar' ? 'chart-key-rect' : 'chart-key-line');
      key.style.background = s.color;
      item.appendChild(key);
      item.appendChild(document.createTextNode(s.label));
      l.appendChild(item);
    }
    return l;
  }

  const colorVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Línea(s) en el tiempo con cruceta: data = [{x: etiqueta, [key]: valor}], series = [{key,label,colorVar}]
  function line(host, { data, series, height = 220, format = (v) => String(v) }) {
    host.replaceChildren();
    host.classList.add('chart');
    if (!data.length) { host.appendChild(div('chart-empty', 'Sin datos todavía')); return; }
    const resolved = series.map((s) => ({ ...s, color: colorVar(s.colorVar) }));
    if (resolved.length > 1) host.appendChild(legend(resolved));
    const plotWrap = div('chart-plot');
    host.appendChild(plotWrap);
    const W = Math.max(plotWrap.clientWidth || host.clientWidth || 320, 260);
    const M = { t: 12, r: 44, b: 26, l: 34 };
    const iw = W - M.l - M.r, ih = height - M.t - M.b;
    const maxV = Math.max(1, ...data.flatMap((d) => resolved.map((s) => d[s.key] ?? 0)));
    const ticks = niceTicks(maxV);
    const top = ticks[ticks.length - 1];
    const x = (i) => M.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
    const y = (v) => M.t + ih - (v / top) * ih;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${height}`, width: '100%', height, role: 'img' });

    for (const t of ticks) {
      svg.appendChild(svgEl('line', { x1: M.l, x2: M.l + iw, y1: y(t), y2: y(t), class: 'chart-grid' }));
      const lab = svgEl('text', { x: M.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'chart-axis' });
      lab.textContent = format(t); svg.appendChild(lab);
    }
    const every = Math.ceil(data.length / 6);
    data.forEach((d, i) => {
      if (i % every && i !== data.length - 1) return;
      const lab = svgEl('text', { x: x(i), y: height - 6, 'text-anchor': 'middle', class: 'chart-axis' });
      lab.textContent = d.x; svg.appendChild(lab);
    });

    for (const s of resolved) {
      const pts = data.map((d, i) => `${x(i)},${y(d[s.key] ?? 0)}`).join(' ');
      if (resolved.length === 1) {
        svg.appendChild(svgEl('polygon', { points: `${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`, fill: s.color, opacity: 0.1 }));
      }
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const last = data.length - 1;
      svg.appendChild(svgEl('circle', { cx: x(last), cy: y(data[last][s.key] ?? 0), r: 4, fill: s.color, class: 'chart-dot' }));
      const end = svgEl('text', { x: x(last) + 8, y: y(data[last][s.key] ?? 0) + 4, class: 'chart-endlabel' });
      end.textContent = format(data[last][s.key] ?? 0); svg.appendChild(end);
    }

    const cross = svgEl('line', { y1: M.t, y2: M.t + ih, class: 'chart-cross', visibility: 'hidden' });
    svg.appendChild(cross);
    const hit = svgEl('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent', tabindex: 0 });
    svg.appendChild(hit);
    plotWrap.appendChild(svg);
    const tip = makeTooltip(plotWrap);
    const showAt = (i) => {
      const cx = x(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      const scale = plotWrap.clientWidth / W;
      tip.show(cx * scale, Math.min(...resolved.map((s) => y(data[i][s.key] ?? 0))) * scale, data[i].title || data[i].x,
        resolved.map((s) => ({ color: s.color, value: format(data[i][s.key] ?? 0), label: s.label })));
    };
    const nearest = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      return data.length === 1 ? 0 : Math.max(0, Math.min(data.length - 1, Math.round(((px - M.l) / iw) * (data.length - 1))));
    };
    let focusIdx = data.length - 1;
    hit.addEventListener('pointermove', (e) => showAt(nearest(e.clientX)));
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); });
    hit.addEventListener('focus', () => showAt(focusIdx));
    hit.addEventListener('blur', () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); });
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') focusIdx = Math.max(0, focusIdx - 1);
      else if (e.key === 'ArrowRight') focusIdx = Math.min(data.length - 1, focusIdx + 1);
      else return;
      e.preventDefault(); showAt(focusIdx);
    });

    host.appendChild(tableView(['Fecha', ...resolved.map((s) => s.label)],
      data.map((d) => [d.title || d.x, ...resolved.map((s) => format(d[s.key] ?? 0))])));
  }

  // Columnas de una serie con tooltip por barra: data = [{x, value, title, detail}]
  function columns(host, { data, colorVar: cv, height = 200, label = 'Valor', format = (v) => String(v), refValue, refLabel }) {
    host.replaceChildren();
    host.classList.add('chart');
    if (!data.length) { host.appendChild(div('chart-empty', 'Sin datos todavía')); return; }
    const color = colorVar(cv);
    const plotWrap = div('chart-plot');
    host.appendChild(plotWrap);
    const W = Math.max(plotWrap.clientWidth || host.clientWidth || 320, 260);
    const M = { t: 18, r: 10, b: 26, l: 34 };
    const iw = W - M.l - M.r, ih = height - M.t - M.b;
    const maxV = Math.max(1, refValue || 0, ...data.map((d) => d.value));
    const ticks = niceTicks(maxV);
    const top = ticks[ticks.length - 1];
    const y = (v) => M.t + ih - (v / top) * ih;
    const band = iw / data.length;
    const bw = Math.min(24, Math.max(4, band - 2));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${height}`, width: '100%', height, role: 'img' });
    for (const t of ticks) {
      svg.appendChild(svgEl('line', { x1: M.l, x2: M.l + iw, y1: y(t), y2: y(t), class: 'chart-grid' }));
      const lab = svgEl('text', { x: M.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'chart-axis' });
      lab.textContent = format(t); svg.appendChild(lab);
    }
    if (refValue) {
      svg.appendChild(svgEl('line', { x1: M.l, x2: M.l + iw, y1: y(refValue), y2: y(refValue), class: 'chart-ref' }));
      const rl = svgEl('text', { x: M.l + iw, y: y(refValue) - 4, 'text-anchor': 'end', class: 'chart-axis' });
      rl.textContent = refLabel || ''; svg.appendChild(rl);
    }
    const tip = makeTooltip(plotWrap);
    const every = Math.ceil(data.length / 8);
    const maxIdx = data.reduce((bi, d, i) => (d.value > data[bi].value ? i : bi), 0);
    data.forEach((d, i) => {
      const cx = M.l + band * i + band / 2;
      const h = Math.max(0, (d.value / top) * ih);
      const r = Math.min(4, bw / 2, h);
      // Barra con extremo de datos redondeado y base recta
      const x0 = cx - bw / 2, x1 = cx + bw / 2, yb = M.t + ih, yt = yb - h;
      const path = h > 0
        ? `M${x0},${yb} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${yb} Z`
        : '';
      if (path) svg.appendChild(svgEl('path', { d: path, fill: color, class: 'chart-bar' }));
      if (i === maxIdx && d.value > 0) {
        const v = svgEl('text', { x: cx, y: yt - 5, 'text-anchor': 'middle', class: 'chart-endlabel' });
        v.textContent = format(d.value); svg.appendChild(v);
      }
      if (!(i % every) || i === data.length - 1) {
        const lab = svgEl('text', { x: cx, y: height - 6, 'text-anchor': 'middle', class: 'chart-axis' });
        lab.textContent = d.x; svg.appendChild(lab);
      }
      const hit = svgEl('rect', { x: M.l + band * i, y: M.t, width: band, height: ih, fill: 'transparent', tabindex: 0 });
      const show = () => {
        const scale = plotWrap.clientWidth / W;
        tip.show(cx * scale, yt * scale, d.title || d.x, [{ color, value: format(d.value), label }, ...(d.detail || []).map((t) => ({ value: '', label: t }))]);
      };
      hit.addEventListener('pointerenter', show); hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', () => tip.hide()); hit.addEventListener('blur', () => tip.hide());
      svg.appendChild(hit);
    });
    plotWrap.appendChild(svg);
    host.appendChild(tableView(['Fecha', label], data.map((d) => [d.title || d.x, format(d.value)])));
  }

  return { line, columns };
})();
