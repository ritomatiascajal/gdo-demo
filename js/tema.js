// Tema claro / oscuro compartido por el tablero y la app del inspector.
// Guarda la elección en el navegador; si no hay elección, sigue la del sistema.
(() => {
  const raiz = document.documentElement;
  const actual = () => raiz.getAttribute('data-theme') || 'light';
  function pintarBotones() {
    document.querySelectorAll('[data-tema]').forEach((b) => {
      const oscuro = actual() === 'dark';
      b.textContent = oscuro ? '☀' : '☾';
      b.title = oscuro ? 'Pasar a modo claro' : 'Pasar a modo oscuro';
    });
  }
  function aplicar(t) {
    raiz.setAttribute('data-theme', t);
    try { localStorage.setItem('gdo-tema', t); } catch (e) { /* sin almacenamiento: solo esta visita */ }
    pintarBotones();
    document.dispatchEvent(new CustomEvent('tema', { detail: t }));
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tema]')) aplicar(actual() === 'dark' ? 'light' : 'dark');
  });
  window.GDO_TEMA = { actual, aplicar };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pintarBotones); else pintarBotones();
})();
