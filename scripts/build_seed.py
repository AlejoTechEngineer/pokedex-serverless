#!/usr/bin/env python3
"""Convierte el CSV en un script SQL de carga para Cloudflare D1 (db/seed.sql).

Qué hace
1. Lee el CSV (UTF-8, con o sin BOM) y normaliza los nombres de columna a snake_case.
2. Infiere el tipo de CADA columna mirando todos sus valores (entero, decimal o texto).
3. Limpia espacios; celdas vacías -> NULL; Form vacío -> "Base".
4. Resuelve colisiones de clave (id, form) usando el nombre (p. ej. Zygarde 50% / 10%).
5. Valida que (id, form) sea único y genera INSERT OR REPLACE por lotes (idempotente).

Uso
    python scripts/build_seed.py                       # escribe db/seed.sql
    python scripts/build_seed.py --csv otro.csv --out /tmp/seed.sql
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = ["id", "form", "name", "name_lower", "type1", "type2", "total", "hp", "attack",
           "defense", "sp_atk", "sp_def", "speed", "generation"]
BATCH = 50
_INT = re.compile(r"^-?\d+$")
_FLOAT = re.compile(r"^-?\d+\.\d+$")


def snake_case(header: str) -> str:
    """'Sp. Atk' -> 'sp_atk'."""
    return re.sub(r"[^a-z0-9]+", "_", header.strip().lower()).strip("_")


def infer_types(rows: list[dict], cols: list[str]) -> dict[str, str]:
    types = {}
    for c in cols:
        vals = [r[c] for r in rows if r[c] != ""]
        if vals and all(_INT.match(v) for v in vals):
            types[c] = "int"
        elif vals and all(_INT.match(v) or _FLOAT.match(v) for v in vals):
            types[c] = "float"
        else:
            types[c] = "str"
    return types


def build_rows(csv_path: str | Path) -> tuple[list[dict], dict]:
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        cols = [snake_case(h) for h in (reader.fieldnames or [])]
        rows = [{snake_case(k): (v or "").strip() for k, v in r.items() if k is not None}
                for r in reader]
    missing = {"id", "name", "type1", "total", "generation"} - set(cols)
    if missing:
        raise ValueError(f"Faltan columnas en el CSV: {sorted(missing)}")

    types = infer_types(rows, cols)
    items = []
    for r in rows:
        it = {}
        for c in cols:
            v = r[c]
            if v == "":
                it[c] = None
            elif types[c] == "int":
                it[c] = int(v)
            elif types[c] == "float":
                it[c] = float(v)
            else:
                it[c] = v
        it["form"] = it.get("form") or "Base"
        it["name_lower"] = it["name"].lower()
        items.append(it)

    # Colisiones (id, form): se desambiguan con el nombre.
    counts = Counter((i["id"], i["form"]) for i in items)
    resolved = []
    for i in items:
        if counts[(i["id"], i["form"])] > 1:
            i["form"] = i["name"]
            resolved.append(f"{i['id']}:{i['name']}")
    dupes = [k for k, n in Counter((i["id"], i["form"]) for i in items).items() if n > 1]
    if dupes:
        raise ValueError(f"Clave (id, form) duplicada sin resolver: {dupes[:3]}")

    report = {
        "rows": len(items),
        "columns": types,
        "distinct_ids": len({i["id"] for i in items}),
        "collisions_resolved": resolved,
        "blank_form": sum(1 for r in rows if r.get("form", "") == ""),
        "blank_type2": sum(1 for r in rows if r.get("type2", "") == ""),
    }
    return items, report


def sql_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def render_sql(items: list[dict]) -> str:
    head = ("-- Generado por scripts/build_seed.py. No editar a mano.\n"
            "-- INSERT OR REPLACE: se puede ejecutar varias veces sin duplicar datos.\n")
    cols = ", ".join(COLUMNS)
    out = [head]
    for i in range(0, len(items), BATCH):
        chunk = items[i:i + BATCH]
        values = ",\n  ".join("(" + ", ".join(sql_value(it.get(c)) for c in COLUMNS) + ")"
                              for it in chunk)
        out.append(f"INSERT OR REPLACE INTO pokemon ({cols}) VALUES\n  {values};\n")
    return "\n".join(out)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="CSV -> SQL de carga para D1")
    p.add_argument("--csv", default=str(ROOT / "data" / "pokemon.csv"))
    p.add_argument("--out", default=str(ROOT / "db" / "seed.sql"))
    args = p.parse_args(argv)

    items, rep = build_rows(args.csv)
    Path(args.out).write_text(render_sql(items), encoding="utf-8")
    print(f"· CSV leído: {rep['rows']} filas · {rep['distinct_ids']} valores distintos de id")
    print("· Tipos inferidos:", rep["columns"])
    if rep["collisions_resolved"]:
        print("· Colisiones (id, form) resueltas con el nombre:", rep["collisions_resolved"])
    print(f"· Celdas vacías: form={rep['blank_form']} (-> 'Base'), type2={rep['blank_type2']} (-> NULL)")
    print(f"· Escrito {args.out} con {rep['rows']} filas en {-(-rep['rows'] // BATCH)} lotes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
