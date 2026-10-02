-- =====================================================================
-- GdO — Gestión de Obras Municipales (Frías)
-- 01_esquema.sql — tablas, restricciones y vistas calculadas
-- Correr en Supabase > SQL Editor, en orden: 01, 02, 03.
-- Se puede volver a correr: borra y recrea todo el esquema de la app.
-- =====================================================================

create extension if not exists postgis with schema extensions;

-- Limpieza (para poder re-ejecutar durante el prototipo)
drop view  if exists public.v_resumen, public.v_obras_publicas, public.v_certificados,
                     public.v_fotos, public.v_obras, public.v_items, public.v_mediciones cascade;
drop table if exists public.notificaciones, public.mediciones_historial, public.partes_diarios, public.certificados, public.fotos,
                     public.mediciones, public.items, public.obras, public.contratistas,
                     public.usuarios, public.catalogos, public.parametros cascade;
drop sequence if exists public.seq_obra, public.seq_item, public.seq_medicion,
                        public.seq_foto, public.seq_certificado, public.seq_parte cascade;

-- ---------------------------------------------------------------------
-- Parámetros y catálogos
-- ---------------------------------------------------------------------
create table public.parametros (
  clave        text primary key,
  valor_num    numeric,
  valor_fecha  date,
  nota         text
);
comment on table public.parametros is 'Supuestos editables: fondo de reparo, umbrales, tolerancias del semáforo.';

create table public.catalogos (
  categoria  text not null,   -- tipo_obra, subtipo, fuente, barrio, unidad, tipo_foto, area, rol...
  valor      text not null,
  orden      int  not null default 0,
  activo     boolean not null default true,
  primary key (categoria, valor)
);
comment on table public.catalogos is 'Listas de valores para los desplegables de la web y la app.';

-- ---------------------------------------------------------------------
-- Actores
-- ---------------------------------------------------------------------
create sequence public.seq_obra;
create sequence public.seq_item;
create sequence public.seq_medicion;
create sequence public.seq_foto;
create sequence public.seq_certificado;
create sequence public.seq_parte;

create table public.usuarios (
  id_usuario  text primary key,
  auth_uid    uuid unique references auth.users(id) on delete set null,  -- vínculo con el login de Supabase
  nombre      text not null,
  rol         text not null check (rol in (
                'Intendente','Secretario de Obras Públicas','Jefe de Servicios Públicos',
                'Inspector de obra','Contaduría','Administrador del sistema')),
  area        text,
  email       text,
  activo      boolean not null default true
);

create table public.contratistas (
  id_contratista  text primary key,
  razon_social    text not null,
  cuit            text,
  rubro           text,
  email           text,
  activo          boolean not null default true
);

-- ---------------------------------------------------------------------
-- Obra (tabla central)
-- ---------------------------------------------------------------------
create table public.obras (
  id_obra                text primary key default ('OB-' || lpad(nextval('public.seq_obra')::text, 3, '0')),
  nombre                 text not null,
  descripcion            text,
  tipo_obra              text not null,
  subtipo                text,
  modalidad              text not null check (modalidad in ('Contrato','Administración')),
  estado                 text not null default 'En proyecto' check (estado in (
                           'En proyecto','En licitación','Adjudicada','En ejecución',
                           'Paralizada','Finalizada','Recepción definitiva','Cancelada')),
  fuente_financiamiento  text,
  area_responsable       text,
  barrio                 text,
  direccion              text,
  geom                   extensions.geometry(Geometry, 4326),  -- punto, línea (calle) o polígono (plaza)
  expediente             text,
  contratista_id         text references public.contratistas(id_contratista),
  inspector_id           text references public.usuarios(id_usuario),
  fecha_inicio           date,
  plazo_dias             int check (plazo_dias > 0),
  beneficiarios          int,
  visible_publico        boolean not null default false,
  observaciones          text,
  creado_en              timestamptz not null default now(),
  actualizado_en         timestamptz not null default now()
);
create index obras_geom_idx on public.obras using gist (geom);

