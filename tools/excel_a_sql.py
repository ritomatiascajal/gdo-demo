"""Genera sql/02_datos_ejemplo.sql a partir de Modelo_Gestion_Obras_Frias.xlsx.
Uso: python tools/excel_a_sql.py modelo.xlsx sql/02_datos_ejemplo.sql
Solo toma las columnas de carga (encabezado azul); las calculadas las resuelven las vistas.
"""
import sys, datetime, openpyxl

xlsx, salida = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(xlsx)


def q(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, datetime.datetime):
        return f"'{v:%Y-%m-%d %H:%M}'" if (v.hour or v.minute) else f"'{v:%Y-%m-%d}'"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def si(v):
    return "true" if v == "Sí" else "false"


def filas(hoja):
    ws = wb[hoja]
    head = [c.value for c in ws[1]]
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[0] is None:
            continue
        yield dict(zip(head, r))


def insert(tabla, cols, valores):
    out = [f"insert into public.{tabla} ({', '.join(cols)}) values"]
    out.append(",\n".join("  (" + ", ".join(v) + ")" for v in valores) + ";")
    return "\n".join(out)


sql = ["-- =====================================================================",
       "-- GdO — 02_datos_ejemplo.sql — datos FICTICIOS del Excel modelo",
       "-- Generado por tools/excel_a_sql.py. Correr después de 01_esquema.sql.",
       "-- =====================================================================",
       "begin;", ""]

# Parámetros
p = {r["Parámetro"]: r for r in filas("Parametros")}
claves = {
    "Fecha de corte del reporte": "fecha_corte",
    "Fondo de reparo (%)": "fondo_reparo",
    "Umbral obra menor (hasta $)": "umbral_menor",
    "Umbral obra mayor (desde $)": "umbral_mayor",
    "Tolerancia desvío amarillo": "tolerancia_amarillo",
    "Tolerancia desvío rojo": "tolerancia_rojo",
    "Radio control foto-obra (m)": "radio_foto_m",
}
vals = []
for nombre, clave in claves.items():
    r = p[nombre]
    v = r["Valor"]
    if isinstance(v, datetime.datetime):
        vals.append([q(clave), "null", q(v), q(r["Nota"] + " Para usar HOY, dejar valor_fecha en null.")])
    else:
        vals.append([q(clave), q(v), "null", q(r["Nota"])])
sql.append(insert("parametros", ["clave", "valor_num", "valor_fecha", "nota"], vals))

# Catálogos (columna por categoría)
ws = wb["Catalogos"]
head = [c.value for c in ws[1]]
vals = []
for j, cat in enumerate(head):
    if cat == "si_no":
        continue
    orden = 0
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[j] is not None:
            orden += 1
            vals.append([q(cat), q(r[j]), str(orden)])
sql.append(insert("catalogos", ["categoria", "valor", "orden"], vals))

# Usuarios y contratistas
sql.append(insert("usuarios", ["id_usuario", "nombre", "rol", "area", "email", "activo"],
                  [[q(r["id_usuario"]), q(r["nombre"]), q(r["rol"]), q(r["area"]), q(r["email"]), si(r["activo"])]
                   for r in filas("Usuarios")]))
sql.append(insert("contratistas", ["id_contratista", "razon_social", "cuit", "rubro", "email", "activo"],
                  [[q(r["id_contratista"]), q(r["razon_social"]), q(r["cuit"]), q(r["rubro"]), q(r["email"]), si(r["activo"])]
                   for r in filas("Contratistas")]))

# Obras
cols = ["id_obra", "nombre", "descripcion", "tipo_obra", "subtipo", "modalidad", "estado",
        "fuente_financiamiento", "area_responsable", "barrio", "direccion", "geom", "expediente",
        "contratista_id", "inspector_id", "fecha_inicio", "plazo_dias", "beneficiarios",
        "visible_publico", "observaciones"]
