-- =====================================================================
-- GdO — 05_notificaciones_y_auditoria.sql
-- Correr en Supabase > SQL Editor DESPUÉS de 01, 02, 03 (y 04).
-- Se puede correr más de una vez: no borra datos.
--
-- Agrega:
--  1. fotos.metadatos (jsonb): GPS completo, dispositivo, EXIF, huella digital del archivo original.
--  2. Historial de validaciones de cada medición (quién cambió qué y cuándo).
--  3. Cambiar una decisión ya tomada (Aprobada ↔ Observada ↔ Pendiente), salvo que el
--     certificado de ese mes ya esté Liquidado o Pagado.
--  4. El inspector puede corregir y reenviar una medición Observada (vuelve a Pendiente).
--  5. Notificaciones para inspectores y validadores, generadas automáticamente por la base.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Metadatos de foto
-- ---------------------------------------------------------------------
alter table public.fotos add column if not exists metadatos jsonb;
comment on column public.fotos.metadatos is 'Datos de captura: GPS (precisión, altitud), fecha/hora y zona, dispositivo, EXIF y SHA-256 del archivo original.';

-- ---------------------------------------------------------------------
-- 2. Historial de validaciones
-- ---------------------------------------------------------------------
create table if not exists public.mediciones_historial (
  id               bigserial primary key,
  id_medicion      text not null references public.mediciones(id_medicion) on delete cascade,
  estado_anterior  text,
  estado_nuevo     text not null,
  actor            text references public.usuarios(id_usuario),
  observacion      text,
  creado_en        timestamptz not null default now()
);
create index if not exists mediciones_historial_med_idx on public.mediciones_historial (id_medicion, creado_en);

-- ---------------------------------------------------------------------
-- 5. Notificaciones (tabla)
-- ---------------------------------------------------------------------
create table if not exists public.notificaciones (
  id            bigserial primary key,
  destinatario  text not null references public.usuarios(id_usuario) on delete cascade,
  tipo          text not null,      -- medicion_nueva, medicion_reenviada, decision, obra_asignada, obra_estado, foto_lejos
  titulo        text not null,
  mensaje       text,
  id_obra       text references public.obras(id_obra) on delete cascade,
  id_medicion   text references public.mediciones(id_medicion) on delete cascade,
  actor         text references public.usuarios(id_usuario),
  leido         boolean not null default false,
  creado_en     timestamptz not null default now()
);
create index if not exists notificaciones_dest_idx on public.notificaciones (destinatario, leido, creado_en desc);

-- Número con formato argentino (1.234,5) para los mensajes
create or replace function public.fmt_num(n numeric)
returns text language sql immutable as $$
  select replace(replace(replace(rtrim(to_char(round(n, 2), 'FM999,999,999,990.99'), '.'), ',', '#'), '.', ','), '#', '.')
$$;

-- Destinatarios: validadores del área de la obra (si no hay, todos los validadores)
create or replace function public.validadores_de(p_obra text)
returns setof text language sql stable security definer set search_path = public as $$
  with v as (
    select u.id_usuario, u.area from public.usuarios u
    where u.activo and u.rol in ('Secretario de Obras Públicas', 'Jefe de Servicios Públicos'))
  select id_usuario from v where area = (select area_responsable from public.obras where id_obra = p_obra)
  union
  select id_usuario from v where not exists (
    select 1 from v where area = (select area_responsable from public.obras where id_obra = p_obra))
$$;

