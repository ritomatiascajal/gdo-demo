/* GdO — notificaciones (compartido por el tablero y la app del inspector)
 * Las genera la base (triggers del script 05). Acá solo se leen, se cuentan y se marcan como leídas.
 * Si la base todavía no tiene la tabla (script 05 sin correr), el módulo se apaga sin romper nada.
 */
window.GDO_NOTIF = (() => {
  const TIPOS = {
    medicion_nueva:     ['＋', '#2f6fae', 'Nueva medición'],
    medicion_reenviada: ['↻', '#2f6fae', 'Reenviada'],
    decision:           ['✓', '#2e8b57', 'Decisión'],
    obra_asignada:      ['⚑', '#7a5cc4', 'Asignación'],
    obra_estado:        ['⚑', '#d69e00', 'Estado de obra'],
    foto_lejos:         ['⌖', '#c0392b', 'Ubicación']
  };
  let sb = null, yo = null, timer = null, items = [], disponible = true, primera = true;
  const oyentes = new Set();

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function hace(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    if (s < 7 * 86400) return `hace ${Math.floor(s / 86400)} d`;
    return new Date(iso).toLocaleDateString('es-AR');
  }
  const avisar = (nuevas = []) => oyentes.forEach((f) => f({ items, noLeidas: items.filter((n) => !n.leido).length, disponible, nuevas }));

  async function cargar() {
    if (!sb || !yo || !disponible) return;
    const { data, error } = await sb.from('notificaciones')
      .select('id,tipo,titulo,mensaje,id_obra,id_medicion,leido,creado_en')
      .eq('destinatario', yo).order('creado_en', { ascending: false }).limit(60);
    if (error) {
      // 42P01 / PGRST205: la tabla no existe todavía → se oculta la campana
      if (/42P01|PGRST20[45]|notificaciones|schema cache/i.test(`${error.code} ${error.message}`)) { disponible = false; avisar(); }
      return;
    }
    const antes = new Set(items.map((n) => n.id));
    const nuevas = primera ? [] : data.filter((n) => !antes.has(n.id) && !n.leido);
    items = data; primera = false; avisar(nuevas);
  }

  function iniciar(cliente, idUsuario) {
    detener(); sb = cliente; yo = idUsuario; disponible = true; primera = true; items = [];
    if (!yo) { avisar(); return; }
    cargar();
    timer = setInterval(() => { if (document.visibilityState === 'visible') cargar(); }, 40000);
  }
  function detener() { clearInterval(timer); timer = null; yo = null; items = []; avisar(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') cargar(); });

  async function marcar(ids) {
    if (!ids.length) return;
    items.forEach((n) => { if (ids.includes(n.id)) n.leido = true; }); avisar();
    for (const id of ids) await sb.from('notificaciones').update({ leido: true }).eq('id', id);
  }
  async function marcarTodas() {
    const ids = items.filter((n) => !n.leido).map((n) => n.id);
    if (!ids.length) return;
    items.forEach((n) => { n.leido = true; }); avisar();
    await sb.from('notificaciones').update({ leido: true }).eq('destinatario', yo).eq('leido', false);
  }

  // HTML de la lista (lo usan las dos interfaces)
  function lista(soloNoLeidas = false) {
    const l = soloNoLeidas ? items.filter((n) => !n.leido) : items;
    if (!disponible) return '<p class="notif-vacio">Las notificaciones se activan al actualizar la base (script 05).</p>';
    if (!l.length) return '<p class="notif-vacio">No hay novedades por ahora.</p>';
    return `<ul class="notif-lista">${l.map((n, k) => {
      const [ico, color, etq] = TIPOS[n.tipo] || ['•', '#8a9099', 'Aviso'];
      return `<li class="notif${n.leido ? '' : ' nueva'}" data-id="${n.id}" data-obra="${esc(n.id_obra || '')}" style="--i:${Math.min(k, 12)}">
        <span class="notif-ico" style="background:${color}">${ico}</span>
        <div class="notif-txt"><div class="notif-tit">${esc(n.titulo)}</div>
          <div class="notif-msg">${esc(n.mensaje || '')}</div>
          <div class="notif-meta">${esc(etq)} · ${hace(n.creado_en)}</div></div>
      </li>`; }).join('')}</ul>`;
  }

  return {
    iniciar, detener, cargar, marcar, marcarTodas, lista,
    escuchar: (f) => { oyentes.add(f); return () => oyentes.delete(f); },
    get noLeidas() { return items.filter((n) => !n.leido).length; },
    get disponible() { return disponible; }
  };
})();