-- ---------------------------------------------------------------------
-- Ítems (cómputo y presupuesto)
-- ---------------------------------------------------------------------
create table public.items (
  id_item          text primary key default ('IT-' || lpad(nextval('public.seq_item')::text, 3, '0')),
  id_obra          text not null references public.obras(id_obra) on delete cascade,
  nro_item         int  not null,
  rubro            text,
  descripcion      text not null,
  unidad           text not null,
  cantidad         numeric(14,3) not null check (cantidad >= 0),
  precio_unitario  numeric(14,2) not null check (precio_unitario >= 0),
  subtotal         numeric(16,2) generated always as (cantidad * precio_unitario) stored,
  unique (id_obra, nro_item)
);
create index items_obra_idx on public.items (id_obra);

-- ---------------------------------------------------------------------
-- Mediciones (avance por ítem y período, las carga el inspector)
-- ---------------------------------------------------------------------
create table public.mediciones (
  id_medicion        text primary key default ('ME-' || lpad(nextval('public.seq_medicion')::text, 4, '0')),
  id_obra            text not null references public.obras(id_obra) on delete cascade,
  id_item            text not null references public.items(id_item) on delete cascade,
  periodo            text not null check (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fecha              date not null default current_date,
  cantidad_periodo   numeric(14,3) not null check (cantidad_periodo >= 0),
  inspector_id       text references public.usuarios(id_usuario),
  estado_validacion  text not null default 'Pendiente'
                     check (estado_validacion in ('Pendiente','Aprobada','Observada','Rechazada')),
  validado_por       text references public.usuarios(id_usuario),
  observaciones      text,
  creado_en          timestamptz not null default now()
);
create index mediciones_obra_idx on public.mediciones (id_obra, periodo);
create index mediciones_item_idx on public.mediciones (id_item);

-- El ítem tiene que ser de la misma obra
create or replace function public.chk_medicion_item()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.items i where i.id_item = new.id_item and i.id_obra = new.id_obra) then
    raise exception 'El ítem % no pertenece a la obra %', new.id_item, new.id_obra;
  end if;
  return new;
end $$;
create trigger trg_medicion_item before insert or update on public.mediciones
for each row execute function public.chk_medicion_item();

-- ---------------------------------------------------------------------
-- Fotos (georreferenciadas; el archivo va a Storage, bucket "fotos")
-- ---------------------------------------------------------------------
create table public.fotos (
  id_foto       text primary key default ('FO-' || lpad(nextval('public.seq_foto')::text, 4, '0')),
  id_obra       text not null references public.obras(id_obra) on delete cascade,
  id_medicion   text references public.mediciones(id_medicion) on delete set null,
  fecha_hora    timestamptz not null default now(),
  geom          extensions.geometry(Point, 4326),
  tipo_foto     text not null default 'Durante',
  archivo       text not null,          -- ruta dentro del bucket: OB-001/2026-06/ME-0001_0001.jpg
  descripcion   text,
  cargada_por   text references public.usuarios(id_usuario),
  validada      boolean not null default false
);
create index fotos_obra_idx on public.fotos (id_obra);