vals = []
for r in filas("Obras"):
    geom = f"extensions.st_setsrid(extensions.st_makepoint({r['lng']}, {r['lat']}), 4326)"
    vals.append([q(r["id_obra"]), q(r["nombre"]), q(r["descripcion"]), q(r["tipo_obra"]), q(r["subtipo"]),
                 q(r["modalidad"]), q(r["estado"]), q(r["fuente_financiamiento"]), q(r["area_responsable"]),
                 q(r["barrio"]), q(r["direccion"]), geom, q(r["expediente"]), q(r["contratista_id"]),
                 q(r["inspector_id"]), q(r["fecha_inicio"]), q(r["plazo_dias"]), q(r["beneficiarios"]),
                 si(r["visible_publico"]), q(r["observaciones"])])
sql.append(insert("obras", cols, vals))

# Ítems
sql.append(insert("items", ["id_item", "id_obra", "nro_item", "rubro", "descripcion", "unidad", "cantidad", "precio_unitario"],
                  [[q(r[k]) for k in ["id_item", "id_obra", "nro_item", "rubro", "descripcion", "unidad", "cantidad", "precio_unitario"]]
                   for r in filas("Items")]))

# Mediciones
ks = ["id_medicion", "id_obra", "id_item", "periodo", "fecha", "cantidad_periodo", "inspector_id",
      "estado_validacion", "validado_por", "observaciones"]
sql.append(insert("mediciones", ks, [[q(r[k]) for k in ks] for r in filas("Mediciones")]))

# Fotos
vals = []
for r in filas("Fotos"):
    geom = f"extensions.st_setsrid(extensions.st_makepoint({r['lng']}, {r['lat']}), 4326)"
    fh = r["fecha_hora"]
    vals.append([q(r["id_foto"]), q(r["id_obra"]), q(r["id_medicion"]), f"'{fh:%Y-%m-%d %H:%M}-03'", geom,
                 q(r["tipo_foto"]), q(r["archivo"]), q(r["descripcion"]), q(r["cargada_por"]), si(r["validada"])])
sql.append(insert("fotos", ["id_foto", "id_obra", "id_medicion", "fecha_hora", "geom", "tipo_foto", "archivo",
                            "descripcion", "cargada_por", "validada"], vals))

# Certificados
ks = ["id_certificado", "id_obra", "nro_certificado", "periodo", "fecha_emision", "estado",
      "fecha_aprobacion", "fecha_pago", "orden_pago"]
sql.append(insert("certificados", ks, [[q(r[k]) for k in ks] for r in filas("Certificados")]))

# Partes diarios (horas_hombre = personal × 8, como en el Excel)
vals = []
for r in filas("Partes_Diarios"):
    vals.append([q(r["id_parte"]), q(r["id_obra"]), q(r["fecha"]), q(r["responsable_id"]), q(r["personal_cant"]),
                 q((r["personal_cant"] or 0) * 8), q(r["maquinaria"]), q(r["materiales"]), q(r["tareas"]),
                 q(r["clima"]), q(r["observaciones"])])
sql.append(insert("partes_diarios", ["id_parte", "id_obra", "fecha", "responsable_id", "personal_cant", "horas_hombre",
                                     "maquinaria", "materiales", "tareas", "clima", "observaciones"], vals))

# Secuencias: que el próximo código siga después del último cargado
for tabla, pk, seq in [("obras", "id_obra", "seq_obra"), ("items", "id_item", "seq_item"),
                       ("mediciones", "id_medicion", "seq_medicion"), ("fotos", "id_foto", "seq_foto"),
                       ("certificados", "id_certificado", "seq_certificado"), ("partes_diarios", "id_parte", "seq_parte")]:
    sql.append(f"select setval('public.{seq}', (select max(substring({pk} from 4)::int) from public.{tabla}));")

sql += ["", "commit;", ""]
open(salida, "w", encoding="utf-8").write("\n\n".join(sql))
print("OK", salida)
