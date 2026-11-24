// Vista previa: simula el servidor dentro del navegador. Nada se guarda.
(function () {
  const db = {
    members: [
      { id: "mario", name: "Mario", enabled: true }, { id: "maria-angelica", name: "María Angélica", enabled: true },
      { id: "maria-jesus", name: "María Jesús", enabled: true }, { id: "christian", name: "Christian", enabled: true },
      { id: "hedy", name: "Hedy", enabled: true },
    ],
    wishes: {
      mario: [{ id: "a1", title: "Libro de historia", description: "Sobre la Segunda Guerra Mundial, de preferencia de Antony Beevor.", link: "https://www.buscalibre.cl", image: "" },
              { id: "a2", title: "Perfume", description: "Algo fresco, nada muy dulce.", link: "", image: "" },
              { id: "a3", title: "Accesorios tecnológicos", description: "", link: "", image: "" }],
      "maria-angelica": [{ id: "b1", title: "Pantuflas abrigadas", description: "Talla 37", link: "", image: "" }],
      "maria-jesus": [], christian: [],
      hedy: [{ id: "c1", title: "Libro de fantasía", description: "", link: "", image: "" }, { id: "c2", title: "Agenda 2027", description: "", link: "", image: "" }],
    },
    draw: { done: false }, assign: {}, revealed: {}, user: null,
  };
  const res = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }));
  const err = (s, e) => res({ error: e }, s);
  const name = (id) => (db.members.find((m) => m.id === id) || {}).name;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    if (typeof url !== "string" || !url.startsWith("/api")) return realFetch(url, opts);
    const path = url.slice(4), method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : {};
    const u = db.user;
    if (path === "/members") return res({ members: db.members.map(({ id, name }) => ({ id, name })) });
    if (path === "/login") {
      if (!body.password) return err(401, "La contraseña no coincide.");
      db.user = body.memberId === "admin" ? { id: "admin", name: "Administración", isAdmin: true } : { id: body.memberId, name: name(body.memberId), isAdmin: false };
      return res({ ok: true });
    }
    if (path === "/logout") { db.user = null; return res({ ok: true }); }
    if (!u) return err(401, "Tu sesión terminó.");
    if (path === "/me") return res({ user: u });
    if (path === "/password") return body.next && body.next.length >= 6 ? res({ ok: true }) : err(400, "La nueva contraseña debe tener al menos 6 caracteres.");
    const mine = db.wishes[u.id] || (db.wishes[u.id] = []);
    if (path === "/dashboard") return res({ name: u.name, wishes: { count: mine.length, max: 6, titles: mine.map((w) => w.title) },
      draw: { done: db.draw.done, participating: !!db.assign[u.id], revealed: !!db.revealed[u.id] } });
    if (path === "/wishes" && method === "GET") return res({ wishes: mine, max: 6 });
    if (path === "/wishes" && method === "POST") {
      if (!body.title?.trim()) return err(400, "Escribe el nombre del regalo.");
      if (mine.length >= 6) return err(400, "Tu lista ya tiene 6 deseos.");
      mine.push({ id: Math.random().toString(36).slice(2), ...body }); return res({ wishes: mine });
    }
    const wm = path.match(/^\/wishes\/(.+)$/);
    if (wm && method === "PUT") { const w = mine.find((x) => x.id === wm[1]); Object.assign(w, body); return res({ wishes: mine }); }
    if (wm && method === "DELETE") { db.wishes[u.id] = mine.filter((x) => x.id !== wm[1]); return res({ wishes: db.wishes[u.id] }); }
    if (path === "/secret") return res({ drawDone: db.draw.done, participating: !!db.assign[u.id], revealed: !!db.revealed[u.id] });
    if (path === "/secret/reveal") {
      if (!db.draw.done) return err(400, "El sorteo todavía no se ha hecho.");
      db.revealed[u.id] = true; const r = db.assign[u.id];
      return res({ receiver: { id: r, name: name(r) }, wishes: db.wishes[r] || [] });
    }
    if (path === "/admin/state") return res({ members: db.members.map((m) => ({ ...m, wishes: (db.wishes[m.id] || []).length, revealed: !!db.revealed[m.id] })),
      draw: { done: db.draw.done, at: db.draw.at, count: Object.keys(db.assign).length } });
    if (path === "/admin/draw") {
      if (db.draw.done) return err(409, "El sorteo ya se realizó.");
      const ids = db.members.filter((m) => m.enabled).map((m) => m.id); let r;
      do { r = [...ids].sort(() => Math.random() - 0.5); } while (r.some((x, i) => x === ids[i]));
      ids.forEach((id, i) => (db.assign[id] = r[i])); db.draw = { done: true, at: Date.now() }; return res({ ok: true });
    }
    if (path === "/admin/draw/reset") { if (String(body.confirm).toUpperCase() !== "REINICIAR") return err(400, "Escribe REINICIAR para confirmar.");
      db.draw = { done: false }; db.assign = {}; db.revealed = {}; return res({ ok: true }); }
    if (path === "/admin/members" && method === "POST") { const id = body.name.toLowerCase().replace(/[^a-z]+/g, "-");
      db.members.push({ id, name: body.name, enabled: true }); return res({ ok: true }); }
    const mm = path.match(/^\/admin\/members\/([^/]+)(\/password)?$/);
    if (mm) { const m = db.members.find((x) => x.id === mm[1]);
      if (!mm[2]) { if (body.name) m.name = body.name; if (typeof body.enabled === "boolean") m.enabled = body.enabled; } return res({ ok: true }); }
    return err(404, "No encontrado.");
  };
})();
