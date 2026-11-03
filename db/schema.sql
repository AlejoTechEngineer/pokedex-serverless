-- Esquema de la base de datos serverless (Cloudflare D1, SQLite).
-- Clave primaria compuesta (id, form): el ID del dataset se repite en 153 especies por
-- sus formas alternas (Mega, Alola, Galar...), pero la pareja (id, form) es única.
-- WITHOUT ROWID: la tabla se almacena ordenada por su clave primaria.

CREATE TABLE IF NOT EXISTS pokemon (
  id          INTEGER NOT NULL,
  form        TEXT    NOT NULL,            -- "Base" cuando el CSV viene vacío
  name        TEXT    NOT NULL,
  name_lower  TEXT    NOT NULL,            -- para búsqueda sin distinguir mayúsculas
  type1       TEXT    NOT NULL,
  type2       TEXT,                        -- NULL en los de un solo tipo
  total       INTEGER NOT NULL,
  hp          INTEGER NOT NULL,
  attack      INTEGER NOT NULL,
  defense     INTEGER NOT NULL,
  sp_atk      INTEGER NOT NULL,
  sp_def      INTEGER NOT NULL,
  speed       INTEGER NOT NULL,
  generation  INTEGER NOT NULL,
  PRIMARY KEY (id, form)
) WITHOUT ROWID;

-- Índices secundarios: filtrar por tipo o generación ya ordenado por id.
CREATE INDEX IF NOT EXISTS idx_pokemon_type       ON pokemon (type1, id);
CREATE INDEX IF NOT EXISTS idx_pokemon_generation ON pokemon (generation, id);