-- ---------------------------------------------------------------------
-- Certificados (solo obras por contrato)
-- ---------------------------------------------------------------------
create table public.certificados (
  id_certificado    text primary key default ('CE-' || lpad(nextval('public.seq_certificado')::text, 3, '0')),
  id_obra           text not null references public.obras(id_obra) on delete cascade,
  nro_certificado   int  not null,
  periodo           text not null check (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fecha_emision     date not null default current_date,
  estado            text not null default 'En revisión'
                    check (estado in ('En revisión','Aprobado','Liquidado','Pagado','Observado')),
  fecha_aprobacion  date,
  fecha_pago        date,
  orden_pago        text,
  unique (id_obra, nro_certificado),
  unique (id_obra, periodo)
);

create or replace function public.chk_certificado_contrato()
returns trigger language plpgsql set search_path = public as $$
begin
  if (select modalidad from public.obras where id_obra = new.id_obra) <> 'Contrato' then
    raise exception 'Solo las obras por contrato llevan certificados (obra %)', new.id_obra;
  end if;
  return new;
end $$;
create trigger trg_certificado_contrato before insert or update on public.certificados
for each row execute function public.chk_certificado_contrato();

-- ---------------------------------------------------------------------
-- Partes diarios (libro de obra, clave en obras por administración)
-- ---------------------------------------------------------------------
create table public.partes_diarios (
  id_parte        text primary key default ('PD-' || lpad(nextval('public.seq_parte')::text, 3, '0')),
  id_obra         text not null references public.obras(id_obra) on delete cascade,
  fecha           date not null default current_date,
  responsable_id  text references public.usuarios(id_usuario),
  personal_cant   int check (personal_cant >= 0),
  horas_hombre    numeric(8,1),
  maquinaria      text,
  materiales      text,
  tareas          text,
  clima           text,
  observaciones   text
);

-- ---------------------------------------------------------------------
-- actualizado_en automático en obras
-- ---------------------------------------------------------------------
create or replace function public.set_actualizado_en()
returns trigger language plpgsql set search_path = public as $$
begin new.actualizado_en := now(); return new; end $$;
create trigger trg_obras_actualizado before update on public.obras
for each row execute function public.set_actualizado_en();

-- =====================================================================
-- Helpers de parámetros
-- =====================================================================
create or replace function public.param(p_clave text)
returns numeric language sql stable security definer set search_path = public as $$
  select valor_num from public.parametros where clave = p_clave
$$;

-- security definer: el visor público las usa sin tener acceso a la tabla parametros.
-- Fecha de corte: si está cargada en parámetros se usa esa (demo), si no, hoy.
create or replace function public.fecha_corte()
returns date language sql stable security definer set search_path = public as $$
  select coalesce((select valor_fecha from public.parametros where clave = 'fecha_corte'), current_date)
$$;

-- =====================================================================
-- VISTAS (reemplazan las columnas grises/calculadas del Excel)
-- security_invoker = true → respetan la seguridad (RLS) del que consulta
-- =====================================================================

create view public.v_mediciones with (security_invoker = true) as
select m.*,
       i.descripcion      as item_descripcion,
       i.unidad,
       i.precio_unitario,
       round(m.cantidad_periodo * i.precio_unitario, 2) as monto
from public.mediciones m
join public.items i on i.id_item = m.id_item;

create view public.v_items with (security_invoker = true) as
with tot as (select id_obra, sum(subtotal) as total from public.items group by id_obra),
     med as (select id_item, sum(cantidad_periodo) as cant
             from public.mediciones where estado_validacion = 'Aprobada' group by id_item)
select i.*,
       case when t.total > 0 then i.subtotal / t.total else 0 end        as incidencia,
       coalesce(med.cant, 0)                                             as cant_medida_aprobada,
       case when i.cantidad > 0 then coalesce(med.cant,0) / i.cantidad else 0 end as avance_item,
       i.cantidad - coalesce(med.cant, 0)                                as saldo_cantidad
from public.items i
join tot t using (id_obra)
left join med using (id_item);

create view public.v_obras with (security_invoker = true) as
with pres as (select id_obra, sum(subtotal) as presupuesto from public.items group by id_obra),
     apr  as (select id_obra, sum(monto) as monto from public.v_mediciones
              where estado_validacion = 'Aprobada' group by id_obra),
     pen  as (select id_obra, count(*) as n from public.mediciones
              where estado_validacion = 'Pendiente' group by id_obra),
     pag  as (select c.id_obra, sum(vm.monto) as monto
              from public.certificados c
              join public.v_mediciones vm on vm.id_obra = c.id_obra and vm.periodo = c.periodo
                                         and vm.estado_validacion = 'Aprobada'
              where c.estado = 'Pagado' group by c.id_obra),
     fot  as (select id_obra, count(*) as n from public.fotos group by id_obra),
     base as (
       select o.*,
              extensions.st_y(extensions.st_pointonsurface(o.geom)) as lat,
              extensions.st_x(extensions.st_pointonsurface(o.geom)) as lng,
              case when o.fecha_inicio is not null and o.plazo_dias is not null
                   then o.fecha_inicio + o.plazo_dias end            as fecha_fin_prevista,
              coalesce(pres.presupuesto, 0)                           as presupuesto,
              coalesce(apr.monto, 0)                                  as monto_medido_aprobado,
              case when coalesce(pres.presupuesto,0) = 0 then 0
                   else coalesce(apr.monto,0) / pres.presupuesto end  as avance_fisico,
              case when o.fecha_inicio is null or o.fecha_inicio > public.fecha_corte() then null
                   else least(1, greatest(0, (public.fecha_corte() - o.fecha_inicio)::numeric / o.plazo_dias))
              end                                                     as avance_previsto,
              coalesce(pag.monto, 0)                                  as monto_pagado,
              coalesce(fot.n, 0)                                      as cant_fotos,
              coalesce(pen.n, 0)                                      as mediciones_pendientes
       from public.obras o
       left join pres using (id_obra)
       left join apr  using (id_obra)
       left join pen  using (id_obra)
       left join pag  using (id_obra)
       left join fot  using (id_obra))
select b.*,
       case when b.presupuesto < public.param('umbral_menor') then 'Menor'
            when b.presupuesto < public.param('umbral_mayor') then 'Mediana'
            else 'Mayor' end                                          as escala,
       b.avance_fisico - b.avance_previsto                            as desvio,
       case when b.estado = 'Paralizada' then 'Rojo'
            when b.estado in ('Finalizada','Recepción definitiva') then 'Verde'
            when b.avance_previsto is null then 'Sin iniciar'
            when b.avance_fisico - b.avance_previsto < public.param('tolerancia_rojo')     then 'Rojo'
            when b.avance_fisico - b.avance_previsto < public.param('tolerancia_amarillo') then 'Amarillo'
            else 'Verde' end                                          as semaforo,
       case when b.modalidad = 'Administración' or b.presupuesto = 0 then null
            else b.monto_pagado / b.presupuesto end                   as avance_financiero
from base b;

create view public.v_fotos with (security_invoker = true) as
select f.*,
       m.periodo,
       extensions.st_y(f.geom) as lat,
       extensions.st_x(f.geom) as lng,
       round(extensions.st_distance(f.geom::extensions.geography, o.geom::extensions.geography)::numeric, 0) as distancia_obra_m,
       case when f.geom is null or o.geom is null then null
            when extensions.st_distance(f.geom::extensions.geography, o.geom::extensions.geography)
                 > public.param('radio_foto_m') then 'REVISAR'
            else 'OK' end as control_ubicacion
from public.fotos f
join public.obras o on o.id_obra = f.id_obra
left join public.mediciones m on m.id_medicion = f.id_medicion;

create view public.v_certificados with (security_invoker = true) as
with bruto as (
  select c.id_certificado, coalesce(sum(vm.monto), 0) as monto_bruto
  from public.certificados c
  left join public.v_mediciones vm on vm.id_obra = c.id_obra and vm.periodo = c.periodo
                                  and vm.estado_validacion = 'Aprobada'
  group by c.id_certificado),
fot as (
  select c.id_certificado, count(f.*) as n
  from public.certificados c
  left join public.v_fotos f on f.id_obra = c.id_obra and f.periodo = c.periodo
  group by c.id_certificado)
select c.*,
       b.monto_bruto,
       round(b.monto_bruto * public.param('fondo_reparo'), 2)              as fondo_reparo,
       b.monto_bruto - round(b.monto_bruto * public.param('fondo_reparo'), 2) as monto_neto,
       f.n                                                                 as fotos_respaldo,
       case when f.n > 0 then 'OK' else 'FALTAN FOTOS' end                 as control_respaldo,
       sum(b.monto_bruto) over (partition by c.id_obra order by c.nro_certificado)
         / nullif((select sum(subtotal) from public.items i where i.id_obra = c.id_obra), 0)
                                                                           as avance_acumulado_obra
from public.certificados c
join bruto b using (id_certificado)
join fot   f using (id_certificado);

-- Tablero: una fila con los indicadores de la hoja Resumen
create view public.v_resumen with (security_invoker = true) as
select
  (select count(*) from public.v_obras)                                        as obras_registradas,
  (select count(*) from public.v_obras where estado = 'En ejecución')          as obras_en_ejecucion,
  (select count(*) from public.v_obras where estado = 'Paralizada')            as obras_paralizadas,
  (select count(*) from public.v_obras where semaforo = 'Rojo')                as obras_semaforo_rojo,
  (select coalesce(sum(presupuesto),0) from public.v_obras)                    as presupuesto_total,
  (select coalesce(sum(monto_medido_aprobado),0) from public.v_obras)          as monto_medido_aprobado,
  (select coalesce(sum(monto_pagado),0) from public.v_obras)                   as monto_pagado,
  (select count(*) from public.v_certificados where control_respaldo = 'FALTAN FOTOS') as certificados_sin_fotos,
  (select count(*) from public.v_fotos where control_ubicacion = 'REVISAR')    as fotos_a_revisar,
  (select count(*) from public.mediciones where estado_validacion = 'Pendiente') as mediciones_pendientes,
  public.fecha_corte()                                                          as fecha_corte;

-- Visor público: solo obras publicadas y solo campos públicos (sin montos de certificados).
-- Es la ÚNICA puerta para el usuario anónimo. Corre con permisos del dueño (no security_invoker)
-- para poder calcular el avance sin darle acceso a mediciones.
create view public.v_obras_publicas as
with pres as (select id_obra, sum(subtotal) as presupuesto from public.items group by id_obra),
     apr  as (select m.id_obra, sum(m.cantidad_periodo * i.precio_unitario) as monto
              from public.mediciones m join public.items i on i.id_item = m.id_item
              where m.estado_validacion = 'Aprobada' group by m.id_obra)
select o.id_obra, o.nombre, o.descripcion, o.tipo_obra, o.subtipo, o.modalidad, o.estado,
       o.fuente_financiamiento, o.area_responsable, o.barrio, o.direccion,
       extensions.st_asgeojson(o.geom)::json                  as geojson,
       extensions.st_y(extensions.st_pointonsurface(o.geom))  as lat,
       extensions.st_x(extensions.st_pointonsurface(o.geom))  as lng,
       o.fecha_inicio, o.plazo_dias,
       case when o.fecha_inicio is not null then o.fecha_inicio + o.plazo_dias end as fecha_fin_prevista,
       coalesce(pres.presupuesto, 0)                           as presupuesto,
       case when coalesce(pres.presupuesto,0) < public.param('umbral_menor') then 'Menor'
            when pres.presupuesto < public.param('umbral_mayor') then 'Mediana'
            else 'Mayor' end                                   as escala,
       case when coalesce(pres.presupuesto,0) = 0 then 0
            else round(coalesce(apr.monto,0) / pres.presupuesto, 4) end as avance_fisico,
       o.beneficiarios,
       c.razon_social                                          as contratista
from public.obras o
left join pres using (id_obra)
left join apr  using (id_obra)
left join public.contratistas c on c.id_contratista = o.contratista_id
where o.visible_publico;
