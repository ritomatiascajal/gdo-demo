/* GdO — App del inspector (web instalable)
 * Flujo: ingresar → mis obras → ítems de la obra → cargar medición con foto y GPS.
 * La medición queda "Pendiente" hasta que la valida Obras Públicas / Servicios Públicos.
 */
(() => {
  const cfg = window.GDO_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
  const $ = (id) => document.getElementById(id);
  const vista = $('vista');

  const st = { rol: null, idUsuario: null, nombre: null, radio: 200, obras: [], obra: null, item: null,
               pila: [], fotos: [], gps: null, watchId: null };

  // ---------- utilidades ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v) => v == null ? '—' : (Number(v) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
  const numero = (v, d = 2) => Number(v).toLocaleString('es-AR', { maximumFractionDigits: d });
  const pesos = (v) => '$ ' + Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
  const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fechaCorta = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-AR') : '—';

  function toast(msg, ms = 3500) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  function distanciaM(lat1, lng1, lat2, lng2) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Achica la foto (máx. 1600 px, JPEG 80%) para ahorrar datos y espacio
  async function comprimir(file) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
  }

  // ---------- navegación ----------
  function ir(fn, ...args) { st.pila.push([fn, args]); fn(...args); actualizarBarra(); }
  function atras() { if (st.pila.length > 1) { st.pila.pop(); const [fn, args] = st.pila[st.pila.length - 1]; fn(...args); actualizarBarra(); } }
  function actualizarBarra() {
    $('btn-atras').hidden = st.pila.length <= 1;
    $('btn-menu').hidden = !st.rol;
    window.scrollTo(0, 0);
  }
  function titulo(t, s) { $('titulo').textContent = t; $('subtitulo').textContent = s || cfg.municipio; }
  $('btn-atras').addEventListener('click', () => { pararGps(); atras(); });
  $('btn-menu').addEventListener('click', async () => { if (confirm('¿Cerrar sesión?')) await sb.auth.signOut(); });

  // ---------- login ----------
  function vistaLogin(msg = '') {
    msg = msg || st.msgLogin || ''; st.msgLogin = '';
    titulo('Inspector de obra');
    vista.innerHTML = `
      <form class="login" id="f-login">
        <div class="logo"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 2.5c-9 0-16.3 7.1-16.3 16 0 11.6 16.3 27 16.3 27s16.3-15.4 16.3-27c0-8.9-7.3-16-16.3-16z" fill="currentColor"/><path d="M14.2 23.2c0-5.9 4.4-10.4 9.8-10.4s9.8 4.5 9.8 10.4z" fill="#f2b705"/><rect x="22.4" y="11.4" width="3.2" height="7.6" rx="1.2" fill="#d99a00"/><rect x="11.6" y="22.6" width="24.8" height="3.6" rx="1.8" fill="#f2b705"/></svg></div>
        <h2>Carga de avances de obra</h2>
        <p>Ingresá con el usuario que te dio el municipio.</p>
        <input id="l-email" type="email" placeholder="Email" autocomplete="username" required>
        <input id="l-pass" type="password" placeholder="Contraseña" autocomplete="current-password" required>
        <p class="error" id="l-error">${esc(msg)}</p>
        <button class="btn" type="submit">Ingresar</button>
        <a href="./" style="text-align:center;font-size:13.5px;color:var(--acento-txt)">Ir al tablero y visor de obras</a>
      </form>
      <footer class="credito">
        <span>Desarrollado por</span>
        <span class="cred-img"><img class="logo-c" src="img/hydrogis.png" alt="HydroGIS"><img class="logo-o" src="img/hydrogis-oscuro.png" alt="HydroGIS"></span>
        <span class="datos"><a href="mailto:hydrogis.arg@gmail.com">hydrogis.arg@gmail.com</a>
          <a href="https://instagram.com/hydrogis.arg" target="_blank" rel="noopener">@hydrogis.arg</a><span>Córdoba, Argentina</span></span>
      </footer>`;
    $('f-login').addEventListener('submit', async (e) => {
      e.preventDefault(); $('l-error').textContent = 'Ingresando…';
      const { error } = await sb.auth.signInWithPassword({ email: $('l-email').value.trim(), password: $('l-pass').value });
      if (error) $('l-error').textContent = 'Email o contraseña incorrectos.';
    });
  }

  // ---------- mis obras ----------
  async function vistaObras() {
    titulo('Mis obras', st.nombre);
    vista.innerHTML = '<p class="vacio">Cargando obras…</p>';
    const { data, error } = await sb.from('v_obras')
      .select('id_obra,nombre,tipo_obra,barrio,direccion,estado,modalidad,lat,lng,avance_fisico,mediciones_pendientes')
      .eq('inspector_id', st.idUsuario).order('id_obra');
    if (error) { vista.innerHTML = `<p class="vacio">Error: ${esc(error.message)}</p>`; return; }
    st.obras = data;
    const activas = data.filter((o) => ['En ejecución', 'Paralizada', 'Adjudicada'].includes(o.estado));
    const otras = data.filter((o) => !activas.includes(o));
    const tarjeta = (o) => `
      <button class="tarjeta" data-id="${esc(o.id_obra)}">
        <div class="t">${esc(o.nombre)}</div>
        <div class="s">${esc(o.id_obra)} · ${esc(o.barrio || '')} · ${esc(o.estado)}</div>
        <div class="fila"><div class="trk"><div class="fill" style="width:${Math.min(100, (o.avance_fisico || 0) * 100)}%"></div></div>
          <span class="num">${pct(o.avance_fisico)}</span></div>
        ${o.mediciones_pendientes ? `<div class="s">${o.mediciones_pendientes} medición(es) esperando validación</div>` : ''}
      </button>`;
    vista.innerHTML = (activas.length ? `<h3 class="seccion">En obra (${activas.length})</h3>` + activas.map(tarjeta).join('') : '<p class="vacio">No tenés obras en ejecución asignadas.</p>') +
      (otras.length ? `<h3 class="seccion">Otras asignadas</h3>` + otras.map(tarjeta).join('') : '');
    vista.querySelectorAll('.tarjeta').forEach((b) => b.addEventListener('click', () => ir(vistaObra, b.dataset.id)));
  }

  // ---------- obra: ítems + últimas mediciones ----------
  async function vistaObra(id) {
    const o = st.obras.find((x) => x.id_obra === id); st.obra = o;
    titulo(o.nombre, `${o.id_obra} · ${o.estado}`);
    vista.innerHTML = '<p class="vacio">Cargando ítems…</p>';
    const [it, me] = await Promise.all([
      sb.from('v_items').select('id_item,nro_item,rubro,descripcion,unidad,cantidad,precio_unitario,avance_item,saldo_cantidad').eq('id_obra', id).order('nro_item'),
      sb.from('v_mediciones').select('id_medicion,periodo,fecha,item_descripcion,unidad,cantidad_periodo,estado_validacion,observaciones')
        .eq('id_obra', id).eq('inspector_id', st.idUsuario).order('fecha', { ascending: false }).order('creado_en', { ascending: false }).limit(8)
    ]);
    if (it.error || me.error) { vista.innerHTML = `<p class="vacio">Error: ${esc((it.error || me.error).message)}</p>`; return; }
    o.items = it.data;
    let h = '';
    if (o.estado === 'Paralizada') h += '<p class="aviso">Obra paralizada: cargá avance solo si se reanudaron los trabajos.</p>';
    h += '<h3 class="seccion">Elegí el ítem a medir</h3>' + it.data.map((i) => `
      <button class="tarjeta" data-item="${esc(i.id_item)}">
        <div class="t">${i.nro_item}. ${esc(i.descripcion)}</div>
        <div class="s">${esc(i.rubro || '')} · contratado ${numero(i.cantidad)} ${esc(i.unidad)}</div>
        <div class="fila"><div class="trk"><div class="fill" style="width:${Math.min(100, (i.avance_item || 0) * 100)}%"></div></div>
          <span class="num">${pct(i.avance_item)}</span></div>
      </button>`).join('');
    h += '<h3 class="seccion">Mis últimas mediciones</h3>' + (me.data.length ? me.data.map((m) => `
      <div class="tarjeta" style="cursor:default">
        <div class="fila" style="margin-top:0"><div class="t" style="font-size:14.5px">${esc(m.item_descripcion)}</div><span class="pill ${esc(m.estado_validacion)}">${esc(m.estado_validacion)}</span></div>
        <div class="s">${esc(m.periodo)} · ${fechaCorta(m.fecha)} · <span class="num">${numero(m.cantidad_periodo)} ${esc(m.unidad)}</span></div>
        ${m.observaciones ? `<div class="s">${esc(m.observaciones)}</div>` : ''}
      </div>`).join('') : '<p class="vacio">Todavía no cargaste mediciones en esta obra.</p>');
    vista.innerHTML = h;
    vista.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => ir(vistaCarga, b.dataset.item)));
  }

  // ---------- GPS ----------
  function iniciarGps() {
    pararGps();
    if (!('geolocation' in navigator)) { st.gps = { error: 'Este dispositivo no tiene GPS disponible.' }; pintarGps(); return; }
    st.gps = null; pintarGps();
    st.watchId = navigator.geolocation.watchPosition(
      (p) => { st.gps = { lat: p.coords.latitude, lng: p.coords.longitude, prec: p.coords.accuracy }; pintarGps(); },
      (e) => { st.gps = { error: e.code === 1 ? 'Permiso de ubicación denegado. Activalo para respaldar la foto.' : 'No se pudo obtener la ubicación.' }; pintarGps(); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function pararGps() { if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId); st.watchId = null; }
  function pintarGps() {
    const el = $('gps'); if (!el) return;
    const g = st.gps, o = st.obra;
    if (!g) { el.className = 'gps'; el.textContent = 'Buscando ubicación GPS…'; return; }
    if (g.error) { el.className = 'gps error'; el.textContent = g.error; return; }
    const d = (o.lat != null) ? distanciaM(g.lat, g.lng, o.lat, o.lng) : null;
    const lejos = d != null && d > st.radio;
    el.className = 'gps ' + (lejos ? 'lejos' : 'ok');
    el.textContent = `Ubicación ±${Math.round(g.prec)} m` + (d != null ? ` · a ${Math.round(d)} m de la obra` : '') +
      (lejos ? ` — más de ${st.radio} m: la foto quedará marcada para revisar.` : '');
  }

  // ---------- carga de medición ----------
  function vistaCarga(idItem) {
    const o = st.obra, i = o.items.find((x) => x.id_item === idItem); st.item = i;
    st.fotos = [];
    titulo(`Ítem ${i.nro_item} — ${i.descripcion}`, `${o.id_obra} · ${o.nombre}`);
    const periodo = hoyISO().slice(0, 7);
    vista.innerHTML = `
      <form class="carga" id="f-carga">
        <div class="resumen-item">
          <strong>${esc(i.descripcion)}</strong>
          <dl>
            <dt>Contratado</dt><dd>${numero(i.cantidad)} ${esc(i.unidad)}</dd>
            <dt>Aprobado hasta hoy</dt><dd>${pct(i.avance_item)}</dd>
            <dt>Saldo</dt><dd>${numero(i.saldo_cantidad)} ${esc(i.unidad)}</dd>
          </dl>
        </div>
        <label class="campo">Cantidad ejecutada en el período
          <div class="cantidad"><input id="c-cant" type="number" inputmode="decimal" min="0" step="any" required placeholder="0"><span class="u">${esc(i.unidad)}</span></div>
          <small id="c-monto"></small>
        </label>
        <div class="fila" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label class="campo">Período <input id="c-periodo" type="month" value="${periodo}" required></label>
          <label class="campo">Fecha <input id="c-fecha" type="date" value="${hoyISO()}" required></label>
        </div>
        <div class="foto-zona">
          <span class="campo" style="font-weight:500;font-size:14px">Fotos de respaldo <small style="font-weight:400;color:var(--tinta-2)">(al menos una)</small></span>
          <div id="gps" class="gps"></div>
          <div class="fotos-prev" id="fotos-prev"></div>
          <label class="btn-foto">📷 Sacar foto
            <input id="c-foto" type="file" accept="image/*" capture="environment" hidden>
          </label>
        </div>
        <label class="campo">Observaciones <small>(opcional)</small>
          <textarea id="c-obs" placeholder="Ej.: se completó la cuadra 2, falta curado"></textarea>
        </label>
        <p class="error" id="c-error"></p>
        <button class="btn" type="submit" id="c-enviar">Enviar medición</button>
        <p class="progreso" id="c-prog"></p>
      </form>`;
    iniciarGps();

    $('c-cant').addEventListener('input', () => {
      const v = Number($('c-cant').value || 0);
      let t = v ? `Valorizado: ${pesos(v * i.precio_unitario)}` : '';
      if (v > Number(i.saldo_cantidad)) t += ` · ⚠ supera el saldo del ítem (${numero(i.saldo_cantidad)} ${i.unidad})`;
      $('c-monto').textContent = t;
    });

    $('c-foto').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const blob = await comprimir(f);
        const g = st.gps && !st.gps.error ? { ...st.gps } : null;
        st.fotos.push({ blob, url: URL.createObjectURL(blob), gps: g, fecha: new Date().toISOString() });
        pintarFotos();
        if (!g) toast('La foto se guardó sin ubicación GPS.');
      } catch { toast('No se pudo leer la foto.'); }
    });

    $('f-carga').addEventListener('submit', enviar);
  }

  function pintarFotos() {
    $('fotos-prev').innerHTML = st.fotos.map((f, k) =>
      `<figure><img src="${f.url}" alt="Foto ${k + 1}"><button type="button" data-k="${k}" aria-label="Quitar foto">×</button></figure>`).join('');
    $('fotos-prev').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      URL.revokeObjectURL(st.fotos[b.dataset.k].url); st.fotos.splice(b.dataset.k, 1); pintarFotos();
    }));
  }

  async function enviar(e) {
    e.preventDefault();
    const o = st.obra, i = st.item;
    const cant = Number($('c-cant').value);
    const err = $('c-error'); err.textContent = '';
    if (!(cant > 0)) { err.textContent = 'Ingresá una cantidad mayor a cero.'; return; }
    if (!st.fotos.length) { err.textContent = 'Sacá al menos una foto de respaldo.'; return; }
    if (cant > Number(i.saldo_cantidad) && !confirm('La cantidad supera el saldo del ítem. ¿Enviar igual?')) return;

    const btn = $('c-enviar'); btn.disabled = true;
    const prog = $('c-prog');
    const periodo = $('c-periodo').value;
    try {
      prog.textContent = 'Guardando medición…';
      const { data: med, error: e1 } = await sb.from('mediciones').insert({
        id_obra: o.id_obra, id_item: i.id_item, periodo, fecha: $('c-fecha').value,
        cantidad_periodo: cant, inspector_id: st.idUsuario, observaciones: $('c-obs').value.trim() || null
      }).select('id_medicion').single();
      if (e1) throw e1;

      for (let k = 0; k < st.fotos.length; k++) {
        const f = st.fotos[k];
        prog.textContent = `Subiendo foto ${k + 1} de ${st.fotos.length}…`;
        const ruta = `${o.id_obra}/${periodo}/${med.id_medicion}_${k + 1}_${Date.now()}.jpg`;
        const { error: e2 } = await sb.storage.from('fotos').upload(ruta, f.blob, { contentType: 'image/jpeg' });
        if (e2) throw new Error(`La medición ${med.id_medicion} se guardó, pero falló la foto ${k + 1}: ${e2.message}`);
        const { error: e3 } = await sb.from('fotos').insert({
          id_obra: o.id_obra, id_medicion: med.id_medicion, fecha_hora: f.fecha,
          geom: f.gps ? `SRID=4326;POINT(${f.gps.lng} ${f.gps.lat})` : null,
          tipo_foto: 'Durante', archivo: ruta, descripcion: `Respaldo ítem ${i.nro_item}`, cargada_por: st.idUsuario
        });
        if (e3) throw new Error(`La medición ${med.id_medicion} se guardó, pero no el registro de la foto ${k + 1}: ${e3.message}`);
      }
      pararGps();
      st.fotos.forEach((f) => URL.revokeObjectURL(f.url)); st.fotos = [];
      toast(`Medición ${med.id_medicion} enviada. Queda pendiente de validación.`, 5000);
      st.pila.pop(); // volver a la obra, refrescada
      const [fn, args] = st.pila[st.pila.length - 1]; await fn(...args); actualizarBarra();
    } catch (ex) {
      console.error(ex);
      err.textContent = ex.message || 'No se pudo enviar. Revisá la conexión e intentá de nuevo.';
      prog.textContent = ''; btn.disabled = false;
    }
  }

  // ---------- sesión ----------
  let ultimoUid;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session?.user?.id ?? null;
    if (uid === ultimoUid) return; ultimoUid = uid;
    setTimeout(() => iniciarSesion(session), 0);
  });

  async function iniciarSesion(session) {
    st.pila = []; st.rol = null; st.idUsuario = null; pararGps();
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
    ir(vistaObras);
  }

  // ---------- instalable ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
