/* GdO — sello y metadatos de las fotos del inspector
 * 1. Lee los datos del archivo original: EXIF (marca/modelo del celular, fecha de la toma, GPS de la cámara),
 *    tamaño y huella digital SHA-256.
 * 2. Junta los datos del momento: GPS del navegador (precisión, altitud, rumbo), fecha/hora y zona horaria,
 *    dispositivo, red, inspector, obra e ítem.
 * 3. Achica la imagen (máx. 1600 px) y le estampa una franja con esos datos, para que viajen con la foto
 *    aunque se descargue o se reenvíe.
 * Devuelve { blob, meta } — meta se guarda en fotos.metadatos.
 */
window.GDO_FOTO = (() => {
  const VERSION = 'GdO inspector 1.2';

  // ---------- EXIF (lector mínimo para JPEG) ----------
  function leerExif(buf) {
    try {
      const v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
      let off = 2;
      while (off + 4 < v.byteLength) {
        const marca = v.getUint16(off), largo = v.getUint16(off + 2);
        if (marca === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return tiff(v, off + 10);
        if ((marca & 0xFF00) !== 0xFF00 || marca === 0xFFDA) break;
        off += 2 + largo;
      }
    } catch (e) { /* archivo sin EXIF legible */ }
    return null;
  }
  function tiff(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
    const PRINC = { 0x010F: 'marca', 0x0110: 'modelo', 0x0131: 'software', 0x0132: 'fecha_modificacion', 0x0112: 'orientacion',
      0x9003: 'fecha_toma', 0x9011: 'zona_toma', 0xA434: 'lente', 0x920A: 'distancia_focal', 0x829D: 'apertura', 0x829A: 'exposicion', 0x8827: 'iso',
      0xA002: 'ancho', 0xA003: 'alto' };
    const GPS = { 1: 'latRef', 2: 'lat', 3: 'lngRef', 4: 'lng', 6: 'altitud', 0x1D: 'fecha' };
    const TAM = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const out = {}, gps = {};
    function valor(tipo, n, o) {
      const tam = TAM[tipo] || 1, p = tam * n > 4 ? t + u32(o) : o;
      if (p + tam * n > v.byteLength) return undefined;
      if (tipo === 2) { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(p + i); if (c) s += String.fromCharCode(c); } return s.trim(); }
      const leer = (q) => tipo === 3 ? u16(q) : tipo === 4 ? u32(q) : tipo === 9 ? v.getInt32(q, le)
        : tipo === 5 ? u32(q) / (u32(q + 4) || 1) : tipo === 10 ? v.getInt32(q, le) / (v.getInt32(q + 4, le) || 1) : v.getUint8(q);
      if (n === 1) return leer(p);
      const a = []; for (let i = 0; i < Math.min(n, 8); i++) a.push(leer(p + i * tam)); return a;
    }
    function ifd(o, mapa, destino) {
      if (o + 2 > v.byteLength) return {};
      const n = u16(o), subs = {};
      for (let i = 0; i < n && i < 200; i++) {
        const e = o + 2 + i * 12, tag = u16(e), tipo = u16(e + 2), cnt = u32(e + 4);
        if (tag === 0x8769 || tag === 0x8825) subs[tag] = t + u32(e + 8);
        else if (mapa[tag]) { const x = valor(tipo, cnt, e + 8); if (x !== undefined && x !== '') destino[mapa[tag]] = x; }
      }
      return subs;
    }
    const subs = ifd(t + u32(t + 4), PRINC, out);
    if (subs[0x8769]) ifd(subs[0x8769], PRINC, out);
    if (subs[0x8825]) ifd(subs[0x8825], GPS, gps);
    const dms = (a) => Array.isArray(a) ? a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600 : null;
    if (gps.lat && gps.lng) {
      out.gps = { lat: +(dms(gps.lat) * (gps.latRef === 'S' ? -1 : 1)).toFixed(6), lng: +(dms(gps.lng) * (gps.lngRef === 'W' ? -1 : 1)).toFixed(6) };
      if (typeof gps.altitud === 'number') out.gps.altitud_m = Math.round(gps.altitud);
    }
    if (typeof out.exposicion === 'number' && out.exposicion < 1) out.exposicion = '1/' + Math.round(1 / out.exposicion);
    return Object.keys(out).length ? out : null;
  }
  // "2026:10:01 22:15:03" → Date local
  function fechaExif(s) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }

  // ---------- dispositivo ----------
  let cacheDisp = null;
  async function dispositivo() {
    if (cacheDisp) return cacheDisp;
    const ua = navigator.userAgent;
    const d = {
      plataforma: null, version_so: null, modelo: null, navegador: null,
      pantalla: `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x`,
      idioma: navigator.language, zona_horaria: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tactil: navigator.maxTouchPoints > 0, agente: ua
    };
    try {
      if (navigator.userAgentData) {
        const h = await navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion', 'fullVersionList']);
        d.modelo = h.model || null; d.plataforma = h.platform || null; d.version_so = h.platformVersion || null;
        const b = (h.fullVersionList || []).find((x) => !/Not.?A.?Brand|Chromium/i.test(x.brand));
        if (b) d.navegador = `${b.brand} ${b.version.split('.')[0]}`;
      }
    } catch (e) { /* sin datos de alta entropía */ }
    if (!d.plataforma) {
      const m = /Android ([\d.]+)/.exec(ua) || /(iPhone|iPad).*OS ([\d_]+)/.exec(ua) || /(Windows NT) ([\d.]+)/.exec(ua) || /(Mac OS X) ([\d_]+)/.exec(ua);
      if (m) { d.plataforma = m.length === 2 ? 'Android' : m[1].replace('Windows NT', 'Windows').replace('Mac OS X', 'macOS'); d.version_so = (m[2] || m[1]).replace(/_/g, '.'); }
    }
    if (!d.modelo) { const m = /Android [\d.]+; ([^;)]+)\)/.exec(ua); if (m && m[1] !== 'K') d.modelo = m[1].trim(); }
    if (!d.navegador) { const m = /(Firefox|Edg|SamsungBrowser|Chrome|Safari)\/(\d+)/.exec(ua); if (m) d.navegador = `${m[1].replace('Edg', 'Edge')} ${m[2]}`; }
    const c = navigator.connection; if (c) d.red = [c.effectiveType, c.type].filter(Boolean).join(' / ') || null;
    cacheDisp = d; return d;
  }

  async function sha256(buf) {
    if (!crypto.subtle) return null;
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function offsetTxt(fecha) {
    const m = -fecha.getTimezoneOffset(), s = m >= 0 ? '+' : '-', a = Math.abs(m);
    return `UTC${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  }
  const dosDec = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });

  // ---------- sello ----------
  function estampar(ctx, w, h, lineas, derecha) {
    const f = Math.max(13, Math.round(Math.min(w, h * 1.4) * 0.024));
    const pad = Math.round(f * 0.75), alto = pad * 2 + lineas.length * f * 1.32;
    const y0 = h - alto;
    const g = ctx.createLinearGradient(0, y0 - f * 1.5, 0, h);
    g.addColorStop(0, 'rgba(10,16,24,0)'); g.addColorStop(0.18, 'rgba(10,16,24,.62)'); g.addColorStop(1, 'rgba(10,16,24,.82)');
    ctx.fillStyle = g; ctx.fillRect(0, y0 - f * 1.5, w, alto + f * 1.5);
    ctx.fillStyle = '#f2b705'; ctx.fillRect(0, y0, Math.max(4, Math.round(f * 0.28)), alto);
    ctx.textBaseline = 'top';
    const anchoDer = derecha.reduce((m, [t, b]) => { ctx.font = `${b ? 600 : 400} ${Math.round(f * 0.82)}px system-ui, sans-serif`; return Math.max(m, ctx.measureText(t).width); }, 0);
    const maxW = w - pad * 3 - anchoDer - f;
    lineas.forEach(([t, negrita], k) => {
      ctx.font = `${negrita ? 700 : 500} ${f}px system-ui, sans-serif`;
      let s = t; while (ctx.measureText(s).width > maxW && s.length > 4) s = s.slice(0, -2);
      if (s !== t) s = s.slice(0, -1) + '…';
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 3;
      ctx.fillStyle = negrita ? '#ffffff' : '#e6ecf2';
      ctx.fillText(s, pad + f * 0.4, y0 + pad + k * f * 1.32);
    });
    derecha.forEach(([t, negrita], k) => {
      ctx.font = `${negrita ? 600 : 400} ${Math.round(f * 0.82)}px system-ui, sans-serif`;
      ctx.fillStyle = negrita ? '#f2b705' : '#c9d3dd';
      ctx.fillText(t, w - pad - ctx.measureText(t).width, y0 + pad + k * f * 1.15);
    });
    ctx.shadowBlur = 0;
  }

  /**
   * ctx: { obra, item, inspector:{id,nombre}, gps (último del navegador o null), radio }
   */
  async function procesar(file, ctx) {
    const ahora = new Date();
    const buf = await file.arrayBuffer();
    const [exif, hash, disp, img] = await Promise.all([
      Promise.resolve(leerExif(buf)), sha256(buf), dispositivo(), createImageBitmap(file)
    ]);

    // GPS: el del navegador; si no hay, el de la cámara (EXIF)
    let gps = null;
    if (ctx.gps && !ctx.gps.error) gps = { ...ctx.gps, fuente: 'navegador' };
    else if (exif?.gps) gps = { lat: exif.gps.lat, lng: exif.gps.lng, prec: null, alt: exif.gps.altitud_m ?? null, fuente: 'cámara (EXIF)' };
    const o = ctx.obra;
    const dist = gps && o.lat != null ? ctx.distancia(gps.lat, gps.lng, o.lat, o.lng) : null;
    const tomaExif = fechaExif(exif?.fecha_toma);
    const reciente = tomaExif ? Math.abs(ahora - tomaExif) < 2 * 3600 * 1000 : (Math.abs(ahora - file.lastModified) < 2 * 3600 * 1000);
    const equipo = exif?.modelo
      ? ((exif.marca && !exif.modelo.toLowerCase().startsWith(exif.marca.toLowerCase())) ? `${exif.marca} ${exif.modelo}` : exif.modelo)
      : (disp.modelo || null);
    const so = [disp.plataforma, disp.version_so].filter(Boolean).join(' ');

    // imagen achicada
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g2 = c.getContext('2d'); g2.drawImage(img, 0, 0, w, h);

    const fechaTxt = ahora.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const huella = hash ? hash.slice(0, 10).toUpperCase() : null;
    estampar(g2, w, h, [
      [`${o.id_obra} · ${o.nombre}`, true],
      [`Ítem ${ctx.item.nro_item}: ${ctx.item.descripcion}`],
      [`${fechaTxt} (${offsetTxt(ahora)})${tomaExif && !reciente ? ' · ¡toma del ' + tomaExif.toLocaleDateString('es-AR') + '!' : ''}`],
      [gps ? `GPS ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}${gps.prec != null ? ' ±' + Math.round(gps.prec) + ' m' : ''}${gps.alt != null ? ' · alt. ' + Math.round(gps.alt) + ' m' : ''}${dist != null ? ' · a ' + dosDec(dist) + ' m de la obra' : ''}` : 'Sin ubicación GPS'],
      [[ctx.inspector.nombre, equipo, so].filter(Boolean).join(' · ')]
    ], [
      ['GdO · HydroGIS', true],
      [huella ? `Huella ${huella}` : ''],
      [dist != null && dist > ctx.radio ? 'REVISAR UBICACIÓN' : (gps ? 'Ubicación OK' : '')]
    ].filter(([t]) => t));

    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    const meta = {
      version: VERSION,
      captura: { fecha_hora: ahora.toISOString(), local: fechaTxt, utc: offsetTxt(ahora), zona_horaria: disp.zona_horaria },
      gps: gps ? {
        lat: +gps.lat.toFixed(7), lng: +gps.lng.toFixed(7), precision_m: gps.prec != null ? Math.round(gps.prec) : null,
        altitud_m: gps.alt != null ? Math.round(gps.alt) : null, precision_altitud_m: gps.altPrec != null ? Math.round(gps.altPrec) : null,
        rumbo_grados: gps.rumbo ?? null, velocidad_ms: gps.vel ?? null, fuente: gps.fuente,
        lectura: gps.ts ? new Date(gps.ts).toISOString() : null, antiguedad_s: gps.ts ? Math.round((ahora - gps.ts) / 1000) : null
      } : null,
      obra: { id_obra: o.id_obra, nombre: o.nombre, distancia_m: dist != null ? Math.round(dist) : null, radio_control_m: ctx.radio },
      item: { id_item: ctx.item.id_item, nro_item: ctx.item.nro_item, descripcion: ctx.item.descripcion },
      inspector: { id_usuario: ctx.inspector.id, nombre: ctx.inspector.nombre },
      dispositivo: { equipo, ...disp },
      exif,
      archivo_original: { nombre: file.name, tipo: file.type, tamano_bytes: file.size, ancho: img.width, alto: img.height,
        ultima_modificacion: file.lastModified ? new Date(file.lastModified).toISOString() : null, sha256: hash },
      archivo_guardado: { ancho: w, alto: h, tamano_bytes: blob.size, sello: true },
      controles: { foto_reciente: reciente, gps_disponible: !!gps, lejos_de_obra: dist != null ? dist > ctx.radio : null,
        gps_camara_vs_navegador_m: exif?.gps && ctx.gps && !ctx.gps.error ? Math.round(ctx.distancia(exif.gps.lat, exif.gps.lng, ctx.gps.lat, ctx.gps.lng)) : null }
    };
    img.close && img.close();
    return { blob, meta, avisos: [
      !gps && 'La foto no tiene ubicación GPS.',
      !reciente && 'La foto no parece recién tomada (fecha de la cámara distinta a la de hoy).',
      dist != null && dist > ctx.radio && `La foto está a ${dosDec(dist)} m de la obra: quedará marcada para revisar.`
    ].filter(Boolean) };
  }

  return { procesar, leerExif, dispositivo };
})();
