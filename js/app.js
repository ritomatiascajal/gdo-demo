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
  const GRUPOS = [
    ['todas', 'Todas', null, null],
    ['ejecucion', 'En ejecución', ['En ejecución'], '#2f6fae'],
    ['paralizadas', 'Paralizadas', ['Paralizada'], '#c0392b'],
    ['finalizadas', 'Finalizadas', ['Finalizada', 'Recepción definitiva'], '#2e8b57'],
    ['proyecto', 'En proyecto / licitación', ['En proyecto', 'En licitación', 'Adjudicada'], '#8a9099'],
    ['canceladas', 'Canceladas', ['Cancelada'], '#5b6168']
  ];
  const ESTADOS = ['En proyecto', 'En licitación', 'Adjudicada', 'En ejecución', 'Paralizada', 'Finalizada', 'Recepción definitiva', 'Cancelada'];
  const ROLES_GESTION = ['Secretario de Obras Públicas', 'Jefe de Servicios Públicos', 'Administrador del sistema'];
  const ROLES_VALIDAN = ['Secretario de Obras Públicas', 'Jefe de Servicios Públicos'];

  const N = window.GDO_NOTIF;
  const esMovil = () => window.matchMedia('(max-width: 760px)').matches;
  const sinMovimiento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const st = {
    rol: null, idUsuario: null, obras: [], resumen: null, contratistas: {}, usuarios: {}, inspectores: [],
    cat: {}, marcadores: {}, activa: null, ed: null, enApp: false, grupo: 'todas'
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
  const calles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imágenes © Esri' });
  L.control.layers({ 'Calles': calles, 'Satélite': satelite }, null, { position: 'topleft' }).addTo(mapa);
  calles.addTo(mapa);
  // En modo oscuro se oscurecen las teselas de OpenStreetMap con un filtro (no requiere clave de ningún proveedor)
  function aplicarTemaMapa() {
    const oscuro = window.GDO_TEMA && window.GDO_TEMA.actual() === 'dark';
    document.querySelector('.mapa-wrap').classList.toggle('calles-oscuro', oscuro && mapa.hasLayer(calles));
  }
  aplicarTemaMapa();
  document.addEventListener('tema', aplicarTemaMapa);
  mapa.on('baselayerchange', aplicarTemaMapa);
  const capa = L.layerGroup().addTo(mapa);
  let marcadorEdicion = null;

  function toast(msg, ms = 3500) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    t.classList.remove('entra'); void t.offsetWidth; t.classList.add('entra');
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  // Cuenta animada de un número ("$ 3.196,5 M", "36.290", "14") desde 0
  function contar(el, ms = 900) {
    const txt = el.textContent, m = /-?[\d.]+(,\d+)?/.exec(txt);
    if (!m || sinMovimiento()) return;
    const dec = m[1] ? m[1].length - 1 : 0;
    const fin = Number(m[0].replace(/\./g, '').replace(',', '.'));
    if (!isFinite(fin) || fin === 0) return;
    const pre = txt.slice(0, m.index), post = txt.slice(m.index + m[0].length), t0 = performance.now();
    const paso = (t) => {
      const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      el.textContent = pre + (fin * e).toLocaleString('es-AR', { minimumFractionDigits: p < 1 ? 0 : dec, maximumFractionDigits: dec }) + post;
      if (p < 1) requestAnimationFrame(paso); else el.textContent = txt;
    };
    requestAnimationFrame(paso);
  }

  // ---------- pantalla de inicio ----------
  function mostrarInicio() {
    st.enApp = false; $('app').hidden = true;
    const i = $('inicio'); i.hidden = false; i.classList.remove('sale'); void i.offsetWidth; i.classList.add('vuelve');
    window.scrollTo(0, 0); cifrasInicio();
  }
  function mostrarApp() {
    if (!st.enApp) {
      st.enApp = true;
      const i = $('inicio');
      const fin = () => { i.hidden = true; i.classList.remove('sale'); const a = $('app'); a.hidden = false; a.classList.remove('entra'); void a.offsetWidth; a.classList.add('entra'); mapa.invalidateSize(); };
      if (!i.hidden && !sinMovimiento()) { i.classList.add('sale'); setTimeout(fin, 320); } else fin();
    }
    setTimeout(() => mapa.invalidateSize(), 350);
  }
  // Cifras del inicio (públicas), con cuenta animada
  let cifrasCargadas = false;
  async function cifrasInicio() {
    if (cifrasCargadas) { document.querySelectorAll('#cifras b').forEach((b) => contar(b, 1200)); return; }
    const { data, error } = await sb.from('v_obras_publicas').select('presupuesto,beneficiarios');
    if (error || !data?.length) return;
    cifrasCargadas = true;
    $('ci-obras').textContent = data.length.toLocaleString('es-AR');
    $('ci-inv').textContent = millones(data.reduce((s, x) => s + Number(x.presupuesto || 0), 0));
    $('ci-benef').textContent = data.reduce((s, x) => s + Number(x.beneficiarios || 0), 0).toLocaleString('es-AR');
    $('cifras').hidden = false;
    document.querySelectorAll('#cifras b').forEach((b) => contar(b, 1400));
  }
  cifrasInicio();
  $('op-vecino').addEventListener('click', async () => { mostrarApp(); if (!st.obras.length || interno()) await cargar(); });
  $('op-funcionario').addEventListener('click', abrirLogin);
  $('btn-inicio').addEventListener('click', () => { if (!$('banner-recorrido').hidden) terminarRecorrido(); if (!interno()) { cerrarFicha(); mostrarInicio(); } });

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

  function pintarChips() {
    const cuenta = (g) => g[2] ? st.obras.filter((o) => g[2].includes(o.estado)).length : st.obras.length;
    $('chips-estado').innerHTML = GRUPOS.filter((g) => !g[2] || cuenta(g) > 0 || g[0] === st.grupo).map((g) =>
      `<button class="chip-est${st.grupo === g[0] ? ' on' : ''}" data-g="${g[0]}" aria-pressed="${st.grupo === g[0]}">
        ${g[3] ? `<span class="d" style="background:${g[3]}"></span>` : ''}${esc(g[1])} <span class="n">${cuenta(g)}</span></button>`).join('');
    $('chips-estado').querySelectorAll('.chip-est').forEach((b) => b.addEventListener('click', () => filtrarGrupo(b.dataset.g)));
  }
  function filtrarGrupo(g, extra = {}) {
    st.grupo = g; $('f-estado').value = '';
    $('f-semaforo').value = extra.semaforo || '';
    cerrarFicha(); aplicarFiltros();
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
      k.push(['Obras', r.obras_registradas, false, 'obras'], ['En ejecución', r.obras_en_ejecucion, false, 'ejecucion'],
        ['Semáforo rojo', r.obras_semaforo_rojo, r.obras_semaforo_rojo > 0, 'rojo'],
        ['Cartera', millones(r.presupuesto_total), false, 'cartera'], ['Medido aprobado', millones(r.monto_medido_aprobado), false, 'medido'],
        ['Pagado', millones(r.monto_pagado), false, 'pagado'],
        ['Mediciones a validar', r.mediciones_pendientes, r.mediciones_pendientes > 0, 'pendientes'],
        ['Certif. sin fotos', r.certificados_sin_fotos, r.certificados_sin_fotos > 0, 'sinfotos'],
        ['Fotos a revisar', r.fotos_a_revisar, r.fotos_a_revisar > 0, 'fotoslejos']);
    } else {
      const o = st.obras;
      const ejec = o.filter((x) => x.estado === 'En ejecución').length;
      const fin = o.filter((x) => ['Finalizada', 'Recepción definitiva'].includes(x.estado)).length;
      const inv = o.reduce((s, x) => s + Number(x.presupuesto || 0), 0);
      const benef = o.reduce((s, x) => s + Number(x.beneficiarios || 0), 0);
      k.push(['Obras publicadas', o.length, false, 'obras'], ['En ejecución', ejec, false, 'ejecucion'], ['Finalizadas', fin, false, 'finalizadas'],
        ['Inversión', millones(inv), false, 'cartera'], ['Vecinos beneficiados', benef.toLocaleString('es-AR'), false, 'benef']);
    }
    $('kpis').innerHTML = k.map(([e, v, alerta, clave]) =>
      `<button class="kpi${alerta ? ' alerta' : ''}" data-k="${clave}" title="Ver detalle"><div class="v">${esc(v)}</div><div class="e">${esc(e)}</div></button>`).join('');
    $('kpis').querySelectorAll('.kpi').forEach((b, k) => {
      b.addEventListener('click', () => detalleKpi(b.dataset.k));
      b.style.setProperty('--i', k);
      if (!st.kpisVistos) contar(b.querySelector('.v'));
    });
    st.kpisVistos = true;
  }

  // ---------- detalle de indicadores ----------
  function barrasH(pares, fmt = (v) => v) {
    const max = Math.max(1, ...pares.map((p) => p[1]));
    return `<div class="barras-h">${pares.map(([et, v, color]) => `<div class="bh"><span>${esc(et)}</span>
      <div class="trk"><div class="fill" style="width:${(v / max) * 100}%${color ? ';background:' + color : ''}"></div></div><span class="val">${fmt(v)}</span></div>`).join('')}</div>`;
  }
  function filasObras(lista, valor) {
    return `<ul class="filas-kpi">${lista.map((o) => `<li data-id="${esc(o.id_obra)}"><span class="punto" style="background:${colorObra(o)}"></span>
      <div><div class="t">${esc(o.nombre)}</div><div class="s">${esc(o.id_obra)} · ${esc(o.barrio || '')} · ${esc(o.estado)}</div></div>
      <span class="v">${valor(o)}</span></li>`).join('') || '<li class="estado-carga">Nada para mostrar.</li>'}</ul>`;
  }
  function agrupar(lista, clave, val) {
    const m = new Map(); for (const o of lista) { const k = o[clave] || '—'; m.set(k, (m.get(k) || 0) + val(o)); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }
  async function detalleKpi(k) {
    const O = st.obras, dlg = $('dlg-kpi');
    let tit = '', h = '', accion = null;
    const sumar = (l, c) => l.reduce((s, o) => s + Number(o[c] || 0), 0);
    switch (k) {
      case 'obras':
        tit = interno() ? 'Obras registradas' : 'Obras publicadas';
        h = `<p class="kpi-nota">${O.length} obras por estado y por tipo.</p>` +
          barrasH(GRUPOS.slice(1).map((g) => [g[1], O.filter((o) => g[2].includes(o.estado)).length, g[3]]).filter((x) => x[1] > 0)) +
          barrasH(agrupar(O, 'tipo_obra', () => 1));
        accion = ['Ver todas en el mapa', () => filtrarGrupo('todas')]; break;
      case 'ejecucion': {
        const l = O.filter((o) => o.estado === 'En ejecución').sort((a, b) => (a.avance_fisico || 0) - (b.avance_fisico || 0));
        tit = `Obras en ejecución (${l.length})`;
        h = `<p class="kpi-nota">Ordenadas de menor a mayor avance.</p>` + filasObras(l, (o) => pct(o.avance_fisico));
        accion = ['Ver en el mapa', () => filtrarGrupo('ejecucion')]; break; }
      case 'finalizadas': {
        const l = O.filter((o) => ['Finalizada', 'Recepción definitiva'].includes(o.estado));
        tit = `Obras finalizadas (${l.length})`; h = filasObras(l, (o) => millones(o.presupuesto));
        accion = ['Ver en el mapa', () => filtrarGrupo('finalizadas')]; break; }
      case 'rojo': {
        const l = O.filter((o) => o.semaforo === 'Rojo').sort((a, b) => (a.desvio ?? 0) - (b.desvio ?? 0));
        tit = `Obras con semáforo rojo (${l.length})`;
        h = `<p class="kpi-nota">Paralizadas o con más de 10 puntos de atraso respecto del plan. Desvío = avance real − previsto.</p>` +
          filasObras(l, (o) => o.estado === 'Paralizada' ? 'Paralizada' : (o.desvio != null ? pct(o.desvio) : '—'));
        accion = ['Ver en el mapa', () => filtrarGrupo('todas', { semaforo: 'Rojo' })]; break; }
      case 'cartera':
        tit = interno() ? 'Cartera de obras' : 'Inversión en obras';
        h = `<p class="kpi-nota">${millones(sumar(O, 'presupuesto'))} en total, por tipo de obra${interno() ? ', modalidad y fuente de financiamiento' : ''}.</p>` +
          barrasH(agrupar(O, 'tipo_obra', (o) => Number(o.presupuesto || 0)), millones) +
          (interno() ? barrasH(agrupar(O, 'modalidad', (o) => Number(o.presupuesto || 0)), millones) +
            barrasH(agrupar(O, 'fuente_financiamiento', (o) => Number(o.presupuesto || 0)), millones) : '');
        break;
      case 'medido': {
        const l = O.filter((o) => o.monto_medido_aprobado > 0).sort((a, b) => b.monto_medido_aprobado - a.monto_medido_aprobado);
        tit = 'Monto medido y aprobado';
        h = `<p class="kpi-nota">${millones(sumar(O, 'monto_medido_aprobado'))} de ${millones(sumar(O, 'presupuesto'))} de cartera (${pct(sumar(O, 'monto_medido_aprobado') / (sumar(O, 'presupuesto') || 1))}).</p>` +
          filasObras(l, (o) => `${millones(o.monto_medido_aprobado)} · ${pct(o.avance_fisico)}`); break; }
      case 'pagado': {
        const l = O.filter((o) => o.modalidad === 'Contrato' && o.presupuesto > 0).sort((a, b) => (b.monto_pagado || 0) - (a.monto_pagado || 0));
        tit = 'Pagado a contratistas';
        h = `<p class="kpi-nota">Certificados pagados por obra, con el avance financiero (pagado / presupuesto). Las obras por administración no certifican.</p>` +
          filasObras(l, (o) => `${millones(o.monto_pagado)} · ${pct(o.avance_financiero)}`); break; }
      case 'benef': {
        const l = O.filter((o) => o.beneficiarios > 0).sort((a, b) => b.beneficiarios - a.beneficiarios);
        tit = 'Vecinos beneficiados'; h = filasObras(l, (o) => Number(o.beneficiarios).toLocaleString('es-AR')); break; }
      case 'pendientes': case 'sinfotos': case 'fotoslejos': {
        tit = { pendientes: 'Mediciones a validar', sinfotos: 'Certificados sin respaldo fotográfico', fotoslejos: 'Fotos tomadas lejos de la obra' }[k];
        $('kpi-tit').textContent = tit; $('kpi-cuerpo').innerHTML = '<p class="estado-carga">Cargando…</p>'; $('kpi-acciones').innerHTML = '';
        if (!dlg.open) dlg.showModal();
        let r, fila;
        if (k === 'pendientes') {
          r = await sb.from('v_mediciones').select('id_medicion,id_obra,periodo,fecha,item_descripcion,unidad,cantidad_periodo,monto,inspector_id').eq('estado_validacion', 'Pendiente').order('fecha', { ascending: false });
          fila = (m) => [m.id_obra, `${m.item_descripcion}`, `${m.id_medicion} · ${m.periodo} · ${Number(m.cantidad_periodo).toLocaleString('es-AR')} ${m.unidad} · ${st.usuarios[m.inspector_id] || m.inspector_id}`, pesos(m.monto)];
        } else if (k === 'sinfotos') {
          r = await sb.from('v_certificados').select('id_certificado,id_obra,nro_certificado,periodo,estado,monto_neto').eq('control_respaldo', 'FALTAN FOTOS');
          fila = (c) => [c.id_obra, `Certificado N° ${c.nro_certificado} — ${c.periodo}`, `${c.id_certificado} · ${c.estado}`, millones(c.monto_neto)];
        } else {
          r = await sb.from('v_fotos').select('id_foto,id_obra,periodo,fecha_hora,distancia_obra_m,cargada_por').eq('control_ubicacion', 'REVISAR');
          fila = (f) => [f.id_obra, `Foto ${f.id_foto} — período ${f.periodo || '—'}`, `${new Date(f.fecha_hora).toLocaleString('es-AR')} · ${st.usuarios[f.cargada_por] || f.cargada_por || ''}`, `${Number(f.distancia_obra_m).toLocaleString('es-AR')} m`];
        }
        if (r.error) { $('kpi-cuerpo').innerHTML = `<p class="estado-carga">Error: ${esc(r.error.message)}</p>`; return; }
        const nombre = (id) => st.obras.find((o) => o.id_obra === id)?.nombre || id;
        h = `<p class="kpi-nota">${r.data.length} registro(s). Tocá uno para abrir la obra.</p><ul class="filas-kpi">` +
          r.data.map((x) => { const [id, t, sub, v] = fila(x); return `<li data-id="${esc(id)}"><span></span><div><div class="t">${esc(t)}</div><div class="s">${esc(nombre(id))} · ${esc(sub)}</div></div><span class="v">${esc(v)}</span></li>`; }).join('') + '</ul>';
        break; }
    }
    $('kpi-tit').textContent = tit; $('kpi-cuerpo').innerHTML = h;
    $('kpi-acciones').innerHTML = accion ? `<button class="btn-f lleno" id="kpi-accion">${esc(accion[0])}</button>` : '';
    if (accion) $('kpi-accion').addEventListener('click', () => { dlg.close(); accion[1](); });
    $('kpi-cuerpo').querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => { dlg.close(); abrirFicha(li.dataset.id, true); }));
    if (!dlg.open) dlg.showModal();
  }
  $('kpi-cerrar').addEventListener('click', () => $('dlg-kpi').close());
  $('dlg-kpi').addEventListener('click', (e) => { if (e.target === $('dlg-kpi')) $('dlg-kpi').close(); });

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
    const grp = GRUPOS.find((g) => g[0] === st.grupo)?.[2];
    const vis = st.obras.filter((o) =>
      (!grp || grp.includes(o.estado)) &&
      (!tipo || o.tipo_obra === tipo) && (!est || o.estado === est) && (!bar || o.barrio === bar) &&
      (!sem || o.semaforo === sem) &&
      (!t || [o.nombre, o.barrio, o.direccion, o.id_obra, o.descripcion].join(' ').toLowerCase().includes(t)));
    pintarChips(); pintarLista(vis); pintarMapa(vis); contarFiltros();
    st.visibles = vis;
  }
  ['f-texto', 'f-tipo', 'f-semaforo', 'f-barrio'].forEach((id) => $(id).addEventListener('input', aplicarFiltros));
  $('f-estado').addEventListener('input', () => { st.grupo = 'todas'; aplicarFiltros(); });

  // ---------- lista y mapa ----------
  function pintarLista(obras) {
    $('contador').textContent = `${obras.length} de ${st.obras.length} obras`;
    $('nav-n').textContent = obras.length;
    $('lista').innerHTML = obras.map((o, k) => `
      <li data-id="${esc(o.id_obra)}" class="${st.activa === o.id_obra ? 'activa' : ''}" style="--i:${Math.min(k, 15)}">
        <span class="punto" style="background:${colorObra(o)}"></span>
        <div><div class="t">${esc(o.nombre)}</div><div class="s">${esc(o.tipo_obra)} · ${esc(o.barrio || '')} · ${esc(o.estado)}</div></div>
        <span class="p">${pct(o.avance_fisico)}</span>
      </li>`).join('') || '<li class="estado-carga">Ninguna obra coincide con los filtros.</li>';
    $('lista').querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => { verVista('mapa'); abrirFicha(li.dataset.id, true); }));
  }

  function pintarMapa(obras) {
    capa.clearLayers(); st.marcadores = {};
    const pts = [];
    for (const o of obras) {
      if (o.lat == null || o.lng == null) continue;
      const alerta = o.estado === 'Paralizada' || (interno() && o.semaforo === 'Rojo');
      if (alerta) L.circleMarker([o.lat, o.lng], { radius: 10, color: colorObra(o), weight: 2, fill: false, interactive: false, className: 'anillo' }).addTo(capa);
      const m = L.circleMarker([o.lat, o.lng], { radius: 9, color: '#fff', weight: 2, fillColor: colorObra(o), fillOpacity: 0.95, className: 'marcador' })
        .bindTooltip(`<strong>${esc(o.nombre)}</strong><br>${esc(o.estado)} · ${pct(o.avance_fisico)}`, { direction: 'top', offset: [0, -8] });
      m.on('click', () => { if (!st.eligiendo) abrirFicha(o.id_obra, false); });
      m.addTo(capa); st.marcadores[o.id_obra] = m; pts.push([o.lat, o.lng]);
      const el = m.getElement(); if (el) el.style.animationDelay = `${Math.min(pts.length, 25) * 35}ms`;
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

    let html = `<div class="manija" aria-hidden="true"></div><button class="cerrar" aria-label="Cerrar">×</button>
      <div class="cod">${esc(o.id_obra)}${interno() && o.expediente ? ' · ' + esc(o.expediente) : ''}</div>
      <h2>${esc(o.nombre)}</h2>
      <div class="chips">${chips}</div>
      <div class="acciones-ficha">
        ${puedeGestionar() ? '<button class="btn-f" id="btn-editar">✎ Editar obra</button><button class="btn-f" id="btn-cartel" title="Cartel de obra imprimible con código QR">▦ Cartel con QR</button>' : ''}
        <button class="btn-f" id="btn-compartir" title="Compartir el enlace público de esta obra">↗ Compartir</button>
      </div>
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
    const yaAbierta = !f.hidden;
    f.innerHTML = html; f.hidden = false; f.classList.remove('oculta'); f.scrollTop = 0;
    if (!yaAbierta) { f.classList.remove('abre'); void f.offsetWidth; f.classList.add('abre'); }
    f.querySelector('.cerrar').addEventListener('click', cerrarFicha);
    if (puedeGestionar()) {
      $('btn-editar').addEventListener('click', () => abrirEditor(o));
      $('btn-cartel').addEventListener('click', () => cartelQR(o));
    }
    $('btn-compartir').addEventListener('click', () => compartir(o));
    if (location.hash !== '#obra=' + id) history.replaceState(null, '', '#obra=' + id);
    if (interno()) cargarDetalle(o);
  }

  const ESTADOS_MED = ['Aprobada', 'Observada', 'Rechazada', 'Pendiente'];
  const COLOR_MED = { Aprobada: 'var(--verde)', Observada: 'var(--rojo)', Rechazada: 'var(--rojo)', Pendiente: 'var(--amarillo)' };

  async function cargarDetalle(o) {
    const [it, ce, me, fo] = await Promise.all([
      sb.from('v_items').select('id_item,nro_item,rubro,descripcion,unidad,cantidad,precio_unitario,subtotal,incidencia,avance_item').eq('id_obra', o.id_obra).order('nro_item'),
      o.modalidad === 'Contrato'
        ? sb.from('v_certificados').select('nro_certificado,periodo,estado,monto_bruto,monto_neto,control_respaldo').eq('id_obra', o.id_obra).order('nro_certificado')
        : Promise.resolve({ data: [] }),
      sb.from('v_mediciones').select('id_medicion,periodo,fecha,item_descripcion,unidad,cantidad_periodo,monto,inspector_id,observaciones,estado_validacion,validado_por,creado_en')
        .eq('id_obra', o.id_obra).order('fecha', { ascending: false }).order('creado_en', { ascending: false }).limit(60),
      sb.from('v_fotos').select('id_foto,id_medicion,archivo,fecha_hora,distancia_obra_m,control_ubicacion,lat,lng')
        .eq('id_obra', o.id_obra).order('fecha_hora', { ascending: false }).limit(40)
    ]);
    const cont = $('ficha-detalle');
    if (!cont || st.activa !== o.id_obra) return;
    const err = it.error || ce.error || me.error || fo.error;
    if (err) { cont.innerHTML = `<p class="estado-carga">Error: ${esc(err.message)}</p>`; return; }
    o.items = it.data; o.certs = ce.data; o.meds = me.data;

    // Fotos con archivo real en el almacenamiento (las del Excel de ejemplo no tienen archivo)
    let fotos = [];
    if (fo.data.length) {
      const r = await sb.storage.from('fotos').createSignedUrls(fo.data.map((f) => f.archivo), 3600);
      const urls = Object.fromEntries((r.data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
      fotos = fo.data.filter((f) => urls[f.archivo]).map((f) => ({ ...f, url: urls[f.archivo] }));
    }
    if (!$('ficha-detalle') || st.activa !== o.id_obra) return;
    st.fotosFicha = fotos;
    const fotosDe = (idMed) => fotos.filter((f) => f.id_medicion === idMed);
    const mini = (f) => `<button type="button" class="mini${f.control_ubicacion === 'REVISAR' ? ' revisar' : ''}" data-foto="${esc(f.id_foto)}"
        title="${esc(new Date(f.fecha_hora).toLocaleString('es-AR'))}${f.distancia_obra_m != null ? ' · a ' + f.distancia_obra_m + ' m de la obra' : ' · sin GPS'}">
        <img src="${f.url}" alt="Foto ${esc(f.id_foto)}" loading="lazy">${f.control_ubicacion === 'REVISAR' ? '<span>lejos</span>' : ''}</button>`;
    const quien = (id) => esc(st.usuarios[id] || id || '—');
    const bloqueada = (m) => { const c = ce.data.find((x) => x.periodo === m.periodo && ['Liquidado', 'Pagado'].includes(x.estado)); return c ? c.estado : null; };

    const pend = me.data.filter((m) => m.estado_validacion === 'Pendiente');
    const decididas = me.data.filter((m) => m.estado_validacion !== 'Pendiente').slice(0, 8);
    let h = '';
    if (pend.length) {
      h += `<h3>Mediciones a validar (${pend.length})</h3>` + pend.map((m, k) => `
        <div class="pend" data-med="${esc(m.id_medicion)}" style="--i:${k}">
          <div class="pend-cab"><strong>${esc(m.item_descripcion)}</strong><span class="num">${pesos(m.monto)}</span></div>
          <div class="pend-sub">${esc(m.id_medicion)} · ${esc(m.periodo)} · ${fecha(m.fecha)} · <span class="num">${Number(m.cantidad_periodo).toLocaleString('es-AR')} ${esc(m.unidad)}</span> · ${quien(m.inspector_id)}</div>
          ${m.observaciones ? `<div class="pend-sub">“${esc(m.observaciones)}”</div>` : ''}
          ${fotosDe(m.id_medicion).length ? `<div class="minis">${fotosDe(m.id_medicion).map(mini).join('')}</div>` : '<div class="pend-sub" style="color:var(--rojo)">Sin foto cargada</div>'}
          ${puedeValidar() ? `<div class="pend-acc"><button class="btn-v ok" data-acc="Aprobada">✓ Aprobar</button><button class="btn-v obs" data-acc="Observada">✎ Observar</button></div>` : ''}
        </div>`).join('');
    }
    if (decididas.length) {
      h += `<h3><span>Últimas decisiones</span>${puedeValidar() ? '<small class="ayuda">Se pueden revisar y cambiar</small>' : ''}</h3><ul class="decisiones">` + decididas.map((m) => {
        const lock = bloqueada(m);
        return `<li data-med="${esc(m.id_medicion)}">
          <span class="dec-punto" style="background:${COLOR_MED[m.estado_validacion]}"></span>
          <div class="dec-txt"><div><strong>${esc(m.item_descripcion)}</strong></div>
            <div class="pend-sub">${esc(m.id_medicion)} · ${esc(m.periodo)} · <span class="num">${Number(m.cantidad_periodo).toLocaleString('es-AR')} ${esc(m.unidad)}</span> · <b style="color:${COLOR_MED[m.estado_validacion]}">${esc(m.estado_validacion)}</b>${m.validado_por ? ' por ' + quien(m.validado_por) : ''}</div>
            ${m.observaciones && m.estado_validacion !== 'Aprobada' ? `<div class="pend-sub">“${esc(m.observaciones)}”</div>` : ''}
            ${fotosDe(m.id_medicion).length ? `<div class="minis">${fotosDe(m.id_medicion).map(mini).join('')}</div>` : ''}</div>
          ${puedeValidar() ? (lock ? `<span class="candado" title="El certificado de ${esc(m.periodo)} ya está ${lock}: no se puede cambiar">🔒 ${esc(lock)}</span>`
            : '<button class="btn-f chico" data-cambiar>Cambiar</button>') : ''}
        </li>`; }).join('') + '</ul>';
    }
    const gest = puedeGestionar();
    h += `<h3><span>Ítems (${it.data.length})</span>${gest ? '<button class="btn-f" id="btn-item-nuevo">＋ Ítem</button>' : ''}</h3>
      <div id="item-form-slot"></div>
      <table class="t"><thead><tr><th>#</th><th>Ítem</th><th class="n">Incid.</th><th class="n">Avance</th>${gest ? '<th></th>' : ''}</tr></thead><tbody>` +
      it.data.map((i) => `<tr data-item="${esc(i.id_item)}"><td>${i.nro_item}</td><td>${esc(i.descripcion)}<br><small>${Number(i.cantidad).toLocaleString('es-AR')} ${esc(i.unidad)} × ${pesos(i.precio_unitario)}</small>
        <div class="mini-trk"><div style="--w:${Math.min(100, (i.avance_item || 0) * 100)}%"></div></div></td>
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
      (fotos.length ? `<div class="minis grande">${fotos.map(mini).join('')}</div><p class="ayuda">Tocá una foto para ver sus datos de captura (GPS, hora, equipo).</p>`
        : '<p class="estado-carga">Las fotos de los datos de ejemplo no tienen imagen. Las que cargue el inspector desde la app aparecen acá.</p>');
    cont.innerHTML = h;

    cont.querySelectorAll('.pend-acc button').forEach((b) => b.addEventListener('click', () =>
      validar(o, b.closest('.pend').dataset.med, b.dataset.acc, b)));
    cont.querySelectorAll('[data-cambiar]').forEach((b) => b.addEventListener('click', () =>
      dialogoDecision(o, o.meds.find((m) => m.id_medicion === b.closest('li').dataset.med))));
    cont.querySelectorAll('[data-foto]').forEach((b) => b.addEventListener('click', () => verFoto(o, b.dataset.foto)));
    if (gest) {
      $('btn-item-nuevo').addEventListener('click', () => formItem(o, null));
      cont.querySelectorAll('[data-ed-item]').forEach((b) => b.addEventListener('click', () =>
        formItem(o, o.items.find((i) => i.id_item === b.closest('tr').dataset.item))));
      cont.querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', () =>
        borrarItem(o, o.items.find((i) => i.id_item === b.closest('tr').dataset.item))));
    }
  }

  async function refrescar(id) { await cargar(); if (id) abrirFicha(id, false); }

  async function guardarDecision(idMed, estado, motivo) {
    const cambios = { estado_validacion: estado, validado_por: estado === 'Pendiente' ? null : st.idUsuario };
    if (motivo) cambios.observaciones = motivo;
    const { data, error } = await sb.from('mediciones').update(cambios).eq('id_medicion', idMed).select('id_medicion');
    if (error) return error.message.replace(/^.*?No se puede/, 'No se puede');
    if (!data.length) return 'La base no permitió el cambio (revisá tu rol o actualizá la base con el script 05).';
    return null;
  }

  async function validar(o, idMed, estado, btn) {
    let obs = null;
    if (estado === 'Observada') {
      obs = prompt('Motivo de la observación (lo ve el inspector):');
      if (obs === null) return;
    }
    const botones = btn.closest('.pend-acc').querySelectorAll('button');
    botones.forEach((x) => { x.disabled = true; });
    const card = btn.closest('.pend');
    const error = await guardarDecision(idMed, estado, obs);
    if (error) { alert('No se pudo guardar: ' + error); botones.forEach((x) => { x.disabled = false; }); return; }
    card.classList.add(estado === 'Aprobada' ? 'sale-ok' : 'sale-obs');
    toast(estado === 'Aprobada' ? `✓ ${idMed} aprobada` : `${idMed} observada: el inspector recibe el aviso`);
    setTimeout(() => refrescar(o.id_obra), 420);
  }

  // ---------- cambiar una decisión ya tomada ----------
  async function dialogoDecision(o, m) {
    const d = $('dlg-decision');
    $('dec-tit').textContent = `Cambiar decisión — ${m.id_medicion}`;
    const opciones = ESTADOS_MED.filter((e) => e !== m.estado_validacion);
    $('dec-cuerpo').innerHTML = `
      <p class="kpi-nota"><strong>${esc(m.item_descripcion)}</strong> · ${esc(m.periodo)} · ${Number(m.cantidad_periodo).toLocaleString('es-AR')} ${esc(m.unidad)} (${pesos(m.monto)})<br>
        Estado actual: <b style="color:${COLOR_MED[m.estado_validacion]}">${esc(m.estado_validacion)}</b>${m.validado_por ? ' por ' + esc(st.usuarios[m.validado_por] || m.validado_por) : ''}.</p>
      <div class="dec-opciones">${opciones.map((e, k) => `<label class="dec-op"><input type="radio" name="dec-estado" value="${e}" ${k === 0 ? 'checked' : ''}>
        <span style="--c:${COLOR_MED[e]}">${{ Aprobada: '✓ Aprobar', Observada: '✎ Observar', Rechazada: '✕ Rechazar', Pendiente: '↺ Volver a pendiente' }[e]}</span></label>`).join('')}</div>
      <label class="dec-motivo">Motivo del cambio <small>(lo ve el inspector; obligatorio para observar o rechazar)</small>
        <textarea id="dec-motivo" rows="2" placeholder="Ej.: se revisaron las fotos de detalle, la medición es correcta"></textarea></label>
      <p class="error" id="dec-error"></p>
      <div class="historial" id="dec-historial"><p class="ayuda">Cargando historial…</p></div>`;
    $('dec-acciones').innerHTML = '<button class="btn-f" id="dec-cancelar">Cancelar</button><button class="btn-f lleno" id="dec-guardar">Guardar cambio</button>';
    $('dec-cancelar').addEventListener('click', () => d.close());
    $('dec-guardar').addEventListener('click', async () => {
      const estado = d.querySelector('[name=dec-estado]:checked').value;
      const motivo = $('dec-motivo').value.trim();
      if (['Observada', 'Rechazada'].includes(estado) && !motivo) { $('dec-error').textContent = 'Escribí el motivo para el inspector.'; return; }
      $('dec-guardar').disabled = true; $('dec-guardar').textContent = 'Guardando…';
      const error = await guardarDecision(m.id_medicion, estado, motivo || null);
      if (error) { $('dec-error').textContent = error; $('dec-guardar').disabled = false; $('dec-guardar').textContent = 'Guardar cambio'; return; }
      d.close(); toast(`Decisión de ${m.id_medicion} cambiada a ${estado}`);
      await refrescar(o.id_obra);
    });
    if (!d.open) d.showModal();
    const r = await sb.from('mediciones_historial').select('estado_anterior,estado_nuevo,actor,observacion,creado_en').eq('id_medicion', m.id_medicion).order('creado_en');
    const hEl = $('dec-historial'); if (!hEl) return;
    if (r.error) { hEl.innerHTML = '<p class="ayuda">El historial se activa al actualizar la base (script 05).</p>'; return; }
    hEl.innerHTML = '<h4>Historial</h4><ol class="linea-tiempo">' + r.data.map((x) => `<li style="--c:${COLOR_MED[x.estado_nuevo] || 'var(--gris)'}">
        <b>${esc(x.estado_anterior ? x.estado_anterior + ' → ' : '')}${esc(x.estado_nuevo)}</b> · ${esc(st.usuarios[x.actor] || x.actor || '—')}
        <span>${new Date(x.creado_en).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</span>
        ${x.observacion ? `<em>${esc(x.observacion)}</em>` : ''}</li>`).join('') + '</ol>';
  }

  // ---------- visor de foto con metadatos ----------
  let mapaFoto = null;
  async function verFoto(o, idFoto) {
    const f = (st.fotosFicha || []).find((x) => x.id_foto === idFoto); if (!f) return;
    const d = $('dlg-foto');
    $('foto-img').src = f.url; $('foto-abrir').href = f.url;
    $('foto-tit').textContent = `Foto ${f.id_foto}${f.id_medicion ? ' · ' + f.id_medicion : ''}`;
    $('foto-datos').innerHTML = '<p class="ayuda">Cargando datos de captura…</p>';
    if (!d.open) d.showModal();
    // mapa chico: punto de la obra vs. punto de la foto
    setTimeout(() => {
      if (!mapaFoto) {
        mapaFoto = L.map('foto-mapa', { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mapaFoto);
        mapaFoto.capa = L.layerGroup().addTo(mapaFoto);
      }
      mapaFoto.invalidateSize(); mapaFoto.capa.clearLayers();
      const pts = [];
      if (o.lat != null) { L.circleMarker([o.lat, o.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#1f4e79', fillOpacity: 1 }).bindTooltip('Obra', { permanent: true, direction: 'top', offset: [0, -6] }).addTo(mapaFoto.capa); pts.push([o.lat, o.lng]); }
      if (f.lat != null) { L.circleMarker([f.lat, f.lng], { radius: 7, color: '#fff', weight: 2, fillColor: f.control_ubicacion === 'REVISAR' ? '#c0392b' : '#f2b705', fillOpacity: 1 }).bindTooltip('Foto', { permanent: true, direction: 'bottom', offset: [0, 6] }).addTo(mapaFoto.capa); pts.push([f.lat, f.lng]); }
      if (pts.length === 2) L.polyline(pts, { color: '#f2b705', dashArray: '5 5', weight: 2 }).addTo(mapaFoto.capa);
      $('foto-mapa').hidden = !pts.length;
      if (pts.length === 2) mapaFoto.fitBounds(pts, { padding: [30, 30], maxZoom: 17 }); else if (pts.length) mapaFoto.setView(pts[0], 16);
    }, 60);
    const r = await sb.from('fotos').select('metadatos').eq('id_foto', idFoto).maybeSingle();
    const md = r.error ? null : r.data?.metadatos;
    const fila = (k, v) => v == null || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>`;
    const kb = (b) => b ? (b / 1024).toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' KB' : null;
    let h = '<dl class="meta">';
    h += fila('Tomada', md?.captura ? `${esc(md.captura.local)} <small>(${esc(md.captura.utc)}, ${esc(md.captura.zona_horaria || '')})</small>` : esc(new Date(f.fecha_hora).toLocaleString('es-AR')));
    if (md?.gps) h += fila('GPS', `<a href="https://www.openstreetmap.org/?mlat=${md.gps.lat}&mlon=${md.gps.lng}#map=18/${md.gps.lat}/${md.gps.lng}" target="_blank" rel="noopener">${md.gps.lat.toFixed(6)}, ${md.gps.lng.toFixed(6)}</a>${md.gps.precision_m != null ? ' ±' + md.gps.precision_m + ' m' : ''} <small>(${esc(md.gps.fuente || '')})</small>`)
      + fila('Altitud', md.gps.altitud_m != null ? md.gps.altitud_m + ' m' : null);
    else if (f.lat != null) h += fila('GPS', `${Number(f.lat).toFixed(6)}, ${Number(f.lng).toFixed(6)}`);
    else h += fila('GPS', '<span style="color:var(--rojo)">Sin ubicación</span>');
    h += fila('Distancia a la obra', f.distancia_obra_m != null ? `${Number(f.distancia_obra_m).toLocaleString('es-AR')} m ${f.control_ubicacion === 'REVISAR' ? '<b style="color:var(--rojo)">· REVISAR</b>' : '<b style="color:var(--verde)">· OK</b>'}` : null);
    if (md) {
      const dsp = md.dispositivo || {}, ex = md.exif || {}, ar = md.archivo_original || {}, ctl = md.controles || {};
      h += fila('Inspector', esc(md.inspector?.nombre))
        + fila('Ítem', md.item ? `${md.item.nro_item}. ${esc(md.item.descripcion)}` : null)
        + fila('Equipo', esc(dsp.equipo || [ex.marca, ex.modelo].filter(Boolean).join(' ') || null))
        + fila('Sistema', esc([dsp.plataforma, dsp.version_so].filter(Boolean).join(' ') || null))
        + fila('Navegador', esc(dsp.navegador)) + fila('Red', esc(dsp.red)) + fila('Pantalla', esc(dsp.pantalla))
        + fila('Fecha de la cámara', ex.fecha_toma ? esc(ex.fecha_toma.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$3/$2/$1')) + (ctl.foto_reciente === false ? ' <b style="color:var(--rojo)">· no es reciente</b>' : '') : null)
        + fila('GPS cámara vs. celular', ctl.gps_camara_vs_navegador_m != null ? ctl.gps_camara_vs_navegador_m + ' m de diferencia' : null)
        + fila('Cámara', [ex.iso && 'ISO ' + ex.iso, ex.exposicion && ex.exposicion + ' s', ex.apertura && 'f/' + Number(ex.apertura).toFixed(1)].filter(Boolean).join(' · ') || null)
        + fila('Archivo original', ar.nombre ? `${esc(ar.nombre)} · ${ar.ancho}×${ar.alto} · ${kb(ar.tamano_bytes)}` : null)
        + fila('Huella SHA-256', ar.sha256 ? `<code title="${esc(ar.sha256)}">${esc(ar.sha256.slice(0, 16))}…</code>` : null)
        + fila('Versión de la app', esc(md.version));
    }
    h += '</dl>';
    if (!md) h += `<p class="ayuda">${r.error ? 'Los datos completos de captura se guardan al actualizar la base (script 05).' : 'Esta foto se cargó antes de que existieran los metadatos.'}</p>`;
    $('foto-datos').innerHTML = h;
  }
  $('foto-cerrar').addEventListener('click', () => $('dlg-foto').close());
  $('dlg-foto').addEventListener('click', (e) => { if (e.target === $('dlg-foto')) $('dlg-foto').close(); });
  $('dlg-decision').addEventListener('click', (e) => { if (e.target === $('dlg-decision')) $('dlg-decision').close(); });

  function cerrarFicha() {
    terminarEleccion(false); quitarMarcadorEdicion(); st.ed = null;
    $('ficha').hidden = true; st.activa = null;
    if (location.hash.startsWith('#obra=')) history.replaceState(null, '', location.pathname + location.search);
    document.querySelectorAll('.lista li.activa').forEach((li) => li.classList.remove('activa'));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (st.eligiendo) terminarEleccion(false); else cerrarFicha(); } });

  // ---------- enlace público, compartir y cartel con QR ----------
  const urlObra = (id) => `${location.origin}${location.pathname}#obra=${id}`;

  async function compartir(o) {
    const url = urlObra(o.id_obra);
    const texto = `${o.nombre} — ${o.estado}, ${pct(o.avance_fisico)} de avance. Seguila en el mapa de obras de ${cfg.municipio}:`;
    if (!o.visible_publico && interno()) toast('Ojo: esta obra no está publicada, los vecinos no la van a ver.', 4500);
    if (navigator.share) {
      try { await navigator.share({ title: o.nombre, text: texto, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(texto + ' ' + url), '_blank', 'noopener');
  }

  function cartelQR(o) {
    if (typeof qrcode === 'undefined') { toast('No se pudo cargar el generador de QR. Revisá la conexión.'); return; }
    if (!o.visible_publico) toast('La obra no está publicada: el QR va a abrir el visor, pero sin esta obra. Publicala desde "Editar obra".', 6000);
    const url = urlObra(o.id_obra);
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const svgQR = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    const base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
    const empresa = st.contratistas[o.contratista_id] || (o.modalidad === 'Administración' ? 'Por administración municipal' : 'A adjudicar');
    const dato = (k, v) => v ? `<div class="d"><span>${k}</span><strong>${esc(v)}</strong></div>` : '';
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cartel ${esc(o.id_obra)}</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
      <style>
        @page { size: A4 landscape; margin: 0; }
        * { box-sizing: border-box; } body { margin: 0; font-family: 'IBM Plex Sans', system-ui, sans-serif; color: #12202e; background: #ddd; }
        .hoja { width: 297mm; height: 210mm; margin: 0 auto; background: #fff; display: grid; grid-template-rows: auto 1fr auto; }
        .cab { background: #1f4e79; color: #fff; padding: 12mm 16mm 9mm; display: flex; justify-content: space-between; align-items: flex-end; }
        .cab .m { font-size: 13pt; letter-spacing: .12em; text-transform: uppercase; opacity: .9; }
        .cab .a { font-size: 11pt; opacity: .8; margin-top: 2mm; }
        .cab .cod { font-size: 12pt; opacity: .85; }
        .franja { height: 4mm; background: repeating-linear-gradient(-45deg, #f2b705 0 8mm, #1d2126 8mm 16mm); }
        .cuerpo { padding: 10mm 16mm; display: grid; grid-template-columns: 1fr 64mm; gap: 12mm; }
        h1 { font-size: 30pt; line-height: 1.1; margin: 0 0 4mm; }
        .desc { font-size: 14pt; color: #3c4a58; margin: 0 0 8mm; }
        .datos { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm 10mm; }
        .d span { display: block; font-size: 10pt; text-transform: uppercase; letter-spacing: .08em; color: #5b6a78; }
        .d strong { font-size: 16pt; }
        .qr { border: 2px solid #1f4e79; border-radius: 4mm; padding: 5mm; text-align: center; align-self: start; }
        .qr svg { width: 100%; height: auto; display: block; }
        .qr p { margin: 4mm 0 0; font-size: 13pt; font-weight: 700; color: #1f4e79; line-height: 1.2; }
        .qr small { display: block; font-size: 8.5pt; color: #5b6a78; margin-top: 2mm; word-break: break-all; }
        .pie { padding: 0 16mm 8mm; display: flex; justify-content: space-between; align-items: center; font-size: 9pt; color: #5b6a78; }
        .pie img { height: 9mm; }
        .no-print { position: fixed; top: 10px; right: 10px; } .no-print button { font: inherit; padding: 8px 14px; cursor: pointer; }
        @media print { body { background: #fff; } .no-print { display: none; } }
      </style></head><body>
      <div class="no-print"><button onclick="print()">Imprimir / guardar PDF</button></div>
      <div class="hoja">
        <div><div class="cab"><div><div class="m">${esc(cfg.municipio)}</div><div class="a">${esc(o.area_responsable || 'Obras Públicas')}</div></div><div class="cod">Obra ${esc(o.id_obra)}${o.expediente ? ' · Expte. ' + esc(o.expediente) : ''}</div></div><div class="franja"></div></div>
        <div class="cuerpo">
          <div>
            <h1>${esc(o.nombre)}</h1>
            <p class="desc">${esc(o.descripcion || '')}</p>
            <div class="datos">
              ${dato('Monto', o.presupuesto ? pesos(o.presupuesto) : '')}
              ${dato('Empresa', empresa)}
              ${dato('Plazo', o.plazo_dias ? o.plazo_dias + ' días' : '')}
              ${dato('Inicio', o.fecha_inicio ? fecha(o.fecha_inicio) : '')}
              ${dato('Fin previsto', o.fecha_fin_prevista ? fecha(o.fecha_fin_prevista) : '')}
              ${dato('Financiamiento', o.fuente_financiamiento)}
              ${dato('Beneficiarios', o.beneficiarios ? Number(o.beneficiarios).toLocaleString('es-AR') + ' vecinos' : '')}
              ${dato('Ubicación', [o.barrio, o.direccion].filter(Boolean).join(' — '))}
            </div>
          </div>
          <div class="qr">${svgQR}<p>Escaneá y seguí el avance de esta obra</p><small>${esc(url)}</small></div>
        </div>
        <div class="pie"><span>Información actualizada en tiempo real desde el sistema de seguimiento de obras.</span>
          <span style="display:flex;align-items:center;gap:3mm">Desarrollado por <img src="${base}img/hydrogis.png" alt="HydroGIS"></span></div>
      </div></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast('El navegador bloqueó la ventana. Permití ventanas emergentes para este sitio.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  // ---------- recorrido (modo presentación) ----------
  const rec = { lista: [], i: 0, timer: null, pausa: false };
  function iniciarRecorrido() {
    rec.lista = (st.visibles || st.obras).filter((o) => o.lat != null);
    if (!rec.lista.length) { toast('No hay obras para recorrer con los filtros actuales.'); return; }
    rec.i = -1; rec.pausa = false; $('rec-pausa').textContent = '❚❚';
    $('btn-recorrido').hidden = true; $('banner-recorrido').hidden = false;
    pasoRecorrido();
  }
  function pasoRecorrido() {
    clearTimeout(rec.timer);
    rec.i = (rec.i + 1) % rec.lista.length;
    const o = rec.lista[rec.i];
    $('rec-txt').textContent = `${rec.i + 1}/${rec.lista.length} · ${o.nombre}`;
    mapa.flyTo([o.lat, o.lng], 16, { duration: 1.6 });
    setTimeout(() => { if (!$('banner-recorrido').hidden) abrirFicha(o.id_obra, false); }, 1700);
    if (!rec.pausa) rec.timer = setTimeout(pasoRecorrido, 8000);
  }
  function terminarRecorrido() {
    clearTimeout(rec.timer); $('banner-recorrido').hidden = true; $('btn-recorrido').hidden = false;
    cerrarFicha(); aplicarFiltros();
  }
  $('btn-recorrido').addEventListener('click', iniciarRecorrido);
  $('rec-sig').addEventListener('click', pasoRecorrido);
  $('rec-fin').addEventListener('click', terminarRecorrido);
  $('rec-pausa').addEventListener('click', () => {
    rec.pausa = !rec.pausa; $('rec-pausa').textContent = rec.pausa ? '▶' : '❚❚';
    clearTimeout(rec.timer); if (!rec.pausa) rec.timer = setTimeout(pasoRecorrido, 4000);
  });

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

  // ---------- celular: Mapa / Lista, filtros plegables, ficha deslizable ----------
  function verVista(v) {
    document.body.classList.toggle('ver-lista', v === 'lista');
    $('nav-movil').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.vista === v));
    if (v === 'mapa') setTimeout(() => mapa.invalidateSize(), 260);
  }
  $('nav-movil').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.vista;
    if (v === 'nueva') { verVista('mapa'); abrirEditor(null); return; }
    if (v === 'recorrido') { verVista('mapa'); if ($('banner-recorrido').hidden) iniciarRecorrido(); else terminarRecorrido(); return; }
    verVista(v);
  });
  function contarFiltros() {
    const n = ['f-tipo', 'f-estado', 'f-semaforo', 'f-barrio'].filter((id) => $(id).value).length;
    $('n-filtros').textContent = n || '';
    $('btn-filtros').classList.toggle('activos', n > 0);
  }
  $('btn-filtros').addEventListener('click', () => {
    const abierto = $('filtros-mas').classList.toggle('abierto');
    $('btn-filtros').setAttribute('aria-expanded', abierto);
  });
  ['f-tipo', 'f-estado', 'f-semaforo', 'f-barrio'].forEach((id) => $(id).addEventListener('input', contarFiltros));
  $('leyenda').addEventListener('click', () => { if (esMovil()) $('leyenda').classList.toggle('abierta'); });

  // Deslizar la ficha hacia abajo para cerrarla (celular)
  (() => {
    const f = $('ficha'); let y0 = null, dy = 0;
    f.addEventListener('touchstart', (e) => {
      if (!esMovil() || f.scrollTop > 0 || !e.target.closest('.manija, h2, .cod, .chips')) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0; f.style.transition = 'none';
    }, { passive: true });
    f.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0); f.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    f.addEventListener('touchend', () => {
      if (y0 == null) return;
      f.style.transition = ''; f.style.transform = '';
      if (dy > 90) cerrarFicha();
      y0 = null;
    });
  })();

  // ---------- notificaciones (campana) ----------
  N.escuchar(({ noLeidas, nuevas, disponible }) => {
    const b = $('notif-badge');
    b.textContent = noLeidas > 9 ? '9+' : noLeidas; b.hidden = !noLeidas;
    $('btn-notif').hidden = !interno() || !disponible;
    $('pn-todas').hidden = !noLeidas;
    if (!$('panel-notif').hidden) pintarPanelNotif();
    if (nuevas.length) {
      toast(`🔔 ${nuevas[0].titulo}${nuevas.length > 1 ? ` (+${nuevas.length - 1} más)` : ''}`, 5000);
      $('btn-notif').classList.add('timbre'); setTimeout(() => $('btn-notif').classList.remove('timbre'), 900);
      // hay novedades: se actualizan datos e indicadores
      const abierta = st.activa; cargar().then(() => { if (abierta && !st.ed) abrirFicha(abierta, false); });
    }
  });
  function pintarPanelNotif() {
    $('pn-lista').innerHTML = N.lista();
    $('pn-lista').querySelectorAll('.notif').forEach((li) => li.addEventListener('click', () => {
      N.marcar([Number(li.dataset.id)]);
      $('panel-notif').hidden = true;
      if (li.dataset.obra && st.obras.some((o) => o.id_obra === li.dataset.obra)) { verVista('mapa'); abrirFicha(li.dataset.obra, true); }
    }));
  }
  $('btn-notif').addEventListener('click', (e) => {
    e.stopPropagation();
    const p = $('panel-notif'); p.hidden = !p.hidden;
    if (!p.hidden) { pintarPanelNotif(); N.cargar(); }
  });
  $('pn-todas').addEventListener('click', (e) => { e.stopPropagation(); N.marcarTodas(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.notif-wrap')) $('panel-notif').hidden = true; });

  // ---------- sesión ----------
  async function actualizarSesion(session) {
    const enlace = (location.hash.match(/^#obra=([\w-]+)/) || [])[1];   // antes de cerrar fichas, que limpian el enlace
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
    $('nav-nueva').hidden = !puedeGestionar();
    $('panel-notif').hidden = true;
    if (interno()) N.iniciar(sb, st.idUsuario); else N.detener();
    st.kpisVistos = false;
    cerrarFicha();
    if (puedeGestionar()) await cargarCatalogos();
    if (session || enlace) mostrarApp();
    if (session || st.enApp) await cargar();
    if (!session && !st.enApp) mostrarInicio();
    if (enlace) {
      if (st.obras.some((o) => o.id_obra === enlace)) abrirFicha(enlace, true);
      else toast(`La obra ${enlace} no está publicada o no existe.`, 5000);
    }
  }
  window.addEventListener('hashchange', () => {
    const id = (location.hash.match(/^#obra=([\w-]+)/) || [])[1];
    if (!id || id === st.activa) return;
    if (st.obras.some((o) => o.id_obra === id)) { mostrarApp(); abrirFicha(id, true); }
    else toast(`La obra ${id} no está publicada o no existe.`, 5000);
  });

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
  $('btn-logout').addEventListener('click', async () => { st.enApp = false; history.replaceState(null, '', location.pathname); await sb.auth.signOut(); });

  let ultimoUid;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session?.user?.id ?? null;
    if (uid === ultimoUid) return;       // evita recargar en refresh de token
    ultimoUid = uid;
    setTimeout(() => actualizarSesion(session), 0);
  });
})();

// Instalable como app (manifest-tablero.json + sw.js)
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
