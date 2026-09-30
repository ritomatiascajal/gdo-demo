-- =====================================================================
-- GdO — 03_seguridad.sql — roles, permisos (RLS) y almacenamiento de fotos
-- Traduce la hoja Roles_Permisos del Excel. Correr después de 02.
--
-- Cómo funciona:
--  * Cada persona entra con su email (Supabase Auth). La tabla usuarios
--    vincula ese login (auth_uid) con su rol en el municipio.
--  * Sin fila en usuarios = no ve nada interno, aunque tenga login.
--  * El vecino (sin login, rol "anon") solo puede leer v_obras_publicas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers: quién soy y qué rol tengo
-- ---------------------------------------------------------------------
create or replace function public.mi_usuario()
returns text language sql stable security definer set search_path = public as $$
  select id_usuario from public.usuarios where auth_uid = auth.uid() and activo
$$;

create or replace function public.mi_rol()
returns text language sql stable security definer set search_path = public as $$
  select rol from public.usuarios where auth_uid = auth.uid() and activo
$$;

create or replace function public.tengo_rol(variadic roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.mi_rol() = any(roles), false)
$$;

-- ---------------------------------------------------------------------
-- Permisos base: el anónimo no toca tablas; el logueado pasa por RLS
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;
grant  select on public.v_obras_publicas to anon;
grant  execute on function public.param(text), public.fecha_corte() to anon;  -- las usa el visor público

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
grant execute on function public.mi_usuario(), public.mi_rol(), public.tengo_rol(text[]),
                          public.param(text), public.fecha_corte() to authenticated;

-- Activar RLS en todas las tablas
alter table public.parametros     enable row level security;
alter table public.catalogos      enable row level security;
alter table public.usuarios       enable row level security;
alter table public.contratistas   enable row level security;
alter table public.obras          enable row level security;
alter table public.items          enable row level security;
alter table public.mediciones     enable row level security;
alter table public.fotos          enable row level security;
alter table public.certificados   enable row level security;
alter table public.partes_diarios enable row level security;

-- ---------------------------------------------------------------------
-- LECTURA: cualquier usuario interno activo ve todo (mapa, tablero, montos).
-- Pendiente con el cliente: si el inspector ve solo sus obras.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['parametros','catalogos','usuarios','contratistas','obras','items',
                           'mediciones','fotos','certificados','partes_diarios'] loop
    execute format('drop policy if exists lectura_interna on public.%I', t);
    execute format('create policy lectura_interna on public.%I for select to authenticated
                    using (public.mi_rol() is not null)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- ESCRITURA por rol (según hoja Roles_Permisos)
-- ---------------------------------------------------------------------

-- Administración de usuarios, catálogos y parámetros: Administrador del sistema
create policy admin_escribe on public.usuarios   for all to authenticated
  using (public.tengo_rol('Administrador del sistema')) with check (public.tengo_rol('Administrador del sistema'));
create policy admin_escribe on public.catalogos  for all to authenticated
  using (public.tengo_rol('Administrador del sistema')) with check (public.tengo_rol('Administrador del sistema'));
create policy admin_escribe on public.parametros for all to authenticated
  using (public.tengo_rol('Administrador del sistema')) with check (public.tengo_rol('Administrador del sistema'));

-- Contratistas: Secretario OO.PP. y Admin
create policy gestion_escribe on public.contratistas for all to authenticated
  using (public.tengo_rol('Secretario de Obras Públicas','Administrador del sistema'))
  with check (public.tengo_rol('Secretario de Obras Públicas','Administrador del sistema'));

-- Crear / editar obra y cargar ítems: Secretario, Jefe SSPP, Admin
create policy gestion_escribe on public.obras for all to authenticated
  using (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos','Administrador del sistema'))
  with check (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos','Administrador del sistema'));
create policy gestion_escribe on public.items for all to authenticated
  using (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos','Administrador del sistema'))
  with check (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos','Administrador del sistema'));

-- Mediciones:
--  * el inspector carga las suyas, siempre en estado Pendiente, y puede corregirlas mientras sigan Pendientes
--  * Secretario y Jefe SSPP validan (Aprobada / Observada / Rechazada)
create policy inspector_carga on public.mediciones for insert to authenticated
  with check (public.tengo_rol('Inspector de obra')
              and inspector_id = public.mi_usuario()
              and estado_validacion = 'Pendiente' and validado_por is null);
create policy inspector_corrige on public.mediciones for update to authenticated
  using (public.tengo_rol('Inspector de obra') and inspector_id = public.mi_usuario()
         and estado_validacion = 'Pendiente')
  with check (inspector_id = public.mi_usuario() and estado_validacion = 'Pendiente');
create policy validador on public.mediciones for update to authenticated
  using (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos'))
  with check (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos')
              and (estado_validacion = 'Pendiente' or validado_por = public.mi_usuario()));

-- Fotos: el inspector sube; los validadores marcan "validada"
create policy inspector_sube on public.fotos for insert to authenticated
  with check (public.tengo_rol('Inspector de obra') and cargada_por = public.mi_usuario());
create policy validador on public.fotos for update to authenticated
  using (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos'))
  with check (public.tengo_rol('Secretario de Obras Públicas','Jefe de Servicios Públicos'));

-- Partes diarios: Inspector y Jefe SSPP
create policy carga_parte on public.partes_diarios for insert to authenticated
  with check (public.tengo_rol('Inspector de obra','Jefe de Servicios Públicos')
              and responsable_id = public.mi_usuario());
create policy corrige_parte on public.partes_diarios for update to authenticated
  using (responsable_id = public.mi_usuario())
  with check (responsable_id = public.mi_usuario());

-- Certificados:
--  * emite el Secretario (queda En revisión)
--  * aprueban Intendente y Secretario
--  * Contaduría liquida y registra el pago
create policy emite on public.certificados for insert to authenticated
  with check (public.tengo_rol('Secretario de Obras Públicas') and estado = 'En revisión');
create policy circuito on public.certificados for update to authenticated
  using (public.tengo_rol('Intendente','Secretario de Obras Públicas','Contaduría'))
  with check (
       (public.tengo_rol('Intendente','Secretario de Obras Públicas') and estado in ('En revisión','Aprobado','Observado'))
    or (public.tengo_rol('Contaduría') and estado in ('Aprobado','Liquidado','Pagado','Observado')));

-- ---------------------------------------------------------------------
-- Almacenamiento de fotos (bucket privado "fotos")
-- Ruta del archivo: OB-001/2026-06/ME-0001_0001.jpg
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('fotos', 'fotos', false)
on conflict (id) do nothing;

drop policy if exists "gdo fotos lectura interna" on storage.objects;
drop policy if exists "gdo fotos sube inspector"  on storage.objects;

create policy "gdo fotos lectura interna" on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and public.mi_rol() is not null);
create policy "gdo fotos sube inspector" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and public.tengo_rol('Inspector de obra'));
