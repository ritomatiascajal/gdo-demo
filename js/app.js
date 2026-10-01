/* GdO — tablero y visor de obras (web estática + Supabase + Leaflet)
 * Inicio: el visitante elige si es vecino (visor público) o funcionario (ingresa con usuario).
 * Funcionario: tablero con semáforo, validación de mediciones y, según rol, alta y edición de obras e ítems.
 */
(() => {
  const cfg = window.GDO_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  const COLORES = { Rojo: '#c0392b', Amarillo: '#d69e00', Verde: '#2e8b57', 'Sin iniciar': '#8a9099' };
  const COLOR_ESTADO = {
    'En proyecto': '#8a9099', 'En licitación': '#8a9099', 'Adjudicada': '#6c7fa0',
    'En ejecución': '#2f6fae', 'Paralizada': '#c0392b', 'Finalizada': '#2e8b57',
    'Recepción definitiva': '#2e8b57', 'Cancelada': '#5b6168'
  };
  const ESTADOS = ['En proyecto', 'En licitación', 'Adjudicada', 'En ejecución', 'Paralizada', 'Finalizada', 'Recepción definitiva', 'Cancelada'];
  const ROLES_GESTION = ['Secretario de Obras Públicas', 'Jefe de Servicios Públicos', 'Administrador del sistema'];
  const ROLES_VALIDAN = ['Secretario de Obras Públicas', 'Jefe de Servicios Públicos'];

  const st = {
    rol: null, idUsuario: null, obras: [], resumen: null, contratistas: {}, usuarios: {}, inspectores: [],
    cat: {}, marcadores: {}, activa: null, ed: null, enApp: false
  };
  const $ = (id) => document.getElementById(id);

  // ---------- formato ----------
  const pesos = (v) => v == null ? '—' : '$ ' + Number(v).toLocaleString('es-AR', { maximumFractionDigits: 0 });
  const millones = (v) => v == null ? '—' : '$ ' + (Number(v) / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M';
  const pct = (v) => v == null ? '—' : (Number(v) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
  const fecha = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-AR') : '—';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const interno = () => !!st.rol;
  const puedeGestionar = () => ROLES_GESTION.includes(st.rol);
  const puedeValidar = () => ROLES_VALIDAN.includes(st.rol);
  const colorObra = (o) => interno() ? (COLORES[o.semaforo] || COLORES['Sin iniciar']) : (COLOR_ESTADO[o.estado] || '#8a9099');
  const opciones = (lista, actual, vacio) => (vacio !== undefined ? `<option value="">${esc(vacio)}</option>` : '') +
    // si el valor guardado no está en el catálogo, se conserva igual
    ((actual && !lista.some((v) => (Array.isArray(v) ? v[0] : v) === actual)) ? [actual, ...lista] : lista).map((v) => { const [val, txt] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(val)}"${val === actual ? ' selected' : ''}>${esc(txt)}</option>`; }).join('');

  // ---------- mapa ----------
  const mapa = L.map('mapa', { zoomControl: true }).setView(cfg.centro, cfg.zoom);
  const callesClaro = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const callesOscuro = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO' });
  const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imágenes © Esri' });
  const calles = L.layerGroup();
  const control = L.control.layers({ 'Calles': calles, 'Satélite': satelite }, null, { position: 'topleft' }).addTo(mapa);
  calles.addTo(mapa);
  function aplicarTemaMapa() {
    const oscuro = window.GDO_TEMA && window.GDO_TEMA.actual() === 'dark';
    calles.clearLayers(); calles.addLayer(oscuro ? callesOscuro : callesClaro);
  }
  aplicarTemaMapa();
  document.addEventListener('tema', aplicarTemaMapa);
  const capa = L.layerGroup().addTo(mapa);
  let marcadorEdicion = null;

  // ---------- pantalla de inicio ----------
  function mostrarInicio() {
    st.enApp = false; $('inicio').hidden = false; $('app').hidden = true; window.scrollTo(0, 0);
  }
  function mostrarApp() {
    if (!st.enApp) { st.enApp = true; $('inicio').hidden = true; $('app').hidden = false; }
    setTimeout(() => mapa.invalidateSize(), 0);
  }
  $('op-vecino').addEventListener('click', async () => { mostrarApp(); if (!st.obras.length || interno()) await cargar(); });
  $('op-funcionario').addEventListener('click', abrirLogin);
  $('btn-inicio').addEventListener('click', () => { if (!interno()) { cerrarFicha(); mostrarInicio(); } });

  // ---------- datos ----------
  async function cargar() {
    $('lista').innerHTML = '<li class="estado-carga">Cargando obras…</li>';
    try {
      if (interno()) {
        const campos = 'id_obra,nombre,descripcion,tipo_obra,subtipo,modalidad,estado,fuente_financiamiento,area_responsable,barrio,direccion,lat,lng,expediente,contratista_id,inspector_id,fecha_inicio,plazo_dias,fecha_fin_prevista,presupuesto,monto_medido_aprobado,avance_fisico,avance_previsto,desvio,semaforo,escala,monto_pagado,avance_financiero,cant_fotos,mediciones_pendientes,beneficiarios,visible_publico,observaciones';
        const [o, r, c, u] = await Promise.all([
          sb.from('v_obras').select(campos).order('id_obra'),
          sb.from('v_resumen').select('*').single(),
          sb.from('contratistas').select('id_contratista,razon_social,activo').order('razon_social'),
          sb.from('usuarios').select('id_usuario,nombre,rol,activo').order('id_usuario')
        ]);
        for (const x of [o, r, c, u]) if (x.error) throw x.error;
        st.obras = o.data; st.resumen = r.data;
        st.contratistas = Object.fromEntries(c.data.map((x) => [x.id_contratista, x.razon_social]));
        st.listaContratistas = c.data.filter((x) => x.activo !== false);
        st.usuarios = Object.fromEntries(u.data.map((x) => [x.id_usuario, x.nombre]));
        st.inspectores = u.data.filter((x) => x.rol === 'Inspector de obra' && x.activo !== false);
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
    armarFiltros(); pintarKpis(); pintarLeyenda(); aplicarFiltros();
  }

  async function cargarCatalogos() {
    const { data, error } = await sb.from('catalogos').select('categoria,valor,orden,activo').order('orden');
    if (error) { console.error(error); return; }
    st.cat = {};
    for (const r of data) if (r.activo !== false) (st.cat[r.categoria] ||= []).push(r.valor);
  }

  // ---------- KPIs y leyenda ----------
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
      ? Object.entries(COLORES)
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
    $('btn-nueva').hidden = !puedeGestionar();
  }
  function aplicarFiltros() {
    const t = $('f-texto').value.trim().toLowerCase();
    const tipo = $('f-tipo').value, est = $('f-estado').value, sem = $('f-semaforo').value, bar = $('f-barrio').value;
    const vis = st.obras.filter((o) =>
      (!tipo || o.tipo_obra === tipo) && (!est || o.estado === est) && (!bar || o.barrio === bar) &&
      (!sem || o.semaforo === sem) &&
      (!t || [o.nombre, o.barrio, o.direccion, o.id_obra, o.descripcion].join(' ').toLowerCase().includes(t)));
    pintarLista(vis); pintarMapa(vis);
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
      const m = L.circleMarker([o.lat, o.lng], { radius: 9, color: '#fff', weight: 2, fillColor: colorObra(o), fillOpacity: 0.95 })
        .bindTooltip(`<strong>${esc(o.nombre)}</strong><br>${esc(o.estado)} · ${pct(o.avance_fisico)}`, { direction: 'top', offset: [0, -8] });
      m.on('click', () => { if (!st.eligiendo) abrirFicha(o.id_obra, false); });
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

  function abrirFicha(id, centrar) {
    const o = st.obras.find((x) => x.id_obra === id);
    if (!o) return;
    quitarMarcadorEdicion(); st.ed = null;
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
      ${puedeGestionar() ? '<div class="acciones-ficha"><button class="btn-f" id="btn-editar">✎ Editar obra</button></div>' : ''}
      <p class="desc">${esc(o.descripcion)}</p>`;

    if (interno()) {
      if (o.estado === 'Paralizada') html += `<div class="aviso rojo">Obra paralizada${o.observaciones ? ': ' + esc(o.observaciones) : ''}</div>`;
      if (o.mediciones_pendientes > 0) html += `<div class="aviso">${o.mediciones_pendientes} medición(es) pendientes de validar.</div>`;
      if (!o.presupuesto) html += `<div class="aviso">La obra todavía no tiene ítems cargados: agregalos abajo para armar el presupuesto.</div>`;
      html += `<div class="barras">
        ${barra('Avance físico (medido y aprobado)', o.avance_fisico, colorObra(o))}
        ${o.avance_previsto != null ? barra('Avance previsto a la fecha', o.avance_previsto, '#8a9099') : ''}
        ${o.avance_financiero != null ? barra('Avance financiero (pagado)', o.avance_financiero, '#2f6fae') : ''}
      </div>
      <dl class="datos">
        <dt>Desvío</dt><dd class="num">${o.desvio == null ? '—' : (o.desvio > 0 ? '+' : '') + pct(o.desvio)}</dd>
        <dt>Presupuesto</dt><dd class="num">${pesos(o.presupuesto)} <small>(${esc(o.escala)})</small></dd>
        <dt>Medido aprobado</dt><dd class="num">${pesos(o.monto_medido_aprobado)}</dd>
        ${o.modalidad === 'Contrato' ? `<dt>Pagado</dt><dd class="num">${pesos(o.monto_pagado)}</dd>` : ''}
        <dt>Contratista</dt><dd>${esc(st.contratistas[o.contratista_id] || (o.modalidad === 'Administración' ? 'Por administración' : 'Sin adjudicar'))}</dd>
        <dt>Inspector</dt><dd>${esc(st.usuarios[o.inspector_id] || '—')}</dd>
        <dt>Área</dt><dd>${esc(o.area_responsable || '—')}</dd>
        <dt>Financiamiento</dt><dd>${esc(o.fuente_financiamiento || '—')}</dd>
        <dt>Inicio / plazo</dt><dd>${fecha(o.fecha_inicio)} · ${o.plazo_dias ?? '—'} días</dd>
        <dt>Fin previsto</dt><dd>${fecha(o.fecha_fin_prevista)}</dd>
        <dt>Ubicación</dt><dd>${esc(o.barrio || '')} — ${esc(o.direccion || '')}</dd>
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
    f.innerHTML = html; f.hidden = false; f.classList.remove('oculta'); f.scrollTop = 0;
    f.querySelector('.cerrar').addEventListener('click', cerrarFicha);
    if (puedeGestionar()) $('btn-editar').addEventListener('click', () => abrirEditor(o));
    if (interno()) cargarDetalle(o);
  }

  async function cargarDetalle(o) {
    const [it, ce, pe, fo] = await Promise.all([
      sb.from('v_items').select('id_item,nro_item,rubro,descripcion,unidad,cantidad,precio_unitario,subtotal,incidencia,avance_item').eq('id_obra', o.id_obra).order('nro_item'),
      o.modalidad === 'Contrato'
        ? sb.from('v_certificados').select('nro_certificado,periodo,estado,monto_bruto,monto_neto,control_respaldo').eq('id_obra', o.id_obra).order('nro_certificado')
        : Promise.resolve({ data: [] }),
      sb.from('v_mediciones').select('id_medicion,periodo,fecha,item_descripcion,unidad,cantidad_periodo,monto,inspector_id,observaciones')
        .eq('id_obra', o.id_obra).eq('estado_validacion', 'Pendiente').order('fecha', { ascending: false }),
      sb.from('v_fotos').select('id_foto,id_medicion,archivo,fecha_hora,distancia_obra_m,control_ubicacion')
        .eq('id_obra', o.id_obra).order('fecha_hora', { ascending: false }).limit(30)
    ]);
    const cont = $('ficha-detalle');
    if (!cont || st.activa !== o.id_obra) return;
    const err = it.error || ce.error || pe.error || fo.error;
    if (err) { cont.innerHTML = `<p class="estado-carga">Error: ${esc(err.message)}</p>`; return; }
    o.items = it.data;

    // Fotos con archivo real en el almacenamiento (las del Excel de ejemplo no tienen archivo)
    let fotos = [];
    if (fo.data.length) {
      const r = await sb.storage.from('fotos').createSignedUrls(fo.data.map((f) => f.archivo), 3600);
      const urls = Object.fromEntries((r.data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
      fotos = fo.data.filter((f) => urls[f.archivo]).map((f) => ({ ...f, url: urls[f.archivo] }));
    }
    const fotosDe = (idMed) => fotos.filter((f) => f.id_medicion === idMed);
    const mini = (f) => `<a href="${f.url}" target="_blank" rel="noopener" class="mini${f.control_ubicacion === 'REVISAR' ? ' revisar' : ''}"
        title="${esc(new Date(f.fecha_hora).toLocaleString('es-AR'))}${f.distancia_obra_m != null ? ' · a ' + f.distancia_obra_m + ' m de la obra' : ' · sin GPS'}">
        <img src="${f.url}" alt="Foto ${esc(f.id_foto)}" loading="lazy">${f.control_ubicacion === 'REVISAR' ? '<span>lejos</span>' : ''}</a>`;

    let h = '';
    if (pe.data.length) {
      h += `<h3>Mediciones a validar (${pe.data.length})</h3>` + pe.data.map((m) => `
        <div class="pend" data-med="${esc(m.id_medicion)}">
          <div class="pend-cab"><strong>${esc(m.item_descripcion)}</strong><span class="num">${pesos(m.monto)}</span></div>
          <div class="pend-sub">${esc(m.id_medicion)} · ${esc(m.periodo)} · ${fecha(m.fecha)} · <span class="num">${Number(m.cantidad_periodo).toLocaleString('es-AR')} ${esc(m.unidad)}</span> · ${esc(st.usuarios[m.inspector_id] || m.inspector_id)}</div>
          ${m.observaciones ? `<div class="pend-sub">“${esc(m.observaciones)}”</div>` : ''}
          ${fotosDe(m.id_medicion).length ? `<div class="minis">${fotosDe(m.id_medicion).map(mini).join('')}</div>` : '<div class="pend-sub" style="color:var(--rojo)">Sin foto cargada</div>'}
          ${puedeValidar() ? `<div class="pend-acc"><button class="btn-v ok" data-acc="Aprobada">Aprobar</button><button class="btn-v obs" data-acc="Observada">Observar</button></div>` : ''}
        </div>`).join('');
    }
    const gest = puedeGestionar();
    h += `<h3><span>Ítems (${it.data.length})</span>${gest ? '<button class="btn-f" id="btn-item-nuevo">＋ Ítem</button>' : ''}</h3>
      <div id="item-form-slot"></div>
      <table class="t"><thead><tr><th>#</th><th>Ítem</th><th class="n">Incid.</th><th class="n">Avance</th>${gest ? '<th></th>' : ''}</tr></thead><tbody>` +
      it.data.map((i) => `<tr data-item="${esc(i.id_item)}"><td>${i.nro_item}</td><td>${esc(i.descripcion)}<br><small>${Number(i.cantidad).toLocaleString('es-AR')} ${esc(i.unidad)} × ${pesos(i.precio_unitario)}</small></td>
        <td class="n">${pct(i.incidencia)}</td><td class="n">${pct(i.avance_item)}</td>
        ${gest ? `<td class="acc"><button class="mini-btn" data-ed-item title="Editar ítem">✎</button><button class="mini-btn" data-del-item title="Borrar ítem">🗑</button></td>` : ''}</tr>`).join('') +
      (it.data.length ? '' : `<tr><td colspan="${gest ? 5 : 4}" class="estado-carga">Sin ítems.</td></tr>`) + '</tbody></table>';
    if (ce.data.length) {
      h += `<h3>Certificados (${ce.data.length})</h3><table class="t"><thead><tr><th>N°</th><th>Período</th><th>Estado</th><th class="n">Neto</th></tr></thead><tbody>` +
        ce.data.map((c) => `<tr><td>${c.nro_certificado}</td><td>${esc(c.periodo)}</td>
          <td>${esc(c.estado)}${c.control_respaldo !== 'OK' ? ' <span style="color:var(--rojo)">· sin fotos</span>' : ''}</td>
          <td class="n">${millones(c.monto_neto)}</td></tr>`).join('') + '</tbody></table>';
    } else if (o.modalidad === 'Administración') {
      h += `<p class="estado-carga">Obra por administración: se sigue por mediciones, fotos y partes diarios.</p>`;
    }
    const aRevisar = fo.data.filter((f) => f.control_ubicacion === 'REVISAR').length;
    h += `<h3>Fotos (${fo.data.length} registradas${aRevisar ? `, ${aRevisar} a revisar por ubicación` : ''})</h3>` +
      (fotos.length ? `<div class="minis grande">${fotos.map(mini).join('')}</div>`
        : '<p class="estado-carga">Las fotos de los datos de ejemplo no tienen imagen. Las que cargue el inspector desde la app aparecen acá.</p>');
    cont.innerHTML = h;

    cont.querySelectorAll('.pend-acc button').forEach((b) => b.addEventListener('click', () =>
      validar(o, b.closest('.pend').dataset.med, b.dataset.acc, b)));
    if (gest) {
      $('btn-item-nuevo').addEventListener('click', () => formItem(o, null));
      cont.querySelectorAll('[data-ed-item]').forEach((b) => b.addEventListener('click', () =>
        formItem(o, o.items.find((i) => i.id_item === b.closest('tr').dataset.item))));
      cont.querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', () =>
        borrarItem(o, o.items.find((i) => i.id_item === b.closest('tr').dataset.item))));
    }
  }

  async function refrescar(id) { await cargar(); if (id) abrirFicha(id, false); }

  async function validar(o, idMed, estado, btn) {
    let obs = null;
    if (estado === 'Observada') {
      obs = prompt('Motivo de la observación (lo ve el inspector):');
      if (obs === null) return;
    }
    const botones = btn.closest('.pend-acc').querySelectorAll('button');
    botones.forEach((x) => { x.disabled = true; });
    const cambios = { estado_validacion: estado, validado_por: st.idUsuario };
    if (obs) cambios.observaciones = obs;
    const { error } = await sb.from('mediciones').update(cambios).eq('id_medicion', idMed);
    if (error) { alert('No se pudo guardar: ' + error.message); botones.forEach((x) => { x.disabled = false; }); return; }
    await refrescar(o.id_obra);
  }

  function cerrarFicha() {
    terminarEleccion(false); quitarMarcadorEdicion(); st.ed = null;
    $('ficha').hidden = true; st.activa = null;
    document.querySelectorAll('.lista li.activa').forEach((li) => li.classList.remove('activa'));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (st.eligiendo) terminarEleccion(false); else cerrarFicha(); } });

  // ---------- alta / edición de obra ----------
  $('btn-nueva').addEventListener('click', () => abrirEditor(null));

  function quitarMarcadorEdicion() { if (marcadorEdicion) { mapa.removeLayer(marcadorEdicion); marcadorEdicion = null; } }
  function ponerMarcadorEdicion(lat, lng) {
    quitarMarcadorEdicion();
    marcadorEdicion = L.circleMarker([lat, lng], { radius: 11, color: '#d69e00', weight: 3, dashArray: '4 3', fillColor: '#d69e00', fillOpacity: .35 }).addTo(mapa);
  }

  function abrirEditor(o) {
    const nueva = !o;
    const v = o || { modalidad: 'Contrato', estado: 'En proyecto', visible_publico: false };
    st.ed = { id: o?.id_obra || null, lat: v.lat ?? null, lng: v.lng ?? null, movida: false };
    st.activa = o?.id_obra || null;
    const cat = (k) => st.cat[k] || [];
    const contr = (st.listaContratistas || []).map((c) => [c.id_contratista, c.razon_social]);
    const insp = st.inspectores.map((u) => [u.id_usuario, u.nombre]);
    const f = $('ficha');
    f.innerHTML = `<button class="cerrar" aria-label="Cerrar">×</button>
      <div class="cod">${nueva ? 'Obra nueva' : esc(o.id_obra)}</div>
      <h2>${nueva ? 'Cargar obra' : 'Editar obra'}</h2>
      <form class="form-ed" id="form-obra" novalidate>
        <label>Nombre *<input name="nombre" required maxlength="120" value="${esc(v.nombre)}" placeholder="Ej.: Pavimento calle Mitre"></label>
        <label>Descripción<textarea name="descripcion" placeholder="Alcance de la obra">${esc(v.descripcion)}</textarea></label>
        <div class="fila">
          <label>Tipo *<select name="tipo_obra" required>${opciones(cat('tipo_obra'), v.tipo_obra, 'Elegir…')}</select></label>
          <label>Subtipo<select name="subtipo">${opciones(cat('subtipo'), v.subtipo, '—')}</select></label>
        </div>
        <div class="fila">
          <label>Modalidad *<select name="modalidad">${opciones(['Contrato', 'Administración'], v.modalidad)}</select></label>
          <label>Estado *<select name="estado">${opciones(ESTADOS, v.estado)}</select></label>
        </div>
        <div class="fila">
          <label>Financiamiento<select name="fuente_financiamiento">${opciones(cat('fuente'), v.fuente_financiamiento, '—')}</select></label>
          <label>Área responsable<select name="area_responsable">${opciones(cat('area'), v.area_responsable, '—')}</select></label>
        </div>
        <fieldset>
          <legend>Ubicación</legend>
          <div class="fila">
            <label>Barrio<select name="barrio">${opciones(cat('barrio'), v.barrio, '—')}</select></label>
            <label>Dirección / referencia<input name="direccion" value="${esc(v.direccion)}"></label>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <span class="ubic-txt" id="ubic-txt"></span>
            <button type="button" class="btn-f" id="btn-ubicar">⌖ Marcar en el mapa</button>
          </div>
        </fieldset>
        <div class="fila">
          <label>Contratista<select name="contratista_id">${opciones(contr, v.contratista_id, 'Sin adjudicar')}</select></label>
          <label>Inspector<select name="inspector_id">${opciones(insp, v.inspector_id, 'Sin asignar')}</select></label>
        </div>
        <div class="fila3">
          <label>Expediente<input name="expediente" value="${esc(v.expediente)}"></label>
          <label>Inicio<input type="date" name="fecha_inicio" value="${esc(v.fecha_inicio ? String(v.fecha_inicio).slice(0, 10) : '')}"></label>
          <label>Plazo (días)<input type="number" min="1" name="plazo_dias" value="${esc(v.plazo_dias)}"></label>
        </div>
        <div class="fila">
          <label>Beneficiarios<input type="number" min="0" name="beneficiarios" value="${esc(v.beneficiarios)}"></label>
          <label class="chk" style="align-self:end;padding-bottom:6px"><input type="checkbox" name="visible_publico" ${v.visible_publico ? 'checked' : ''}> Publicar en visor de vecinos</label>
        </div>
        <label>Observaciones<textarea name="observaciones">${esc(v.observaciones)}</textarea></label>
        <p class="error" id="obra-error"></p>
        <div class="botones">
          <button type="button" class="btn-f" id="obra-cancelar">Cancelar</button>
          <button type="submit" class="btn-f lleno" id="obra-guardar">${nueva ? 'Crear obra' : 'Guardar cambios'}</button>
        </div>
      </form>`;
    f.hidden = false; f.classList.remove('oculta'); f.scrollTop = 0;
    pintarUbic();
    if (st.ed.lat != null) ponerMarcadorEdicion(st.ed.lat, st.ed.lng);
    const form = $('form-obra');
    const sincronizarContratista = () => { form.contratista_id.disabled = form.modalidad.value === 'Administración'; };
    form.modalidad.addEventListener('change', sincronizarContratista); sincronizarContratista();
    f.querySelector('.cerrar').addEventListener('click', cerrarFicha);
    $('obra-cancelar').addEventListener('click', () => { quitarMarcadorEdicion(); nueva ? cerrarFicha() : abrirFicha(o.id_obra, false); });
    $('btn-ubicar').addEventListener('click', empezarEleccion);
    form.addEventListener('submit', (e) => { e.preventDefault(); guardarObra(form, nueva); });
  }

  function pintarUbic() {
    const el = $('ubic-txt'); if (!el) return;
    el.textContent = st.ed.lat != null ? `${st.ed.lat.toFixed(5)}, ${st.ed.lng.toFixed(5)}${st.ed.movida ? ' (nueva)' : ''}` : 'Sin ubicar';
  }

  function empezarEleccion() {
    st.eligiendo = true;
    $('ficha').classList.add('oculta');
    $('banner-ubic').hidden = false;
    document.querySelector('.mapa-wrap').classList.add('eligiendo');
    if (window.matchMedia('(max-width: 760px)').matches) document.querySelector('.mapa-wrap').scrollIntoView({ behavior: 'smooth' });
  }
  function terminarEleccion(ok) {
    if (!st.eligiendo) return;
    st.eligiendo = false;
    $('banner-ubic').hidden = true;
    document.querySelector('.mapa-wrap').classList.remove('eligiendo');
    $('ficha').classList.remove('oculta');
    if (ok) pintarUbic();
  }
  $('ubic-cancelar').addEventListener('click', () => terminarEleccion(false));
  mapa.on('click', (e) => {
    if (!st.eligiendo || !st.ed) return;
    st.ed.lat = e.latlng.lat; st.ed.lng = e.latlng.lng; st.ed.movida = true;
    ponerMarcadorEdicion(st.ed.lat, st.ed.lng);
    terminarEleccion(true);
  });

  async function guardarObra(form, nueva) {
    const err = $('obra-error'); err.textContent = '';
    const val = (n) => { const x = form[n].value.trim(); return x === '' ? null : x; };
    const num = (n) => { const x = val(n); return x == null ? null : Number(x); };
    if (!val('nombre')) { err.textContent = 'Falta el nombre de la obra.'; form.nombre.focus(); return; }
    if (!val('tipo_obra')) { err.textContent = 'Elegí el tipo de obra.'; form.tipo_obra.focus(); return; }
    if (nueva && st.ed.lat == null) { err.textContent = 'Marcá la ubicación de la obra en el mapa.'; return; }
    if (val('fecha_inicio') && !num('plazo_dias')) { err.textContent = 'Si cargás fecha de inicio, poné también el plazo en días.'; form.plazo_dias.focus(); return; }
    const datos = {
      nombre: val('nombre'), descripcion: val('descripcion'), tipo_obra: val('tipo_obra'), subtipo: val('subtipo'),
      modalidad: form.modalidad.value, estado: form.estado.value,
      fuente_financiamiento: val('fuente_financiamiento'), area_responsable: val('area_responsable'),
      barrio: val('barrio'), direccion: val('direccion'),
      contratista_id: form.modalidad.value === 'Administración' ? null : val('contratista_id'),
      inspector_id: val('inspector_id'), expediente: val('expediente'),
      fecha_inicio: val('fecha_inicio'), plazo_dias: num('plazo_dias'), beneficiarios: num('beneficiarios'),
      visible_publico: form.visible_publico.checked, observaciones: val('observaciones')
    };
    if (st.ed.movida || nueva) datos.geom = `SRID=4326;POINT(${st.ed.lng} ${st.ed.lat})`;
    const btn = $('obra-guardar'); btn.disabled = true; btn.textContent = 'Guardando…';
    let id = st.ed.id, error;
    if (nueva) {
      const r = await sb.from('obras').insert(datos).select('id_obra').single();
      error = r.error; id = r.data?.id_obra;
    } else {
      ({ error } = await sb.from('obras').update(datos).eq('id_obra', id));
    }
    if (error) { err.textContent = 'No se pudo guardar: ' + error.message; btn.disabled = false; btn.textContent = nueva ? 'Crear obra' : 'Guardar cambios'; return; }
    quitarMarcadorEdicion(); st.ed = null;
    await refrescar(id);
  }

  // ---------- ítems ----------
  function formItem(o, i) {
    const slot = $('item-form-slot'); if (!slot) return;
    const sig = (o.items || []).reduce((m, x) => Math.max(m, x.nro_item), 0) + 1;
    const v = i || { nro_item: sig };
    slot.innerHTML = `<form class="form-ed item-form" id="form-item" novalidate>
        <strong style="font-size:13px">${i ? `Editar ítem ${i.nro_item}` : 'Nuevo ítem'}</strong>
        <div class="fila3">
          <label>N°<input type="number" min="1" name="nro_item" value="${esc(v.nro_item)}"></label>
          <label style="grid-column:span 2">Rubro<input name="rubro" value="${esc(v.rubro)}" placeholder="Ej.: Movimiento de suelo"></label>
        </div>
        <label>Descripción *<input name="descripcion" value="${esc(v.descripcion)}" placeholder="Ej.: Excavación de zanja"></label>
        <div class="fila3">
          <label>Unidad *<select name="unidad">${opciones(st.cat.unidad || ['m2', 'm3', 'ml', 'u', 'gl'], v.unidad)}</select></label>
          <label>Cantidad *<input type="number" min="0" step="any" name="cantidad" value="${esc(v.cantidad)}"></label>
          <label>Precio unit. *<input type="number" min="0" step="any" name="precio_unitario" value="${esc(v.precio_unitario)}"></label>
        </div>
        <p class="error" id="item-error"></p>
        <div class="botones">
          <button type="button" class="btn-f" id="item-cancelar">Cancelar</button>
          <button type="submit" class="btn-f lleno">${i ? 'Guardar' : 'Agregar ítem'}</button>
        </div>
      </form>`;
    const form = $('form-item');
    form.descripcion.focus();
    $('item-cancelar').addEventListener('click', () => { slot.innerHTML = ''; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('item-error'); err.textContent = '';
      const d = {
        nro_item: Number(form.nro_item.value), rubro: form.rubro.value.trim() || null, descripcion: form.descripcion.value.trim(),
        unidad: form.unidad.value, cantidad: Number(form.cantidad.value), precio_unitario: Number(form.precio_unitario.value)
      };
      if (!d.descripcion || !(d.nro_item > 0) || form.cantidad.value === '' || form.precio_unitario.value === '') { err.textContent = 'Completá número, descripción, cantidad y precio.'; return; }
      const r = i ? await sb.from('items').update(d).eq('id_item', i.id_item) : await sb.from('items').insert({ ...d, id_obra: o.id_obra });
      if (r.error) { err.textContent = r.error.code === '23505' ? `Ya existe un ítem con el número ${d.nro_item} en esta obra.` : 'No se pudo guardar: ' + r.error.message; return; }
      await refrescar(o.id_obra);
    });
  }

  async function borrarItem(o, i) {
    const { data, error } = await sb.from('mediciones').select('id_medicion').eq('id_item', i.id_item).limit(1);
    if (error) { alert('No se pudo verificar: ' + error.message); return; }
    if (data.length) { alert(`El ítem ${i.nro_item} ya tiene mediciones cargadas y no se puede borrar. Si cambió el cómputo, editá la cantidad.`); return; }
    if (!confirm(`¿Borrar el ítem ${i.nro_item} — ${i.descripcion}?`)) return;
    const r = await sb.from('items').delete().eq('id_item', i.id_item);
    if (r.error) { alert('No se pudo borrar: ' + r.error.message); return; }
    await refrescar(o.id_obra);
  }

  // ---------- sesión ----------
  async function actualizarSesion(session) {
    st.rol = null; st.idUsuario = null;
    if (session) {
      const [r, u] = await Promise.all([sb.rpc('mi_rol'), sb.rpc('mi_usuario')]);
      st.rol = r.data || null; st.idUsuario = u.data || null;
    }
    const info = $('usuario-info');
    if (session) info.innerHTML = `${esc(session.user.email)}<br><strong>${esc(st.rol || 'Sin rol asignado')}</strong>`;
    $('subtitulo').textContent = `${cfg.municipio} · ${st.rol ? 'Tablero interno' : 'Visor público'}`;
    $('link-inspector').hidden = st.rol !== 'Inspector de obra';
    info.hidden = !session;
    $('btn-login').hidden = !!session;
    $('btn-logout').hidden = !session;
    cerrarFicha();
    if (puedeGestionar()) await cargarCatalogos();
    if (session) mostrarApp();
    if (session || st.enApp) await cargar();
    if (!session && !st.enApp) mostrarInicio();
  }

  function abrirLogin() { $('login-error').textContent = ''; $('dlg-login').showModal(); }
  $('btn-login').addEventListener('click', abrirLogin);
  $('login-cancelar').addEventListener('click', () => $('dlg-login').close());
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = 'Ingresando…';
    const { error } = await sb.auth.signInWithPassword({ email: $('login-email').value.trim(), password: $('login-pass').value });
    if (error) { $('login-error').textContent = 'Email o contraseña incorrectos.'; return; }
    $('dlg-login').close();
  });
  $('btn-logout').addEventListener('click', async () => { st.enApp = false; await sb.auth.signOut(); });

  let ultimoUid;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session?.user?.id ?? null;
    if (uid === ultimoUid) return;       // evita recargar en refresh de token
    ultimoUid = uid;
    setTimeout(() => actualizarSesion(session), 0);
  });
})();
