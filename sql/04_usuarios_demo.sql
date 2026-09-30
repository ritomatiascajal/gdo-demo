-- =====================================================================
-- GdO — 04_usuarios_demo.sql — vincular logins de prueba con roles
--
-- Paso previo (a mano, en Supabase):
--   Authentication > Users > Add user > Create new user
--   Crear 3 usuarios con "Auto Confirm User" tildado. Tip: con Gmail podés
--   usar alias de tu propia casilla, p. ej. tucorreo+secretario@gmail.com,
--   tucorreo+inspector@gmail.com, tucorreo+admin@gmail.com (llegan todos a tu bandeja).
--
-- Después reemplazá los emails de abajo y corré este script.
-- =====================================================================

update public.usuarios u set auth_uid = a.id, email = a.email
from auth.users a
where (u.id_usuario, lower(a.email)) in (
  ('US-02', lower('REEMPLAZAR+secretario@gmail.com')),  -- Secretario de Obras Públicas (valida, emite certificados)
  ('US-04', lower('REEMPLAZAR+inspector@gmail.com')),   -- Inspector 1 (carga mediciones y fotos)
  ('US-08', lower('REEMPLAZAR+admin@gmail.com'))        -- Administrador del sistema
);

-- Control: tiene que devolver 3 filas con auth_uid cargado
select id_usuario, nombre, rol, email, auth_uid is not null as vinculado
from public.usuarios where auth_uid is not null;
