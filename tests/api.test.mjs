// Pruebas de punta a punta contra un servidor en marcha (por defecto `npm run dev`).
// Requiere las contraseñas en la variable TEST_PASSWORDS, ej: {"mario":"...","admin":"..."}
// Ojo: hace un sorteo y lo reinicia; úsalo solo en local.
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const PW = JSON.parse(process.env.TEST_PASSWORDS || "{}");

async function login(id, password = PW[id]) {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: id, password }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { status: r.status, call: (path, method = "GET", body) => fetch(BASE + "/api" + path, {
    method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (x) => ({ status: x.status, data: await x.json() })) };
}

test("login rechaza contraseña incorrecta", async () => {
  assert.equal((await login("mario", "mala")).status, 401);
});

test("sin sesión no hay datos", async () => {
  const r = await fetch(BASE + "/api/wishes");
  assert.equal(r.status, 401);
});

test("flujo completo con privacidad del sorteo", async () => {
  const ids = ["mario", "maria-angelica", "maria-jesus", "christian", "hedy"];
  const s = {};
  for (const id of ids) { s[id] = await login(id); assert.equal(s[id].status, 200, id); }
  const admin = await login("admin");
  assert.equal(admin.status, 200);

  // Asegura estado limpio
  await admin.call("/admin/draw/reset", "POST", { confirm: "REINICIAR" });

  // Listas
  const w = await s.mario.call("/wishes", "POST", { title: "Libro de historia", link: "ejemplo.cl/libro" });
  assert.equal(w.status, 200);
  const wid = w.data.wishes.at(-1).id;
  assert.equal(w.data.wishes.at(-1).link, "https://ejemplo.cl/libro");
  assert.equal((await s.mario.call("/wishes", "POST", { title: "" })).status, 400);
  assert.equal((await s.mario.call("/wishes", "POST", { title: "x", image: "data:text/html,hola" })).status, 400);
  assert.equal((await s.mario.call("/wishes", "POST", { title: "x", link: "javascript:alert(1)" })).data.wishes.at(-1).link, "");
  // Un integrante no puede editar deseos de otro (las rutas solo actúan sobre la propia lista)
  assert.equal((await s.hedy.call("/wishes/" + wid, "PUT", { title: "hackeado" })).status, 404);

  // Antes del sorteo no se revela nada
  assert.equal((await s.hedy.call("/secret/reveal", "POST", {})).status, 400);
  // Integrantes no pueden sortear
  assert.equal((await s.hedy.call("/admin/draw", "POST", {})).status, 404);

  // Sorteo
  assert.equal((await admin.call("/admin/draw", "POST", {})).status, 200);
  assert.equal((await admin.call("/admin/draw", "POST", {})).status, 409, "no se puede sortear dos veces");
  const state = await admin.call("/admin/state");
  assert.ok(!JSON.stringify(state.data).includes("receiver"), "admin no ve asignaciones");
  assert.equal((await admin.call("/secret/reveal", "POST", {})).status, 403);

  const got = {};
  for (const id of ids) {
    const r = await s[id].call("/secret/reveal", "POST", {});
    assert.equal(r.status, 200);
    assert.notEqual(r.data.receiver.id, id, "nadie se regala a sí mismo");
    got[id] = r.data.receiver.id;
  }
  assert.equal(new Set(Object.values(got)).size, ids.length, "cada persona recibe exactamente un regalo");
  // Quien tiene a Mario ve su lista
  const santa = ids.find((id) => got[id] === "mario");
  const view = await s[santa].call("/secret/reveal", "POST", {});
  assert.ok(view.data.wishes.some((x) => x.title === "Libro de historia"));

  // Limpieza
  assert.equal((await s.mario.call("/wishes/" + wid, "DELETE")).status, 200);
  for (const x of (await s.mario.call("/wishes")).data.wishes) await s.mario.call("/wishes/" + x.id, "DELETE");
  assert.equal((await s.mario.call("/wishes")).data.wishes.length, 0);
  assert.equal((await admin.call("/admin/draw/reset", "POST", { confirm: "no" })).status, 400);
  assert.equal((await admin.call("/admin/draw/reset", "POST", { confirm: "REINICIAR" })).status, 200);
});

test("otro sitio no puede enviar acciones", async () => {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", origin: "https://malo.example" }, body: "{}" });
  assert.equal(r.status, 403);
});
