<div align="center">

# Pokédex Serverless

**Actividad Sumativa · Unidad 4 · Creación de aplicación usando el patrón serverless**

Maestría en Arquitectura de Software · Politécnico Grancolombiano
Módulo: Contenerización de Aplicaciones de Software

`Cloudflare D1` · `Cloudflare Workers` · `Static Assets` · `Chain of Responsibility`

</div>

---

## Descripción

Flujo completo de integración de datos con computación serverless:

1. **Dataset** público en CSV (1.215 registros, 13 columnas) →
2. **Base de datos serverless** (Cloudflare D1, SQL sobre SQLite) →
3. **Aplicación web** que consulta los datos mediante un **Worker** (función serverless), con búsqueda por **ID** (clave principal) y por **nombre** (columna secundaria), filtros, tabla, ficha en tarjeta y gráficas.

No hay servidores que aprovisionar, parchear ni escalar. Funciona en el plan gratuito, **sin tarjeta de crédito**; si se supera el límite diario gratuito, las consultas fallan en lugar de generar cobros.

---

## Contenido del repositorio

- `db/schema.sql` → **script de base de datos**: tabla `pokemon` con clave `(id, form)` e índices por tipo y generación
- `db/seed.sql` → datos: 1.215 `INSERT OR REPLACE` (generado desde el CSV)
- `data/pokemon.csv` → dataset original
- `scripts/build_seed.py` → convierte el CSV en `seed.sql`: infiere tipos, limpia vacíos, resuelve colisiones y valida claves
- `scripts/deploy.sh` → despliegue completo en un comando
- `scripts/destroy.sh` → elimina Worker y base de datos
- `src/worker.js` → punto de entrada del Worker
- `src/chain.js` → manejadores del patrón *Chain of Responsibility* (rutas de la API)
- `src/repository.js` → consultas SQL a D1, paginación por cursor y estadísticas
- `frontend/` → aplicación web (`index.html`, `styles.css`, `app.js`, `config.js`)
- `wrangler.toml` → configuración de Cloudflare (Worker, archivos estáticos, enlace a D1)
- `tests/` → 23 pruebas automáticas (17 del Worker sobre SQLite real y 6 del generador de SQL)

---

## Arquitectura

```mermaid
flowchart LR
    U([Navegador]) -->|"/ · app.js · styles.css"| A[Static Assets<br/>frontend]
    U -->|"fetch /api/*"| W[Cloudflare Worker<br/>Chain of Responsibility]
    W -->|SQL| DB[(Cloudflare D1)]
    CSV[/pokemon.csv/] -->|build_seed.py → seed.sql| DB
    W -. logs JSON .-> L[wrangler tail]
```

**Modelo de datos.** La columna `ID` del CSV se repite en 153 especies con formas alternas (Mega, Alola, Galar…), por lo que la clave primaria es **compuesta**: `(id, form)`. Dos índices secundarios resuelven los filtros por tipo y generación. La paginación usa un **cursor por clave** (sin `OFFSET`), con orden global por `(id, form)`.

**Patrones aplicados (Unidad 4).**

| Patrón | Dónde |
|---|---|
| Despliegue de microservicios serverless | El Worker se ejecuta por petición, escala solo y no requiere servidor |
| Chain of Responsibility | `chain.js`: `MethodGuard → Health → ById → List → Stats → 404` |

### Endpoints

| Método y ruta | Descripción |
|---|---|
| `GET /api/health` | Estado del servicio |
| `GET /api/pokemon/{id}` | Todas las formas de una especie (búsqueda por ID) |
| `GET /api/pokemon?name=pika` | Búsqueda parcial por nombre, sin distinguir mayúsculas |
| `GET /api/pokemon?type=Fire&generation=1&limit=25&cursor=…` | Listado filtrado y paginado |
| `GET /api/stats` | Agregados para las gráficas |

---

## Ejecución

Requisitos: Node.js 18 o superior. Para las pruebas de Python: `pip install -r requirements-dev.txt`.

### Opción A · Local (sin cuenta)

```bash
npm install
npm run db:local        # crea el esquema y carga los 1.215 registros en una D1 local
npm run dev             # abre http://localhost:8787
```

### Pasos manuales (recomendado, verificados)

```bash
# 1. Instala wrangler y las dependencias del proyecto
npm install

# 2. Inicia sesión en Cloudflare (abre el navegador; plan gratuito, sin tarjeta)
npx wrangler login

# 3. Crea la base D1 → copia el database_id que imprime a wrangler.toml
npx wrangler d1 create pokedex

# 4. Crea la tabla y los índices en la base remota
npx wrangler d1 execute pokedex --remote --file db/schema.sql

# 5. Carga los 1.215 registros
npx wrangler d1 execute pokedex --remote --file db/seed.sql

# 6. Verifica la carga (esperado: filas = 1215, ids = 1025)
npx wrangler d1 execute pokedex --remote --command "SELECT COUNT(*) AS filas, COUNT(DISTINCT id) AS ids FROM pokemon"

# 7. Publica el Worker y el frontend
npx wrangler deploy
```

Al terminar, `wrangler` imprime la URL pública (`https://pokedex-serverless.<tu-subdominio>.workers.dev`).

### Atajo con script (Mac/Linux)

```bash
./scripts/deploy.sh     # automatiza los mismos pasos: sesión, D1, esquema, datos, verificación y despliegue
```

Este script automatiza los mismos pasos, pero no fue probado de extremo a extremo; si falla, usa los pasos manuales anteriores.

### Pruebas

```bash
npm test                # 17 pruebas del Worker + 6 del generador de SQL
```

### Ver logs en vivo y eliminar recursos

```bash
npx wrangler tail       # una línea JSON por petición
./scripts/destroy.sh
```

---

## Solución de problemas

- **Rutas con tildes o espacios en Windows** → si `npm run db:local` o `npm run dev` fallan con `internal error`, mueve el proyecto a una carpeta con ruta simple (por ejemplo `C:\dev\pokedex-serverless`). El motor local de wrangler no abre la base de datos en rutas con caracteres como "í".
- **Primer acceso tras desplegar** → la URL pública puede tardar unos 2 minutos en responder mientras Cloudflare prepara el certificado del subdominio nuevo.
- **`npm test` falla en la parte de Python** → instala pytest con `pip install -r requirements-dev.txt` y verifica a qué Python apunta el comando `python3`.

---

## Autor

**Alejandro De Mendoza** · [AlejoTechEngineer](https://github.com/AlejoTechEngineer)

<sub>Datos: lista pública de Pokémon (GitHub · lgreski/pokemonData). Pokémon y sus nombres son marcas de sus respectivos propietarios; uso estrictamente académico.</sub>
