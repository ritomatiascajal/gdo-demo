/* GdO — App del inspector (web instalable)
 * Flujo: ingresar → mis obras → ítems de la obra → cargar medición con fotos selladas (GPS, hora, equipo).
 * La medición queda "Pendiente" hasta que la valida Obras Públicas / Servicios Públicos.
 * Si la observan, el inspector la corrige y la reenvía. Las novedades llegan a la campana de notificaciones.
 */
(() => {
  const cfg = window.GDO_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
  const N = window.GDO_NOTIF;
  const $ = (id) => document.getElementById(id);
  const vista = $('vista');

  const st = { rol: null, idUsuario: null, nombre: null, radio: 200, obras: [], obra: null, item: null,
               pila: [], fotos: [], gps: null, watchId: null, med: null };

  // ---------- utilidades ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v) => v == null ? '—' : (Number(v) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
  const numero = (v, d = 2) => Number(v).toLocaleString('es-AR', { maximumFractionDigits: d });
  const pesos = (v) => '$ ' + Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
  const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fechaCorta = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-AR') : '—';
  const ICONO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 2.5c-9 0-16.3 7.1-16.3 16 0 11.6 16.3 27 16.3 27s16.3-15.4 16.3-27c0-8.9-7.3-16-16.3-16z" fill="currentColor"/><path d="M14.2 23.2c0-5.9 4.4-10.4 9.8-10.4s9.8 4.5 9.8 10.4z" fill="#f2b705"/><rect x="22.4" y="11.4" width="3.2" height="7.6" rx="1.2" fill="#d99a00"/><rect x="11.6" y="22.6" width="24.8" height="3.6" rx="1.8" fill="#f2b705"/></svg>';

  function toast(msg, ms = 3500) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    t.classList.remove('sale'); void t.offsetWidth; t.classList.add('entra');
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  function vibrar(p = 25) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* sin vibración */ } }

  function distanciaM(lat1, lng1, lat2, lng2) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---------- navegación con transición ----------
  function pintar(html, dir = 'adelante') {
    vista.innerHTML = html;
    vista.classList.remove('v-adelante', 'v-atras'); void vista.offsetWidth;
    vista.classList.add(dir === 'atras' ? 'v-atras' : 'v-adelante');
  }
  function ir(fn, ...args) { st.dir = 'adelante'; st.pila.push([fn, args]); fn(...args); actualizarBarra(); }
  function atras() {
    if (st.pila.length > 1) { st.dir = 'atras'; st.pila.pop(); const [fn, args] = st.pila[st.pila.length - 1]; fn(...args); actualizarBarra(); }
  }
  function actualizarBarra() {
    $('btn-atras').hidden = st.pila.length <= 1;
    $('btn-menu').hidden = !st.rol;
    $('btn-notif').hidden = !st.rol || !N.disponible;
    window.scrollTo({ top: 0 });
  }
  function titulo(t, s) { $('titulo').textContent = t; $('subtitulo').textContent = s || cfg.municipio; }
  $('btn-atras').addEventListener('click', () => { pararGps(); atras(); });
  $('btn-menu').addEventListener('click', async () => { if (confirm('¿Cerrar sesión?')) await sb.auth.signOut(); });
  window.addEventListener('popstate', () => { if (st.pila.length > 1) { pararGps(); atras(); history.pushState(null, ''); } });

  // ---------- login ----------
  function vistaLogin(msg = '') {
    msg = msg || st.msgLogin || ''; st.msgLogin = '';
    titulo('Inspector de obra');
    pintar(`
      <form class="login" id="f-login">
        <div class="logo">${ICONO}</div>
        <h2>Carga de avances de obra</h2>
        <p>Ingresá con el usuario que te dio el municipio.</p>
        <input id="l-email" type="email" placeholder="Email" autocomplete="username" inputmode="email" required>
        <input id="l-pass" type="password" placeholder="Contraseña" autocomplete="current-password" required>
        <p class="error" id="l-error">${esc(msg)}</p>
        <button class="btn" type="submit">Ingresar</button>
        <a href="./" class="link-sec">Ir al tablero y visor de obras</a>
      </form>
      <footer class="credito">
        <span>Desarrollado por</span>
        <span class="cred-img"><img class="logo-c" src="img/hydrogis.png" alt="HydroGIS"><img class="logo-o" src="img/hydrogis-oscuro.png" alt="HydroGIS"></span>
        <span class="datos"><a href="mailto:hydrogis.arg@gmail.com">hydrogis.arg@gmail.com</a>
          <a href="https://instagram.com/hydrogis.arg" target="_blank" rel="noopener">@hydrogis.arg</a><span>Córdoba, Argentina</span></span>
      </footer>`);
    $('f-login').addEventListener('submit', async (e) => {
      e.preventDefault(); $('l-error').textContent = 'Ingresando…';
      const { error } = await sb.auth.signInWithPassword({ email: $('l-email').value.trim(), password: $('l-pass').value });
      if (error) { $('l-error').textContent = 'Email o contraseña incorrectos.'; $('f-login').classList.add('sacude'); setTimeout(() => $('f-login')?.classList.remove('sacude'), 500); }
    });
  }

  // ---------- notificaciones ----------
  N.escuchar(({ noLeidas, nuevas, disponible }) => {
    const b = $('notif-badge');
    b.textContent = noLeidas > 9 ? '9+' : noLeidas; b.hidden = !noLeidas;
    $('btn-notif').hidden = !st.rol || !disponible;
    if (nuevas.length) { toast(`🔔 ${nuevas[0].titulo}${nuevas.length > 1 ? ` (+${nuevas.length - 1})` : ''}`, 5000); vibrar([30, 60, 30]); $('btn-notif').classList.add('timbre'); setTimeout(() => $('btn-notif').classList.remove('timbre'), 900); }
    if (st.pila.length && st.pila[st.pila.length - 1][0] === vistaNotif) pintarNotif(false);
  });
  $('btn-notif').addEventListener('click', () => { pararGps(); if (st.pila[st.pila.length - 1]?.[0] !== vistaNotif) ir(vistaNotif); });

  function vistaNotif() { titulo('Notificaciones', st.nombre); pintarNotif(true); }
  function pintarNotif(anim) {
    const html = `<div class="notif-cab"><h3 class="seccion">Novedades</h3>${N.noLeidas ? '<button class="link-btn" id="n-todas">Marcar todas como leídas</button>' : ''}</div>${N.lista()}`;
    if (anim) pintar(html, st.dir); else vista.innerHTML = html;
    $('n-todas')?.addEventListener('click', () => N.marcarTodas());
    vista.querySelectorAll('.notif').forEach((li) => li.addEventListener('click', async () => {
      N.marcar([Number(li.dataset.id)]);
      const id = li.dataset.obra;
      if (id) { if (!st.obras.length) await cargarObras(); if (st.obras.some((o) => o.id_obra === id)) ir(vistaObra, id); }
    }));
  }

  // ---------- mis obras ----------
  async function cargarObras() {
    const { data, error } = await sb.from('v_obras')
      .select('id_obra,nombre,tipo_obra,barrio,direccion,estado,modalidad,lat,lng,avance_fisico,mediciones_pendientes')
      .eq('inspector_id', st.idUsuario).order('id_obra');
    if (error) throw error;
    st.obras = data; return data;
  }
  async function vistaObras() {
    titulo('Mis obras', st.nombre);
    pintar('<div class="esqueleto"></div><div class="esqueleto"></div><div class="esqueleto"></div>', st.dir);
    let data;
    try { data = await cargarObras(); } catch (error) { vista.innerHTML = `<p class="vacio">Error: ${esc(error.message)}</p>`; return; }
    const activas = data.filter((o) => ['En ejecución', 'Paralizada', 'Adjudicada'].includes(o.estado));
    const otras = data.filter((o) => !activas.includes(o));
    let k = 0;
    const tarjeta = (o) => `
      <button class="tarjeta" data-id="${esc(o.id_obra)}" style="--i:${k++}">
        <div class="t">${esc(o.nombre)}</div>
        <div class="s">${esc(o.id_obra)} · ${esc(o.barrio || '')} · ${esc(o.estado)}</div>
        <div class="fila"><div class="trk"><div class="fill" style="--w:${Math.min(100, (o.avance_fisico || 0) * 100)}%"></div></div>
          <span class="num">${pct(o.avance_fisico)}</span></div>
        ${o.mediciones_pendientes ? `<div class="s pend-txt">${o.mediciones_pendientes} medición(es) esperando validación</div>` : ''}
      </button>`;
    vista.innerHTML = `<div class="saludo">Hola, <strong>${esc((st.nombre || '').split(' ')[0])}</strong> 👷 <span>${(() => { const t = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }); return t[0].toUpperCase() + t.slice(1); })()}</span></div>` +
      (activas.length ? `<h3 class="seccion">En obra (${activas.length})</h3>` + activas.map(tarjeta).join('') : '<p class="vacio">No tenés obras en ejecución asignadas.</p>') +
      (otras.length ? `<h3 class="seccion">Otras asignadas</h3>` + otras.map(tarjeta).join('') : '');
    vista.querySelectorAll('.tarjeta').forEach((b) => b.addEventListener('click', () => ir(vistaObra, b.dataset.id)));
  }

  // ---------- obra: ítems + últimas mediciones ----------
  async function vistaObra(id) {
    const o = st.obras.find((x) => x.id_obra === id); st.obra = o;
    titulo(o.nombre, `${o.id_obra} · ${o.estado}`);
    pintar('<div class="esqueleto"></div><div class="esqueleto"></div>', st.dir);
    const [it, me] = await Promise.all([
      sb.from('v_items').select('id_item,nro_item,rubro,descripcion,unidad,cantidad,precio_unitario,avance_item,saldo_cantidad').eq('id_obra', id).order('nro_item'),
      sb.from('v_mediciones').select('id_medicion,id_item,periodo,fecha,item_descripcion,unidad,cantidad_periodo,estado_validacion,observaciones')
        .eq('id_obra', id).eq('inspector_id', st.idUsuario).order('fecha', { ascending: false }).order('creado_en', { ascending: false }).limit(10)
    ]);
    if (it.error || me.error) { vista.innerHTML = `<p class="vacio">Error: ${esc((it.error || me.error).message)}</p>`; return; }
    o.items = it.data; o.meds = me.data;
    let h = '', k = 0;
    const obs = me.data.filter((m) => m.estado_validacion === 'Observada');
    if (o.estado === 'Paralizada') h += '<p class="aviso">Obra paralizada: cargá avance solo si se reanudaron los trabajos.</p>';
    if (obs.length) h += `<p class="aviso rojo">Tenés ${obs.length} medición(es) observada(s). Corregilas y reenvialas desde "Mis últimas mediciones".</p>`;
    h += '<h3 class="seccion">Elegí el ítem a medir</h3>' + it.data.map((i) => `
      <button class="tarjeta" data-item="${esc(i.id_item)}" style="--i:${k++}">
        <div class="t">${i.nro_item}. ${esc(i.descripcion)}</div>
        <div class="s">${esc(i.rubro || '')} · contratado ${numero(i.cantidad)} ${esc(i.unidad)}</div>
        <div class="fila"><div class="trk"><div class="fill" style="--w:${Math.min(100, (i.avance_item || 0) * 100)}%"></div></div>
          <span class="num">${pct(i.avance_item)}</span></div>
      </button>`).join('');
    h += '<h3 class="seccion">Mis últimas mediciones</h3>' + (me.data.length ? me.data.map((m) => `
      <div class="tarjeta med ${esc(m.estado_validacion)}" style="--i:${k++}">
        <div class="fila" style="margin-top:0"><div class="t" style="font-size:14.5px">${esc(m.item_descripcion)}</div><span class="pill ${esc(m.estado_validacion)}">${esc(m.estado_validacion)}</span></div>
        <div class="s">${esc(m.id_medicion)} · ${esc(m.periodo)} · ${fechaCorta(m.fecha)} · <span class="num">${numero(m.cantidad_periodo)} ${esc(m.unidad)}</span></div>
        ${m.observaciones ? `<div class="s obs-txt">${m.estado_validacion === 'Observada' ? '<strong>Motivo:</strong> ' : ''}${esc(m.observaciones)}</div>` : ''}
        ${['Observada', 'Pendiente'].includes(m.estado_validacion) ? `<button class="btn sec chico" data-corregir="${esc(m.id_medicion)}">${m.estado_validacion === 'Observada' ? '✎ Corregir y reenviar' : '✎ Corregir'}</button>` : ''}
      </div>`).join('') : '<p class="vacio">Todavía no cargaste mediciones en esta obra.</p>');
    vista.innerHTML = h;
    vista.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => ir(vistaCarga, b.dataset.item, null)));
    vista.querySelectorAll('[data-corregir]').forEach((b) => b.addEventListener('click', () => {
      const m = o.meds.find((x) => x.id_medicion === b.dataset.corregir);
      ir(vistaCarga, m.id_item, m);
    }));
  }

  // ---------- GPS ----------
  function iniciarGps() {
    pararGps();
    if (!('geolocation' in navigator)) { st.gps = { error: 'Este dispositivo no tiene GPS disponible.' }; pintarGps(); return; }
    st.gps = null; pintarGps();
    st.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        st.gps = { lat: c.latitude, lng: c.longitude, prec: c.accuracy, alt: c.altitude, altPrec: c.altitudeAccuracy,
                   rumbo: c.heading, vel: c.speed, ts: p.timestamp };
        pintarGps();
      },
      (e) => { st.gps = { error: e.code === 1 ? 'Permiso de ubicación denegado. Activalo para respaldar la foto.' : 'No se pudo obtener la ubicación.' }; pintarGps(); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function pararGps() { if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId); st.watchId = null; }
  function pintarGps() {
    const el = $('gps'); if (!el) return;
    const g = st.gps, o = st.obra;
    if (!g) { el.className = 'gps buscando'; el.innerHTML = '<span class="radar"></span>Buscando ubicación GPS…'; return; }
    if (g.error) { el.className = 'gps error'; el.textContent = g.error; return; }
    const d = (o.lat != null) ? distanciaM(g.lat, g.lng, o.lat, o.lng) : null;
    const lejos = d != null && d > st.radio;
    el.className = 'gps ' + (lejos ? 'lejos' : 'ok');
    el.innerHTML = `<span class="punto-gps"></span>Ubicación ±${Math.round(g.prec)} m` + (d != null ? ` · a ${numero(d, 0)} m de la obra` : '') +
      (lejos ? ` — más de ${st.radio} m: la foto quedará marcada para revisar.` : '');
  }

  // ---------- carga (nueva o corrección) ----------
  function vistaCarga(idItem, med) {
    const o = st.obra, i = o.items.find((x) => x.id_item === idItem); st.item = i; st.med = med;
    st.fotos = [];
    const corrige = !!med;
    titulo(corrige ? `Corregir ${med.id_medicion}` : `Ítem ${i.nro_item} — ${i.descripcion}`, `${o.id_obra} · ${o.nombre}`);
    const periodo = corrige ? med.periodo : hoyISO().slice(0, 7);
    pintar(`
      <form class="carga" id="f-carga">
        ${corrige && med.estado_validacion === 'Observada' ? `<p class="aviso rojo"><strong>Observada:</strong> ${esc(med.observaciones || 'sin motivo cargado')}</p>` : ''}
        <div class="resumen-item">
          <strong>${i.nro_item}. ${esc(i.descripcion)}</strong>
          <dl>
            <dt>Contratado</dt><dd>${numero(i.cantidad)} ${esc(i.unidad)}</dd>
            <dt>Aprobado hasta hoy</dt><dd>${pct(i.avance_item)}</dd>
            <dt>Saldo</dt><dd>${numero(i.saldo_cantidad)} ${esc(i.unidad)}</dd>
          </dl>
        </div>
        <label class="campo">Cantidad ejecutada en el período
          <div class="cantidad"><input id="c-cant" type="number" inputmode="decimal" min="0" step="any" required placeholder="0" value="${corrige ? esc(med.cantidad_periodo) : ''}"><span class="u">${esc(i.unidad)}</span></div>
          <small id="c-monto"></small>
        </label>
        <div class="fila2">
          <label class="campo">Período <input id="c-periodo" type="month" value="${periodo}" required ${corrige ? 'disabled' : ''}></label>
          <label class="campo">Fecha <input id="c-fecha" type="date" value="${corrige ? String(med.fecha).slice(0, 10) : hoyISO()}" required ${corrige ? 'disabled' : ''}></label>
        </div>
        <div class="foto-zona">
          <span class="campo-tit">Fotos de respaldo <small>${corrige ? '(opcional: sumá fotos nuevas)' : '(al menos una)'}</small></span>
          <div id="gps" class="gps"></div>
          <div class="fotos-prev" id="fotos-prev"></div>
          <label class="btn-foto"><span class="cam">📷</span> Sacar foto
            <input id="c-foto" type="file" accept="image/*" capture="environment" hidden>
          </label>
          <small class="nota-sello">Cada foto queda sellada con obra, ítem, fecha y hora, GPS, distancia a la obra, tu nombre y el equipo. Se guarda además la huella digital del archivo original.</small>
        </div>
        <label class="campo">${corrige ? 'Qué corregiste' : 'Observaciones'} <small>(opcional)</small>
          <textarea id="c-obs" placeholder="${corrige ? 'Ej.: se re-midió la cuadra 3, se agregan fotos de detalle' : 'Ej.: se completó la cuadra 2, falta curado'}"></textarea>
        </label>
        <p class="error" id="c-error"></p>
        <button class="btn" type="submit" id="c-enviar">${corrige ? 'Reenviar corregida' : 'Enviar medición'}</button>
        <div class="progreso" id="c-prog" hidden><div class="barra-prog"><div id="c-prog-fill"></div></div><span id="c-prog-txt"></span></div>
      </form>`, st.dir);
    iniciarGps();

    const montoTxt = () => {
      const v = Number($('c-cant').value || 0);
      let t = v ? `Valorizado: ${pesos(v * i.precio_unitario)}` : '';
      const saldo = Number(i.saldo_cantidad) + (corrige && med.estado_validacion === 'Aprobada' ? Number(med.cantidad_periodo) : 0);
      if (v > saldo) t += ` · ⚠ supera el saldo del ítem (${numero(saldo)} ${i.unidad})`;
      $('c-monto').textContent = t;
    };
    $('c-cant').addEventListener('input', montoTxt); montoTxt();

    $('c-foto').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const slot = document.createElement('figure'); slot.className = 'procesando'; slot.innerHTML = '<span class="spinner"></span><small>Sellando…</small>';
      $('fotos-prev').appendChild(slot);
      try {
        const r = await window.GDO_FOTO.procesar(f, {
          obra: o, item: i, inspector: { id: st.idUsuario, nombre: st.nombre }, gps: st.gps, radio: st.radio, distancia: distanciaM
        });
        st.fotos.push({ blob: r.blob, url: URL.createObjectURL(r.blob), meta: r.meta, gps: r.meta.gps, fecha: r.meta.captura.fecha_hora });
        vibrar();
        if (r.avisos.length) toast(r.avisos.join(' '), 6000);
      } catch (ex) { console.error(ex); toast('No se pudo leer la foto.'); }
      pintarFotos();
    });

    $('f-carga').addEventListener('submit', enviar);
  }

  function pintarFotos() {
    $('fotos-prev').innerHTML = st.fotos.map((f, k) =>
      `<figure class="nueva-foto"><img src="${f.url}" alt="Foto ${k + 1}"><button type="button" data-k="${k}" aria-label="Quitar foto">×</button>
        <figcaption>${f.meta.gps ? (f.meta.obra.distancia_m != null ? numero(f.meta.obra.distancia_m, 0) + ' m' : 'GPS ✓') : 'sin GPS'}</figcaption></figure>`).join('');
    $('fotos-prev').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      URL.revokeObjectURL(st.fotos[b.dataset.k].url); st.fotos.splice(b.dataset.k, 1); pintarFotos();
    }));
    $('fotos-prev').querySelectorAll('img').forEach((img, k) => img.addEventListener('click', () => window.open(st.fotos[k].url, '_blank')));
  }

  function progreso(p, txt) { $('c-prog').hidden = false; $('c-prog-fill').style.width = `${Math.round(p * 100)}%`; $('c-prog-txt').textContent = txt; }

  async function guardarFoto(o, idMed, periodo, f, k, n) {
    progreso((k + 0.5) / (n + 1), `Subiendo foto ${k + 1} de ${n}…`);
    const ruta = `${o.id_obra}/${periodo}/${idMed}_${Date.now()}_${k + 1}.jpg`;
    const { error: e2 } = await sb.storage.from('fotos').upload(ruta, f.blob, { contentType: 'image/jpeg' });
    if (e2) throw new Error(`La medición ${idMed} se guardó, pero falló la foto ${k + 1}: ${e2.message}`);
    const fila = {
      id_obra: o.id_obra, id_medicion: idMed, fecha_hora: f.fecha,
      geom: f.gps ? `SRID=4326;POINT(${f.gps.lng} ${f.gps.lat})` : null,
      tipo_foto: 'Durante', archivo: ruta, descripcion: `Respaldo ítem ${st.item.nro_item}`, cargada_por: st.idUsuario, metadatos: f.meta
    };
    let { error: e3 } = await sb.from('fotos').insert(fila);
    if (e3 && /metadatos/i.test(e3.message || '')) {   // base sin el script 05: se guarda igual, sin metadatos
      delete fila.metadatos; ({ error: e3 } = await sb.from('fotos').insert(fila));
    }
    if (e3) throw new Error(`La medición ${idMed} se guardó, pero no el registro de la foto ${k + 1}: ${e3.message}`);
  }

  async function enviar(e) {
    e.preventDefault();
    const o = st.obra, i = st.item, med = st.med;
    const cant = Number($('c-cant').value);
    const err = $('c-error'); err.textContent = '';
    if (!(cant > 0)) { err.textContent = 'Ingresá una cantidad mayor a cero.'; return; }
    if (!med && !st.fotos.length) { err.textContent = 'Sacá al menos una foto de respaldo.'; return; }
    if (!med && cant > Number(i.saldo_cantidad) && !confirm('La cantidad supera el saldo del ítem. ¿Enviar igual?')) return;

    const btn = $('c-enviar'); btn.disabled = true;
    const n = st.fotos.length;
    try {
      let idMed, periodo;
      if (med) {
        progreso(0.1, 'Reenviando medición…');
        const obs = $('c-obs').value.trim();
        const { data, error } = await sb.from('mediciones').update({
          cantidad_periodo: cant, estado_validacion: 'Pendiente',
          observaciones: obs ? `Corrección: ${obs}` : (med.estado_validacion === 'Observada' ? `Corregida (antes: ${med.observaciones || 'observada'})` : med.observaciones)
        }).eq('id_medicion', med.id_medicion).select('id_medicion');
        if (error) throw error;
        if (!data.length) throw new Error('No se pudo reenviar: falta actualizar la base del sistema (script 05). Avisale al administrador.');
        idMed = med.id_medicion; periodo = med.periodo;
      } else {
        progreso(0.05, 'Guardando medición…');
        periodo = $('c-periodo').value;
        const { data, error } = await sb.from('mediciones').insert({
          id_obra: o.id_obra, id_item: i.id_item, periodo, fecha: $('c-fecha').value,
          cantidad_periodo: cant, inspector_id: st.idUsuario, observaciones: $('c-obs').value.trim() || null
        }).select('id_medicion').single();
        if (error) throw error;
        idMed = data.id_medicion;
      }
      for (let k = 0; k < n; k++) await guardarFoto(o, idMed, periodo, st.fotos[k], k, n);
      progreso(1, 'Listo');
      pararGps(); vibrar([40, 50, 40]);
      st.fotos.forEach((f) => URL.revokeObjectURL(f.url)); st.fotos = [];
      exito(med ? `Medición ${idMed} corregida y reenviada.` : `Medición ${idMed} enviada.`);
    } catch (ex) {
      console.error(ex);
      err.textContent = ex.message || 'No se pudo enviar. Revisá la conexión e intentá de nuevo.';
      $('c-prog').hidden = true; btn.disabled = false;
    }
  }

  function exito(msg) {
    pintar(`<div class="exito">
        <svg viewBox="0 0 52 52" class="tilde"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
        <h2>${esc(msg)}</h2><p>Queda pendiente de validación. Te va a llegar una notificación cuando la revisen.</p>
        <button class="btn" id="ok-volver">Volver a la obra</button>
      </div>`);
    const volver = async () => { clearTimeout(st.tExito); if (!$('ok-volver')) return; st.pila.pop(); st.dir = 'atras'; const [fn, args] = st.pila[st.pila.length - 1]; await fn(...args); actualizarBarra(); };
    $('ok-volver').addEventListener('click', volver);
    st.tExito = setTimeout(volver, 3500);
  }

  // ---------- sesión ----------
  let ultimoUid;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session?.user?.id ?? null;
    if (uid === ultimoUid) return; ultimoUid = uid;
    setTimeout(() => iniciarSesion(session), 0);
  });

  async function iniciarSesion(session) {
    st.pila = []; st.rol = null; st.idUsuario = null; pararGps(); N.detener();
    if (!session) { actualizarBarra(); vistaLogin(); return; }
    const [r, u] = await Promise.all([sb.rpc('mi_rol'), sb.rpc('mi_usuario')]);
    st.rol = r.data || null; st.idUsuario = u.data || null;
    if (st.rol !== 'Inspector de obra') {
      st.msgLogin = st.rol ? `Esta app es para inspectores. Tu rol es "${st.rol}": usá el tablero web.` : 'Tu usuario no tiene un rol asignado en el municipio.';
      st.rol = null;
      await sb.auth.signOut();
      return;
    }
    const [n, p] = await Promise.all([
      sb.from('usuarios').select('nombre').eq('id_usuario', st.idUsuario).single(),
      sb.from('parametros').select('valor_num').eq('clave', 'radio_foto_m').single()
    ]);
    st.nombre = n.data?.nombre || st.idUsuario;
    if (p.data?.valor_num) st.radio = Number(p.data.valor_num);
    N.iniciar(sb, st.idUsuario);
    window.GDO_FOTO.dispositivo();   // precarga datos del equipo
    history.pushState(null, '');     // el botón "atrás" del celular navega dentro de la app
    ir(vistaObras);
  }

  // ---------- instalable ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
