"""Pruebas del generador de SQL (scripts/build_seed.py)."""
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_seed as bs  # noqa: E402

CSV = ROOT / "data" / "pokemon.csv"


def test_snake_case():
    assert bs.snake_case("Sp. Atk") == "sp_atk"


def test_filas_tipos_y_vacios():
    items, rep = bs.build_rows(CSV)
    assert rep["rows"] == 1215 and rep["distinct_ids"] == 1025
    assert rep["columns"]["hp"] == "int" and rep["columns"]["name"] == "str"
    bulbasaur = next(i for i in items if i["id"] == 1)
    assert bulbasaur["form"] == "Base" and bulbasaur["name_lower"] == "bulbasaur"
    assert next(i for i in items if i["id"] == 4)["type2"] is None


def test_colision_zygarde():
    items, rep = bs.build_rows(CSV)
    assert {i["form"] for i in items if i["id"] == 718} == {
        "Zygarde50% Forme", "Zygarde10% Forme", "Complete Forme"}
    assert len(rep["collisions_resolved"]) == 2


def test_clave_duplicada_irresoluble(tmp_path):
    f = tmp_path / "x.csv"
    f.write_text("ID,Name,Type1,Total,Generation\n1,A,Fire,1,1\n1,A,Fire,1,1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicada"):
        bs.build_rows(f)


def test_sql_se_ejecuta_y_es_idempotente():
    items, _ = bs.build_rows(CSV)
    sql = bs.render_sql(items)
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    db.executescript(sql)
    db.executescript(sql)  # segunda ejecución: INSERT OR REPLACE no duplica
    assert db.execute("SELECT COUNT(*) FROM pokemon").fetchone()[0] == 1215
    assert db.execute("SELECT name FROM pokemon WHERE name LIKE '%Farfetch%' LIMIT 1").fetchone()
    # los apóstrofes se escapan bien
    assert db.execute("SELECT COUNT(*) FROM pokemon WHERE name LIKE '%''%'").fetchone()[0] >= 1


def test_seed_commiteado_esta_al_dia():
    items, _ = bs.build_rows(CSV)
    assert (ROOT / "db" / "seed.sql").read_text(encoding="utf-8") == bs.render_sql(items)
