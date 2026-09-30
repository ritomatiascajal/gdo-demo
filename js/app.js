/* GdO — visor de obras (web estática + Supabase + Leaflet)
 * Sin sesión: visor público (v_obras_publicas).
 * Con sesión de personal municipal: tablero completo (v_obras, v_resumen, ítems, certificados).
 */
(() => {
  const cfg = window.GDO_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  const COLORES = { Rojo: '#c0392b', Amarillo: '#d69e00', Verde: '#2e8b57', 'Sin iniciar': '#8a9099' };
  const COLOR_ESTADO = {
    'En proyecto': '#8a9099', 'En licitación': '#8a9099', 'Adjudicada': '#6c7fa0',
    'En ejecución': '#1f4e79', 'Paralizada': '#c0392b', 'Finalizada': '#2e8b57',
    'Recepción definitiva': '#2e8b57', 'Cancelada': '#5b6168'
  };

  const st = { rol: null, idUsuario: null, obras: [], resumen: null, contratistas: {}, usuarios: {}, marcadores: {}, activa: null };
  const $ = (id) => document.getElementById(id);

  // ---------- formato ----------
  const pesos = (v) => v == null ? '—' : '$ ' + Number(v).toLocaleString('es-AR', { maximumFractionDigits: 0 });
  const millones = (v) => v == null ? '—' : '$ ' + (Number(v) / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M';
  const pct = (v) => v == null ? '—' : (Number(v) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
  const fecha = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-AR') : '—';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const interno = () => !!st.rol;
  const colorObra = (o) => interno() ? (COLORES[o.semaforo] || COLORES['Sin iniciar']) : (COLOR_ESTADO[o.estado] || '#8a9099');

  // ---------- mapa ----------
  const mapa = L.map('mapa', { zoomControl: true }).setView(cfg.centro, cfg.zoom);
  const calles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(mapa);
  const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imágenes © Esri'
  });
  L.control.layers({ 'Calles': calles, 'Satélite': satelite }, null, { position: 'topright' }).addTo(mapa);
  const capa = L.layerGroup().addTo(mapa);

  // ---------- datos ----------
  async function cargar() {
    $('lista').innerHTML = '<li class="estado-carga">Cargando obras…</li>';
    try {
      if (interno()) {
        const campos = 'id_obra,nombre,descripcion,tipo_obra,subtipo,modalidad,estado,fuente_financiamiento,area_responsable,barrio,direccion,lat,lng,expediente,contratista_id,inspector_id,fecha_inicio,plazo_dias,fecha_fin_prevista,presupuesto,monto_medido_aprobado,avance_fisico,avance_previsto,desvio,semaforo,escala,monto_pagado,avance_financiero,cant_fotos,mediciones_pendientes,beneficiarios,visible_publico,observaciones';
        const [o, r, c, u] = await Promise.all([
          sb.from('v_obras').select(campos).order('id_obra'),
          sb.from('v_resumen').select('*').single(),
          sb.from('contratistas').select('id_contratista,razon_social'),
          sb.from('usuarios').select('id_usuario,nombre')
        ]);
        for (const x of [o, r, c, u]) if (x.error) throw x.error;
        st.obras = o.data; st.resumen = r.data;
        st.contratistas = Object.fromEntries(c.data.map((x) => [x.id_contratista, x.razon_social]));
        st.usuarios = Object.fromEntries(u.data.map((x) => [x.id_usuario, x.nombre]));
      } else {
        const o = await sb.from('v_obras_publicas').select('*').order('id_obra');
        if (o.error) throw o.error;
        st.obras = o.data; st.resumen = null;
      }
    } catch (e) {
      console.error(e);
      $('lista').innerHTML = `<li class="estado-carga">No se pudieron cargar las obras: ${esc(e.message)}</li>`;
      return;
    }
    armarFiltros();
    pintarKpis();
    pintarLeyenda();
    aplicarFiltros();
  }

  // ---------- KPIs ----------
  function pintarKpis() {
    const k = [];
    if (interno() && st.resumen) {
      const r = st.resumen;
      k.push(['Obras', r.obras_registradas], ['En ejecución', r.obras_en_ejecucion],
        ['Semáforo rojo', r.obras_semaforo_rojo, r.obras_semaforo_rojo > 0],
        ['Cartera', millones(r.presupuesto_total)], ['Medido aprobado', millones(r.monto_medido_aprobado)],
        ['Pagado', millones(r.monto_pagado)],
        ['Mediciones a validar', r.mediciones_pendientes, r.mediciones_pendientes > 0],
        ['Certif. sin fotos', r.certificados_sin_fotos, r.certificados_sin_fotos > 0],
        ['Fotos a revisar', r.fotos_a_revisar, r.fotos_a_revisar > 0]);
    } else {
      const o = st.obras;
      const ejec = o.filter((x) => x.estado === 'En ejecución').length;
      const fin = o.filter((x) => ['Finalizada', 'Recepción definitiva'].includes(x.estado)).length;
      const inv = o.reduce((s, x) => s + Number(x.presupuesto || 0), 0);
      const benef = o.reduce((s, x) => s + Number(x.beneficiarios || 0), 0);
      k.push(['Obras publicadas', o.length], ['En ejecución', ejec], ['Finalizadas', fin],
        ['Inversión', millones(inv)], ['Vecinos beneficiados', benef.toLocaleString('es-AR')]);
    }
    $('kpis').innerHTML = k.map(([e, v, alerta]) =>
      `<div class="kpi${alerta ? ' alerta' : ''}"><div class="v">${esc(v)}</div><div class="e">${esc(e)}</div></div>`).join('');
  }

  function pintarLeyenda() {
    const pares = interno()
      ? Object.entries(COLORES).map(([k, c]) => [k === 'Sin iniciar' ? 'Sin iniciar' : k, c])
      : [['En ejecución', COLOR_ESTADO['En ejecución']], ['Paralizada', COLOR_ESTADO['Paralizada']],
         ['Finalizada', COLOR_ESTADO['Finalizada']], ['Proyecto / licitación', COLOR_ESTADO['En proyecto']]];
    $('leyenda').innerHTML = `<strong>${interno() ? 'Semáforo de avance' : 'Estado'}</strong>` +
      pares.map(([k, c]) => `<div><span class="punto" style="background:${c}"></span>${esc(k)}</div>`).join('');
  }

  // ---------- filtros ----------
  function llenar(sel, valores, etiqueta) {
    const actual = sel.value;
    sel.innerHTML = `<option value="">${etiqueta}</option>` +
      [...new Set(valores.filter(Boolean))].sort().map((v) => `<option>${esc(v)}</option>`).join('');
    sel.value = actual;
  }
  function armarFiltros() {
    llenar($('f-tipo'), st.obras.map((o) => o.tipo_obra), 'Todos los tipos');
    llenar($('f-estado'), st.obras.map((o) => o.estado), 'Todos los estados');
    llenar($('f-barrio'), st.obras.map((o) => o.barrio), 'Todos los barrios');
    $('f-semaforo').hidden = !interno();
    if (!interno()) $('f-semaforo').value = '';
  }
  function aplicarFiltros() {
    const t = $('f-texto').value.trim().toLowerCase();
    const tipo = $('f-tipo').value, est = $('f-estado').value, sem = $('f-semaforo').value, bar = $('f-barrio').value;
    const vis = st.obras.filter((o) =>
      (!tipo || o.tipo_obra === tipo) && (!est || o.estado === est) && (!bar || o.barrio === bar) &&
      (!sem || o.semaforo === sem) &&
      (!t || [o.nombre, o.barrio, o.direccion, o.id_obra, o.descripcion].join(' ').toLowerCase().includes(t)));
    pintarLista(vis);
    pintarMapa(vis);
  }
  ['f-texto', 'f-tipo', 'f-estado', 'f-semaforo', 'f-barrio'].forEach((id) => $(id).addEventListener('input', aplicarFiltros));

  // ---------- lista y mapa ----------
  function pintarLista(obras) {
    $('contador').textContent = `${obras.length} de ${st.obras.length} obras`;
    $('lista').innerHTML = obras.map((o) => `
      <li data-id="${esc(o.id_obra)}" class="${st.activa === o.id_obra ? 'activa' : ''}">
        <span class="punto" style="background:${colorObra(o)}"></span>
        <div><div class="t">${esc(o.nombre)}</div><div class="s">${esc(o.tipo_obra)} · ${esc(o.barrio || '')} · ${esc(o.estado)}</div></div>
        <span class="p">${pct(o.avance_fisico)}</span>
      </li>`).join('') || '<li class="estado-carga">Ninguna obra coincide con los filtros.</li>';
    $('lista').querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => abrirFicha(li.dataset.id, true)));
  }

  function pintarMapa(obras) {
    capa.clearLayers(); st.marcadores = {};
    const pts = [];
    for (const o of obras) {
      if (o.lat == null || o.lng == null) continue;
      const m = L.circleMarker([o.lat, o.lng], {
        radius: 9, color: '#fff', weight: 2, fillColor: colorObra(o), fillOpacity: 0.95
      }).bindTooltip(`<strong>${esc(o.nombre)}</strong><br>${esc(o.estado)} · ${pct(o.avance_fisico)}`, { direction: 'top', offset: [0, -8] });
      m.on('click', () => abrirFicha(o.id_obra, false));
      m.addTo(capa); st.marcadores[o.id_obra] = m; pts.push([o.lat, o.lng]);
    }
    if (pts.length && !st.activa) mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }

  // ---------- ficha ----------
  function barra(lbl, v, color) {
    const w = Math.max(0, Math.min(100, (Number(v) || 0) * 100));
    return `<div class="barra-av"><div class="lbl"><span>${lbl}</span><span class="num">${pct(v)}</span></div>
      <div class="trk"><div class="fill" style="width:${w}%;background:${color}"></div></div></div>`;
  }

  async function abrirFicha(id, centrar) {
    const o = st.obras.find((x) => x.id_obra === id);
    if (!o) return;
    st.activa = id;
    document.querySelectorAll('.lista li').forEach((li) => li.classList.toggle('activa', li.dataset.id === id));
    if (centrar && o.lat != null) mapa.setView([o.lat, o.lng], Math.max(mapa.getZoom(), 15));

    const f = $('ficha');
    const chips = [
      `<span class="chip">${esc(o.tipo_obra)}</span>`, o.subtipo ? `<span class="chip">${esc(o.subtipo)}</span>` : '',
      `<span class="chip">${esc(o.modalidad)}</span>`, `<span class="chip">${esc(o.estado)}</span>`,
      interno() ? `<span class="chip sem" style="background:${colorObra(o)}">${esc(o.semaforo)}</span>` : ''
    ].join('');

    let html = `<button class="cerrar" aria-label="Cerrar">×</button>
      <div class="cod">${esc(o.id_obra)}${interno() && o.expediente ? ' · ' + esc(o.expediente) : ''}</div>
      <h2>${esc(o.nombre)}</h2>
      <div class="chips">${chips}</div>
      <p class="desc">${esc(o.descripcion)}</p>`;

    if (interno()) {
      if (o.estado === 'Paralizada') html += `<div class="aviso rojo">Obra paralizada${o.observaciones ? ': ' + esc(o.observaciones) : ''}</div>`;
      if (o.mediciones_pendientes > 0) html += `<div class="aviso">${o.mediciones_pendientes} medición(es) pendientes de validar.</div>`;
      html += `<div class="barras">
        ${barra('Avance físico (medido y aprobado)', o.avance_fisico, colorObra(o))}
        ${o.avance_previsto != null ? barra('Avance previsto a la fecha', o.avance_previsto, '#8a9099') : ''}
        ${o.avance_financiero != null ? barra('Avance financiero (pagado)', o.avance_financiero, '#1f4e79') : ''}
      </div>
      <dl class="datos">
        <dt>Desvío</dt><dd class="num">${o.desvio == null ? '—' : (o.desvio > 0 ? '+' : '') + pct(o.desvio)}</dd>
        <dt>Presupuesto</dt><dd class="num">${pesos(o.presupuesto)} <small>(${esc(o.escala)})</small></dd>
        <dt>Medido aprobado</dt><dd class="num">${pesos(o.monto_medido_aprobado)}</dd>
        ${o.modalidad === 'Contrato' ? `<dt>Pagado</dt><dd class="num">${pesos(o.monto_pagado)}</dd>` : ''}
        <dt>Contratista</dt><dd>${esc(st.contratistas[o.contratista_id] || (o.modalidad === 'Administración' ? 'Por administración' : 'Sin adjudicar'))}</dd>
        <dt>Inspector</dt><dd>${esc(st.usuarios[o.inspector_id] || '—')}</dd>
        <dt>Área</dt><dd>${esc(o.area_responsable)}</dd>
        <dt>Financiamiento</dt><dd>${esc(o.fuente_financiamiento)}</dd>
        <dt>Inicio / plazo</dt><dd>${fecha(o.fecha_inicio)} · ${o.plazo_dias ?? '—'} días</dd>
        <dt>Fin previsto</dt><dd>${fecha(o.fecha_fin_prevista)}</dd>
        <dt>Ubicación</dt><dd>${esc(o.barrio)} — ${esc(o.direccion)}</dd>
        <dt>Fotos</dt><dd>${o.cant_fotos}</dd>
        <dt>Visor público</dt><dd>${o.visible_publico ? 'Publicada' : 'No publicada'}</dd>
      </dl>
      <div id="ficha-detalle"><p class="estado-carga">Cargando ítems y certificados…</p></div>`;
    } else {
      html += `<div class="barras">${barra('Avance de obra', o.avance_fisico, colorObra(o))}</div>
      <dl class="datos">
        <dt>Inversión</dt><dd class="num">${pesos(o.presupuesto)}</dd>
        <dt>Empresa</dt><dd>${esc(o.contratista || (o.modalidad === 'Administración' ? 'Por administración municipal' : '—'))}</dd>
        <dt>Financiamiento</dt><dd>${esc(o.fuente_financiamiento)}</dd>
        <dt>Inicio</dt><dd>${fecha(o.fecha_inicio)}</dd>
        <dt>Fin previsto</dt><dd>${fecha(o.fecha_fin_prevista)}</dd>
        <dt>Ubicación</dt><dd>${esc(o.barrio)} — ${esc(o.direccion)}</dd>
        <dt>Beneficiarios</dt><dd>${o.beneficiarios ? Number(o.beneficiarios).toLocaleString('es-AR') + ' vecinos' : '—'}</dd>
      </dl>`;
    }
    f.innerHTML = html; f.hidden = false; f.scrollTop = 0;
    f.querySelector('.cerrar').addEventListener('click', cerrarFicha);
    if (interno()) cargarDetalle(o);
  }

  async function cargarDetalle(o) {
    const [it, ce] = await Promise.all([
      sb.from('v_items').select('nro_item,descripcion,unidad,cantidad,subtotal,incidencia,avance_item').eq('id_obra', o.id_obra).order('nro_item'),
      o.modalidad === 'Contrato'
        ? sb.from('v_certificados').select('nro_certificado,periodo,estado,monto_bruto,monto_neto,control_respaldo').eq('id_obra', o.id_obra).order('nro_certificado')
        : Promise.resolve({ data: [] })
    ]);
    const cont = $('ficha-detalle');
    if (!cont || st.activa !== o.id_obra) return;
    if (it.error || ce.error) { cont.innerHTML = `<p class="estado-carga">Error: ${esc((it.error || ce.error).message)}</p>`; return; }
    let h = `<h3>Ítems (${it.data.length})</h3><table class="t"><thead><tr><th>#</th><th>Ítem</th><th class="n">Incid.</th><th class="n">Avance</th></tr></thead><tbody>` +
      it.data.map((i) => `<tr><td>${i.nro_item}</td><td>${esc(i.descripcion)}<br><small>${Number(i.cantidad).toLocaleString('es-AR')} ${esc(i.unidad)}</small></td>
        <td class="n">${pct(i.incidencia)}</td><td class="n">${pct(i.avance_item)}</td></tr>`).join('') + '</tbody></table>';
    if (ce.data.length) {
      h += `<h3>Certificados (${ce.data.length})</h3><table class="t"><thead><tr><th>N°</th><th>Período</th><th>Estado</th><th class="n">Neto</th></tr></thead><tbody>` +
        ce.data.map((c) => `<tr><td>${c.nro_certificado}</td><td>${esc(c.periodo)}</td>
          <td>${esc(c.estado)}${c.control_respaldo !== 'OK' ? ' <span style="color:var(--rojo)">· sin fotos</span>' : ''}</td>
          <td class="n">${millones(c.monto_neto)}</td></tr>`).join('') + '</tbody></table>';
    } else if (o.modalidad === 'Administración') {
      h += `<p class="estado-carga">Obra por administración: se sigue por mediciones, fotos y partes diarios.</p>`;
    }
    cont.innerHTML = h;
  }

  function cerrarFicha() {
    $('ficha').hidden = true; st.activa = null;
    document.querySelectorAll('.lista li.activa').forEach((li) => li.classList.remove('activa'));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarFicha(); });

  // ---------- sesión ----------
  async function actualizarSesion(session) {
    st.rol = null; st.idUsuario = null;
    if (session) {
      const [r, u] = await Promise.all([sb.rpc('mi_rol'), sb.rpc('mi_usuario')]);
      st.rol = r.data || null; st.idUsuario = u.data || null;
    }
    const info = $('usuario-info');
    if (session && st.rol) {
      info.innerHTML = `${esc(session.user.email)}<br><strong>${esc(st.rol)}</strong>`;
      $('subtitulo').textContent = `${cfg.municipio} · Tablero interno`;
    } else if (session) {
      info.innerHTML = `${esc(session.user.email)}<br><strong>Sin rol asignado</strong>`;
      $('subtitulo').textContent = `${cfg.municipio} · Visor público`;
    } else {
      $('subtitulo').textContent = `${cfg.municipio} · Visor público`;
    }
    info.hidden = !session;
    $('btn-login').hidden = !!session;
    $('btn-logout').hidden = !session;
    cerrarFicha();
    await cargar();
  }

  $('btn-login').addEventListener('click', () => { $('login-error').textContent = ''; $('dlg-login').showModal(); });
  $('login-cancelar').addEventListener('click', () => $('dlg-login').close());
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = 'Ingresando…';
    const { error } = await sb.auth.signInWithPassword({ email: $('login-email').value.trim(), password: $('login-pass').value });
    if (error) { $('login-error').textContent = 'Email o contraseña incorrectos.'; return; }
    $('dlg-login').close();
  });
  $('btn-logout').addEventListener('click', () => sb.auth.signOut());

  let ultimoUid;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session?.user?.id ?? null;
    if (uid === ultimoUid) return;       // evita recargar en refresh de token
    ultimoUid = uid;
    setTimeout(() => actualizarSesion(session), 0);
  });
})();
