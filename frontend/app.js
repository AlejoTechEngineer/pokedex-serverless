/* Pokédex Serverless · cliente web (JavaScript puro, sin dependencias).
 * Habla con la API (Cloudflare Worker + D1) y pinta tabla, ficha y gráficas.   */
(() => {
  "use strict";

  const API = String((window.APP_CONFIG || {}).apiUrl || "").replace(/\/$/, "");

  const TYPE_COLORS = {
    Normal: "#a8a77a", Fire: "#ee8130", Water: "#6390f0", Electric: "#f7d02c", Grass: "#7ac74c",
    Ice: "#96d9d6", Fighting: "#c22e28", Poison: "#a33ea1", Ground: "#e2bf65", Flying: "#a98ff3",
    Psychic: "#f95587", Bug: "#a6b91a", Rock: "#b6a136", Ghost: "#735797", Dragon: "#6f35fc",
    Dark: "#705746", Steel: "#b7b7ce", Fairy: "#d685ad",
  };
  const STATS = [
    ["hp", "PS"], ["attack", "Ataque"], ["defense", "Defensa"],
    ["sp_atk", "Ataque esp."], ["sp_def", "Defensa esp."], ["speed", "Velocidad"],
  ];
  const STAT_MAX = 255;
  const PAGE_SIZE = 25;

  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $("searchForm"), q: $("q"), qLabel: $("qLabel"), type: $("fType"), gen: $("fGen"),
    rows: $("rows"), empty: $("empty"), more: $("moreBtn"), summary: $("summary"),
    entry: $("entry"), banner: $("banner"), clear: $("clearBtn"),
    apiStatus: $("apiStatus"), apiStatusText: $("apiStatusText"), overview: $("view-overview"),
  };

  const state = {
    mode: "id", items: [], next: null, selected: null, view: "explore",
    overviewLoaded: false, formsCache: new Map(), busy: false, filtersTouched: false,
  };

  /* ------------------------------------------------------------- utilidades */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style") node.setAttribute("style", v);
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const svg = (tag, attrs = {}, ...kids) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    kids.forEach((c) => n.append(c));
    return n;
  };
  const fmtId = (id) => "#" + String(id).padStart(4, "0");
  const color = (type) => TYPE_COLORS[type] || "#667085";
  const key = (it) => `${it.id}|${it.form}`;

  function readableOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1b2a41" : "#ffffff";
  }
  const chip = (type) =>
    h("span", { class: "chip", style: `background:${color(type)};color:${readableOn(color(type))}` }, type);
  const chips = (it) =>
    h("span", { class: "chips" }, chip(it.type1), it.type2 ? chip(it.type2) : null);

  function showBanner(msg) { ui.banner.textContent = msg; ui.banner.hidden = false; }
  function hideBanner() { ui.banner.hidden = true; }
  function setStatus(kind, text) {
    ui.apiStatus.className = "status " + (kind ? "is-" + kind : "");
    ui.apiStatusText.textContent = text;
  }

  async function api(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
    const url = `${API}${path}${qs.toString() ? "?" + qs : ""}`;
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err) {
      throw new Error("No se pudo conectar con la API. Revisa tu conexión y la URL configurada en config.js.");
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* respuesta vacía */ }
    if (!res.ok) {
      const e = new Error((body && body.error) || `La API respondió con el estado ${res.status}.`);
      e.status = res.status;
      throw e;
    }
    return body;
  }

  /* ----------------------------------------------------------- tabla de datos */
  function renderRows() {
    ui.rows.replaceChildren();
    for (const it of state.items) {
      const tr = h("tr", {
        tabindex: "0", "data-key": key(it), style: `--type:${color(it.type1)}`,
        "aria-selected": state.selected && key(state.selected) === key(it) ? "true" : "false",
        class: state.selected && key(state.selected) === key(it) ? "is-selected" : "",
        onclick: () => select(it),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(it); } },
      },
        h("td", { class: "num" }, fmtId(it.id)),
        h("td", {}, h("span", { class: "cell-name" }, it.name),
          it.form !== "Base" ? h("span", { class: "cell-form" }, it.form) : null),
        h("td", {}, chips(it)),
        h("td", { class: "num" }, it.total),
        h("td", { class: "num" }, it.hp),
        h("td", { class: "num" }, it.attack),
        h("td", { class: "num" }, it.defense),
        h("td", { class: "num" }, it.speed),
        h("td", { class: "num" }, it.generation),
      );
      ui.rows.append(tr);
    }
    ui.more.hidden = !state.next;
  }

  function markSelected() {
    const k = state.selected ? key(state.selected) : null;
    for (const tr of ui.rows.children) {
      const on = tr.dataset.key === k;
      tr.classList.toggle("is-selected", on);
      tr.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function showEmpty(msg) {
    ui.empty.textContent = msg;
    ui.empty.hidden = !msg;
    document.getElementById("grid").hidden = !!msg;
  }

  /* ---------------------------------------------------------------- listado */
  function filterText() {
    const parts = [];
    if (ui.type.value) parts.push(`tipo ${ui.type.value}`);
    if (ui.gen.value) parts.push(`generación ${ui.gen.value}`);
    return parts.length ? ` · ${parts.join(", ")}` : "";
  }

  async function loadList({ append = false, name = "" } = {}) {
    if (state.busy) return;
    state.busy = true;
    ui.more.disabled = true;
    hideBanner();
    try {
      const data = await api("/pokemon", {
        limit: PAGE_SIZE, type: ui.type.value, generation: ui.gen.value,
        name, cursor: append ? state.next : "",
      });
      state.items = append ? state.items.concat(data.items) : data.items;
      state.next = data.next_cursor;
      showEmpty(state.items.length ? "" :
        name ? `No hay registros cuyo nombre contenga “${name}”. Revisa la ortografía o escribe menos letras.`
             : "No hay registros con esos filtros.");
      if (name) {
        const total = data.total_matches ?? data.count;
        ui.summary.textContent = `${total} coincidencia${total === 1 ? "" : "s"} con “${name}”${filterText()}` +
          (total > data.count ? ` · se muestran las primeras ${data.count}` : "");
      } else {
        ui.summary.textContent = `${state.items.length} registros cargados${filterText()}` +
          (state.next ? " · hay más" : " · fin de la lista");
      }
      renderRows();
      if (!append && state.items.length && !state.selected) select(state.items[0]);
    } catch (err) {
      showBanner(err.message);
      ui.summary.textContent = "";
    } finally {
      state.busy = false;
      ui.more.disabled = false;
    }
  }

  async function searchById(raw) {
    if (!/^\d{1,4}$/.test(raw)) {
      ui.summary.textContent = "El ID debe ser un número entero, por ejemplo 25.";
      return;
    }
    hideBanner();
    try {
      const data = await api(`/pokemon/${Number(raw)}`);
      state.formsCache.set(data.id, data.forms);
      state.items = data.forms;
      state.next = null;
      showEmpty("");
      ui.summary.textContent = `ID ${fmtId(data.id)} · ${data.forms.length} forma${data.forms.length === 1 ? "" : "s"} registrada${data.forms.length === 1 ? "" : "s"}`;
      renderRows();
      select(data.forms[0]);
    } catch (err) {
      if (err.status === 404) {
        state.items = []; state.next = null;
        renderRows();
        showEmpty(`No existe un registro con el ID ${raw}. En este dataset los IDs van de 1 a 1025.`);
        ui.summary.textContent = "";
      } else showBanner(err.message);
    }
  }

  /* ------------------------------------------------------------------ ficha */
  async function select(item) {
    state.selected = item;
    markSelected();
    renderEntry(item, state.formsCache.get(item.id) || [item]);
    if (!state.formsCache.has(item.id)) {
      try {
        const data = await api(`/pokemon/${item.id}`);
        state.formsCache.set(item.id, data.forms);
        if (state.selected && state.selected.id === item.id) renderEntry(state.selected, data.forms);
      } catch (_) { /* la ficha ya se pintó con los datos de la fila */ }
    }
  }

  function radar(item) {
    const cx = 150, cy = 125, R = 82, n = STATS.length;
    const point = (i, r) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const root = svg("svg", { class: "radar", viewBox: "0 0 300 250", role: "img",
      "aria-label": "Gráfica radial de estadísticas: " + STATS.map(([k, l]) => `${l} ${item[k]}`).join(", ") });
    [0.25, 0.5, 0.75, 1].forEach((f) =>
      root.append(svg("polygon", { class: "ring", points: STATS.map((_, i) => point(i, R * f).join(",")).join(" ") })));
    STATS.forEach((_, i) => {
      const [x, y] = point(i, R);
      root.append(svg("line", { class: "axis", x1: cx, y1: cy, x2: x, y2: y }));
    });
    root.append(svg("polygon", { class: "shape",
      points: STATS.map(([k], i) => point(i, R * Math.min(item[k] / STAT_MAX, 1)).join(",")).join(" ") }));
    STATS.forEach(([, label], i) => {
      const [x, y] = point(i, R + 18);
      const t = svg("text", { x, y: y + 4, "text-anchor": x < cx - 5 ? "end" : x > cx + 5 ? "start" : "middle" });
      t.textContent = label;
      root.append(t);
    });
    return root;
  }

  function renderEntry(item, forms) {
    ui.entry.style.setProperty("--type", color(item.type1));
    // replaceChildren recibe nodos o textos; por eso se aplana el arreglo y se descartan los null.
    ui.entry.replaceChildren(...[
      h("p", { class: "big-num", "aria-hidden": "true" }, fmtId(item.id)),
      h("h2", {}, item.name),
      h("div", { class: "entry__meta" }, chips(item),
        h("span", {}, `Generación ${item.generation}`),
        item.form !== "Base" ? h("span", {}, `· ${item.form}`) : null),
      forms.length > 1 ? h("div", { class: "forms", role: "group", "aria-label": "Formas de esta especie" },
        forms.map((f) => h("button", {
          type: "button", "aria-pressed": key(f) === key(item) ? "true" : "false",
          onclick: () => select(f),
        }, f.form === "Base" ? "Base" : f.form))) : null,
      STATS.map(([k, label]) =>
        h("div", { class: "stat" },
          h("span", {}, label),
          h("span", { class: "stat__bar", "aria-hidden": "true" },
            h("span", { class: "stat__fill", style: `width:${Math.min(100, (item[k] / STAT_MAX) * 100)}%` })),
          h("span", { class: "stat__val" }, item[k]))),
      h("div", { class: "stat stat--total" }, h("span", {}, "Total"), h("span", { class: "stat__val" }, item.total)),
      radar(item),
    ].flat(Infinity).filter(Boolean));
  }

  /* --------------------------------------------------------------- panorama */
  async function loadOverview() {
    if (state.overviewLoaded) return;
    ui.overview.replaceChildren(h("p", { class: "empty" }, "Calculando estadísticas…"));
    try {
      const s = await api("/stats");
      state.overviewLoaded = true;
      const maxType = Math.max(...s.by_type.map((t) => t.count));
      const maxGen = Math.max(...s.by_generation.map((g) => g.count));
      ui.overview.replaceChildren(
        card("third", "Registros en la base de datos", kpi(s.total_records.toLocaleString("es-CO"), "filas cargadas desde el CSV")),
        card("third", "Especies distintas", kpi(s.unique_species.toLocaleString("es-CO"), "IDs únicos de la Pokédex")),
        card("third", "Total promedio", kpi(s.average_total, "suma media de las seis estadísticas")),
        card("half", "Registros por tipo primario",
          s.by_type.map((t) => h("div", { class: "hbar" },
            h("span", {}, t.type),
            h("span", { class: "hbar__track" }, h("span", { class: "hbar__fill", style: `--c:${color(t.type)};width:${(t.count / maxType) * 100}%` })),
            h("span", { class: "hbar__val" }, t.count)))),
        card("half", "Registros por generación",
          h("div", { class: "cols", role: "img", "aria-label": "Registros por generación: " + s.by_generation.map((g) => `generación ${g.generation}, ${g.count}`).join("; ") },
            s.by_generation.map((g) => h("div", { class: "cols__item" },
              h("span", { class: "cols__n" }, g.count),
              h("span", { class: "cols__bar", style: `height:${(g.count / maxGen) * 80}%` }),
              h("span", {}, "G" + g.generation))))),
        card("half", "Promedio de cada estadística",
          STATS.map(([k, label]) => h("div", { class: "hbar" },
            h("span", {}, label),
            h("span", { class: "hbar__track" }, h("span", { class: "hbar__fill", style: `width:${(s.average_stats[k] / 130) * 100}%` })),
            h("span", { class: "hbar__val" }, s.average_stats[k])))),
        card("half", "Los cinco con mayor total",
          h("ol", { class: "top5" }, s.top_total.map((t) => h("li", {},
            h("button", { type: "button", onclick: () => jumpToId(t.id) },
              `${fmtId(t.id)} ${t.name}${t.form !== "Base" ? " (" + t.form + ")" : ""}`),
            h("b", {}, t.total))))),
      );
    } catch (err) {
      ui.overview.replaceChildren(h("p", { class: "empty" }, err.message));
    }
  }
  const card = (size, title, ...body) =>
    h("section", { class: `card card--${size}` }, h("h2", {}, title), body);
  const kpi = (value, label) => h("dl", { class: "kpi" }, h("dd", {}, value), h("dt", {}, label));

  function jumpToId(id) {
    switchView("explore");
    setMode("id");
    ui.q.value = String(id);
    searchById(String(id));
    if (ui.entry.scrollIntoView) ui.entry.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ------------------------------------------------------------ interacción */
  function setMode(mode) {
    state.mode = mode;
    document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
    ui.q.value = "";
    if (mode === "id") {
      ui.q.inputMode = "numeric"; ui.q.placeholder = "25"; ui.q.maxLength = 4;
      ui.qLabel.textContent = "Número de la Pokédex";
    } else {
      ui.q.inputMode = "text"; ui.q.placeholder = "pika"; ui.q.maxLength = 40;
      ui.qLabel.textContent = "Nombre completo o parcial";
    }
  }

  function switchView(view) {
    state.view = view;
    for (const v of ["explore", "overview"]) {
      const on = v === view;
      $("view-" + v).hidden = !on;
      $("tab-" + v).classList.toggle("is-active", on);
      $("tab-" + v).setAttribute("aria-selected", on ? "true" : "false");
    }
    if (view === "overview") loadOverview();
  }

  function onFilterChange() {
    state.filtersTouched = true; // el usuario eligió filtros: se respetan en las búsquedas
    loadList({ name: state.mode === "name" ? ui.q.value.trim() : "" });
  }

  function init() {
    Object.keys(TYPE_COLORS).sort().forEach((t) => ui.type.append(h("option", { value: t }, t)));
    for (let g = 1; g <= 9; g++) ui.gen.append(h("option", { value: g }, `Generación ${g}`));
    ui.gen.value = "1";

    document.querySelectorAll("input[name=mode]").forEach((r) =>
      r.addEventListener("change", () => setMode(r.value)));
    ui.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = ui.q.value.trim();
      if (state.mode === "id") searchById(value);
      else {
        // La generación 1 es solo el filtro inicial: al buscar por nombre se amplía a todas
        // las generaciones, salvo que la persona haya elegido filtros por su cuenta.
        if (!state.filtersTouched) ui.gen.value = "";
        loadList({ name: value });
      }
    });
    ui.clear.addEventListener("click", () => { ui.q.value = ""; state.items = []; loadList(); ui.q.focus(); });
    ui.type.addEventListener("change", onFilterChange);
    ui.gen.addEventListener("change", onFilterChange);
    ui.more.addEventListener("click", () => loadList({ append: true, name: "" }));
    $("tab-explore").addEventListener("click", () => switchView("explore"));
    $("tab-overview").addEventListener("click", () => switchView("overview"));

    const t0 = performance.now();
    api("/health")
      .then(() => setStatus("ok", `API en línea · ${Math.round(performance.now() - t0)} ms`))
      .catch((err) => { setStatus("bad", "API sin conexión"); showBanner(err.message); });
    loadList();
  }

  init();
})();