create or replace function public.notificar(p_dest text, p_tipo text, p_titulo text, p_mensaje text,
                                            p_obra text, p_medicion text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_dest is null or p_dest = public.mi_usuario() then return; end if;  -- no se notifica a uno mismo
  insert into public.notificaciones (destinatario, tipo, titulo, mensaje, id_obra, id_medicion, actor)
  values (p_dest, p_tipo, p_titulo, p_mensaje, p_obra, p_medicion, public.mi_usuario());
end $$;

-- ---------------------------------------------------------------------
-- 3 y 2. Control de cambios de estado de una medición
-- ---------------------------------------------------------------------
create or replace function public.chk_cambio_validacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cert text;
begin
  if new.estado_validacion is distinct from old.estado_validacion
     or new.cantidad_periodo is distinct from old.cantidad_periodo then
    select estado into v_cert from public.certificados
     where id_obra = old.id_obra and periodo = old.periodo and estado in ('Liquidado', 'Pagado');
    if v_cert is not null then
      raise exception 'No se puede modificar la medición %: el certificado de % ya está %.', old.id_medicion, old.periodo, v_cert
        using errcode = 'P0001';
    end if;
  end if;
  if new.estado_validacion = 'Pendiente' then new.validado_por := null; end if;
  return new;
end $$;
drop trigger if exists trg_cambio_validacion on public.mediciones;
create trigger trg_cambio_validacion before update on public.mediciones
for each row execute function public.chk_cambio_validacion();

-- Después de insertar / actualizar: historial + notificaciones
create or replace function public.post_medicion()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_obra text; v_item text; v_insp text; v_dest text; v_txt text;
begin
  select nombre into v_obra from public.obras where id_obra = new.id_obra;
  select descripcion into v_item from public.items where id_item = new.id_item;
  select nombre into v_insp from public.usuarios where id_usuario = new.inspector_id;

  if tg_op = 'INSERT' then
    insert into public.mediciones_historial (id_medicion, estado_anterior, estado_nuevo, actor, observacion)
    values (new.id_medicion, null, new.estado_validacion, public.mi_usuario(), 'Carga');
    for v_dest in select * from public.validadores_de(new.id_obra) loop
      perform public.notificar(v_dest, 'medicion_nueva',
        'Nueva medición para validar',
        format('%s cargó %s %s de "%s" en %s (%s).', coalesce(v_insp, new.inspector_id),
               public.fmt_num(new.cantidad_periodo),
               (select unidad from public.items where id_item = new.id_item), v_item, v_obra, new.periodo),
        new.id_obra, new.id_medicion);
    end loop;
    return new;
  end if;

  if new.estado_validacion is distinct from old.estado_validacion then
    insert into public.mediciones_historial (id_medicion, estado_anterior, estado_nuevo, actor, observacion)
    values (new.id_medicion, old.estado_validacion, new.estado_validacion, public.mi_usuario(),
            case when new.observaciones is distinct from old.observaciones then new.observaciones end);

    if new.estado_validacion = 'Pendiente' and public.mi_usuario() = new.inspector_id then
      -- el inspector corrigió y reenvió
      for v_dest in select * from public.validadores_de(new.id_obra) loop
        perform public.notificar(v_dest, 'medicion_reenviada', 'Medición corregida y reenviada',
          format('%s corrigió la medición %s de "%s" en %s.', coalesce(v_insp, new.inspector_id), new.id_medicion, v_item, v_obra),
          new.id_obra, new.id_medicion);
      end loop;
    else
      v_txt := case new.estado_validacion
        when 'Aprobada'  then 'Medición aprobada'
        when 'Observada' then 'Medición observada'
        when 'Rechazada' then 'Medición rechazada'
        else 'Medición vuelta a pendiente' end;
      if old.estado_validacion <> 'Pendiente' then v_txt := v_txt || ' (decisión modificada)'; end if;
      perform public.notificar(new.inspector_id, 'decision', v_txt,
        format('%s — "%s" en %s (%s).%s', new.id_medicion, v_item, v_obra, new.periodo,
               case when new.estado_validacion in ('Observada', 'Rechazada') and new.observaciones is not null
                    then ' Motivo: ' || new.observaciones else '' end),
        new.id_obra, new.id_medicion);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_post_medicion on public.mediciones;
create trigger trg_post_medicion after insert or update on public.mediciones
for each row execute function public.post_medicion();

-- Obras: aviso al inspector cuando se le asigna una obra o cambia su estado
create or replace function public.post_obra()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.inspector_id is not null and (tg_op = 'INSERT' or new.inspector_id is distinct from old.inspector_id) then
    perform public.notificar(new.inspector_id, 'obra_asignada', 'Te asignaron una obra',
      format('%s — %s (%s).', new.id_obra, new.nombre, new.estado), new.id_obra, null);
  elsif tg_op = 'UPDATE' and new.estado is distinct from old.estado then
    perform public.notificar(new.inspector_id, 'obra_estado', 'Cambió el estado de una obra',
      format('%s — %s pasó de %s a %s.%s', new.id_obra, new.nombre, old.estado, new.estado,
             case when new.observaciones is not null and new.estado = 'Paralizada' then ' ' || new.observaciones else '' end),
      new.id_obra, null);
  end if;
  return new;
end $$;
drop trigger if exists trg_post_obra on public.obras;
create trigger trg_post_obra after insert or update on public.obras
for each row execute function public.post_obra();

-- Fotos: aviso a validadores si se tomó lejos de la obra
create or replace function public.post_foto()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_dist numeric; v_obra text; v_dest text;
begin
  select round(extensions.st_distance(new.geom::extensions.geography, o.geom::extensions.geography)::numeric), o.nombre
    into v_dist, v_obra
    from public.obras o where o.id_obra = new.id_obra and new.geom is not null and o.geom is not null;
  if v_dist is not null and v_dist > coalesce(public.param('radio_foto_m'), 200) then
    for v_dest in select * from public.validadores_de(new.id_obra) loop
      perform public.notificar(v_dest, 'foto_lejos', 'Foto tomada lejos de la obra',
        format('%s: foto %s a %s m del punto de la obra (%s).', v_obra, new.id_foto,
               public.fmt_num(v_dist), coalesce(new.id_medicion, 'sin medición')),
        new.id_obra, new.id_medicion);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_post_foto on public.fotos;
create trigger trg_post_foto after insert on public.fotos
for each row execute function public.post_foto();

-- ---------------------------------------------------------------------
-- 4. El inspector puede corregir mediciones Pendientes u Observadas (vuelven a Pendiente)
-- ---------------------------------------------------------------------
drop policy if exists inspector_corrige on public.mediciones;
create policy inspector_corrige on public.mediciones for update to authenticated
  using (public.tengo_rol('Inspector de obra') and inspector_id = public.mi_usuario()
         and estado_validacion in ('Pendiente', 'Observada'))
  with check (inspector_id = public.mi_usuario() and estado_validacion = 'Pendiente');

-- ---------------------------------------------------------------------
-- Seguridad de las tablas nuevas
-- ---------------------------------------------------------------------
alter table public.notificaciones enable row level security;
alter table public.mediciones_historial enable row level security;

drop policy if exists propias on public.notificaciones;
create policy propias on public.notificaciones for select to authenticated
  using (destinatario = public.mi_usuario());
drop policy if exists marcar_leida on public.notificaciones;
create policy marcar_leida on public.notificaciones for update to authenticated
  using (destinatario = public.mi_usuario()) with check (destinatario = public.mi_usuario());

drop policy if exists lectura_interna on public.mediciones_historial;
create policy lectura_interna on public.mediciones_historial for select to authenticated
  using (public.mi_rol() is not null);

revoke all on public.notificaciones, public.mediciones_historial from anon;
grant select on public.notificaciones, public.mediciones_historial to authenticated;
grant update (leido) on public.notificaciones to authenticated;
revoke execute on function public.notificar(text, text, text, text, text, text) from public, anon, authenticated;

-- Historial inicial para las mediciones que ya existían (una sola vez)
insert into public.mediciones_historial (id_medicion, estado_anterior, estado_nuevo, actor, observacion, creado_en)
select m.id_medicion, null, m.estado_validacion, coalesce(m.validado_por, m.inspector_id), 'Dato inicial', m.creado_en
from public.mediciones m
where not exists (select 1 from public.mediciones_historial h where h.id_medicion = m.id_medicion);

-- Control: tiene que devolver 4 filas con "ok"
select 'fotos.metadatos' as que, 'ok' from information_schema.columns where table_name = 'fotos' and column_name = 'metadatos'
union all select 'notificaciones', 'ok' from information_schema.tables where table_name = 'notificaciones'
union all select 'historial', 'ok' from information_schema.tables where table_name = 'mediciones_historial'
union all select 'triggers', 'ok' where (select count(*) from pg_trigger where tgname in ('trg_post_medicion','trg_post_obra','trg_post_foto','trg_cambio_validacion')) = 4;
