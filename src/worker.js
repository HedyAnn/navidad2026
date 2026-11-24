// Navidad en Familia — servidor (Cloudflare Worker + Durable Object con almacenamiento persistente).
// Toda la información vive en un único Durable Object ("casa"), que procesa las
// solicitudes de a una, así el sorteo no puede ejecutarse dos veces al mismo tiempo.

import { DurableObject } from "cloudflare:workers";
import APP_HTML from "./app.html";
import { SEED } from "./seed.js";
import FAMILIA from "./familia.jpg";

const SESSION_DAYS = 30;
const MAX_WISHES = 6;
const MAX_IMAGE_CHARS = 280_000; // ~200 KB de imagen comprimida
const PBKDF2_ITERATIONS = 100_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.CASA.get(env.CASA.idFromName("casa"));
      return stub.fetch(request);
    }
    if (url.pathname === "/familia.jpg") {
      return new Response(FAMILIA, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
    }
    return new Response(APP_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-frame-options": "DENY",
        "referrer-policy": "same-origin",
      },
    });
  },
};

// ---------- utilidades ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return { salt: b64(salt), hash: b64(bits) };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function checkPassword(password, record) {
  if (!record || typeof password !== "string") return false;
  const { hash } = await hashPassword(password, record.salt);
  return safeEqual(hash, record.hash);
}

const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, "");
const randomInt = (n) => {
  const max = Math.floor(0xffffffff / n) * n;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= max);
  return a[0] % n;
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, error) => json({ error }, status);

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanLink(v) {
  const s = clean(v, 600);
  if (!s) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch { return ""; }
}
function cleanImage(v) {
  if (typeof v !== "string" || !v) return "";
  if (v.length > MAX_IMAGE_CHARS) return null;
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}
function slugify(name) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "integrante";
}

// ---------- la casa: todos los datos ----------
export class Casa extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    ctx.blockConcurrencyWhile(() => this.ensureSeed());
  }

  async ensureSeed() {
    if (await this.storage.get("seeded")) return;
    const members = [];
    for (const [id, s] of Object.entries(SEED)) {
      if (id === "admin") continue;
      members.push({ id, name: s.name, enabled: true });
      await this.storage.put("pw:" + id, { salt: s.salt, hash: s.hash });
    }
    await this.storage.put("pw:admin", { salt: SEED.admin.salt, hash: SEED.admin.hash });
    await this.storage.put("members", members);
    await this.storage.put("draw", { done: false });
    await this.storage.put("seeded", true);
  }

  members() { return this.storage.get("members").then((m) => m || []); }
  async wishes(id) { return (await this.storage.get("wishes:" + id)) || []; }

  async session(request) {
    const cookie = request.headers.get("cookie") || "";
    const m = cookie.match(/(?:^|;\s*)sid=([A-Za-z0-9]+)/);
    if (!m) return null;
    const s = await this.storage.get("sess:" + m[1]);
    if (!s) return null;
    if (s.exp < Date.now()) { await this.storage.delete("sess:" + m[1]); return null; }
    s.token = m[1];
    if (s.uid === "admin") return { ...s, isAdmin: true, name: "Administración" };
    const member = (await this.members()).find((x) => x.id === s.uid);
    if (!member) return null;
    return { ...s, isAdmin: false, name: member.name };
  }

  async fetch(request) {
    try {
      return await this.route(request);
    } catch (e) {
      console.error(e);
      return fail(500, "Algo falló en el servidor. Intenta de nuevo en un momento.");
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method;

    if (method !== "GET") {
      // Protección simple contra solicitudes de otros sitios.
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return fail(403, "Solicitud no permitida.");
      if (method !== "DELETE" && !(request.headers.get("content-type") || "").includes("application/json"))
        return fail(415, "Formato no válido.");
    }
    const body = method === "GET" || method === "DELETE" ? {} : await request.json().catch(() => ({}));

    // --- públicas ---
    if (path === "/members" && method === "GET") {
      const members = await this.members();
      return json({ members: members.map(({ id, name }) => ({ id, name })) });
    }
    if (path === "/login" && method === "POST") return this.login(body, url);
    if (path === "/logout" && method === "POST") {
      const s = await this.session(request);
      if (s) await this.storage.delete("sess:" + s.token);
      return json({ ok: true }, 200, { "set-cookie": "sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
    }

    // --- requieren sesión ---
    const s = await this.session(request);
    if (!s) return fail(401, "Tu sesión terminó. Vuelve a entrar.");

    if (path === "/me" && method === "GET") return json({ user: { id: s.uid, name: s.name, isAdmin: s.isAdmin } });
    if (path === "/password" && method === "POST") return this.changeOwnPassword(s, body);

    if (s.isAdmin) {
      if (path.startsWith("/admin/")) return this.admin(path.slice(6), method, body);
      return fail(403, "Esta sección es para los integrantes de la familia.");
    }

    if (path === "/dashboard" && method === "GET") return this.dashboard(s);
    if (path === "/wishes" && method === "GET") return json({ wishes: await this.wishes(s.uid), max: MAX_WISHES });
    if (path === "/wishes" && method === "POST") return this.saveWish(s, null, body);
    const wm = path.match(/^\/wishes\/([a-z0-9]+)$/);
    if (wm && method === "PUT") return this.saveWish(s, wm[1], body);
    if (wm && method === "DELETE") return this.deleteWish(s, wm[1]);
    if (path === "/secret" && method === "GET") return this.secretStatus(s);
    if (path === "/secret/reveal" && method === "POST") return this.reveal(s);

    return fail(404, "No encontrado.");
  }

  async login(body, url) {
    const id = clean(body.memberId, 60);
    const lockKey = "lock:" + id;
    const lock = (await this.storage.get(lockKey)) || { fails: 0, until: 0 };
    if (lock.until > Date.now()) {
      const min = Math.ceil((lock.until - Date.now()) / 60000);
      return fail(429, `Demasiados intentos. Espera ${min} minuto${min > 1 ? "s" : ""} y vuelve a intentar.`);
    }
    let ok = false;
    if (id === "admin" || (await this.members()).some((m) => m.id === id)) {
      ok = await checkPassword(body.password, await this.storage.get("pw:" + id));
    }
    if (!ok) {
      lock.fails += 1;
      if (lock.fails >= 6) { lock.until = Date.now() + 10 * 60000; lock.fails = 0; }
      await this.storage.put(lockKey, lock);
      return fail(401, "La contraseña no coincide. Revisa que hayas elegido tu nombre.");
    }
    await this.storage.delete(lockKey);
    const token = randomToken();
    await this.storage.put("sess:" + token, { uid: id, exp: Date.now() + SESSION_DAYS * 86400000 });
    const secure = url.protocol === "https:" ? " Secure;" : "";
    return json({ ok: true }, 200, {
      "set-cookie": `sid=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${secure} SameSite=Lax`,
    });
  }

  async changeOwnPassword(s, body) {
    const current = body.current, next = clean(body.next, 100);
    if (!(await checkPassword(current, await this.storage.get("pw:" + s.uid))))
      return fail(400, "Tu contraseña actual no coincide.");
    if (next.length < 6) return fail(400, "La nueva contraseña debe tener al menos 6 caracteres.");
    await this.storage.put("pw:" + s.uid, await hashPassword(next));
    // Cierra las otras sesiones abiertas de esta persona.
    const all = await this.storage.list({ prefix: "sess:" });
    for (const [k, v] of all) if (v.uid === s.uid && k !== "sess:" + s.token) await this.storage.delete(k);
    return json({ ok: true });
  }

  async dashboard(s) {
    const wishes = await this.wishes(s.uid);
    const draw = await this.storage.get("draw");
    const mine = draw.done ? await this.storage.get("assign:" + s.uid) : null;
    return json({
      name: s.name,
      wishes: { count: wishes.length, max: MAX_WISHES, titles: wishes.map((w) => w.title) },
      draw: { done: !!draw.done, participating: !!mine, revealed: !!(await this.storage.get("revealed:" + s.uid)) },
    });
  }

  async saveWish(s, wid, body) {
    const list = await this.wishes(s.uid);
    const title = clean(body.title, 120);
    if (!title) return fail(400, "Escribe el nombre del regalo.");
    const image = cleanImage(body.image);
    if (image === null) return fail(400, "La imagen es muy grande o no es válida. Prueba con otra foto.");
    const data = { title, description: clean(body.description, 600), link: cleanLink(body.link), image };
    if (wid) {
      const i = list.findIndex((w) => w.id === wid);
      if (i < 0) return fail(404, "Ese deseo ya no existe.");
      list[i] = { ...list[i], ...data, updatedAt: Date.now() };
    } else {
      if (list.length >= MAX_WISHES) return fail(400, `Tu lista ya tiene ${MAX_WISHES} deseos. Borra uno para agregar otro.`);
      list.push({ id: randomToken().slice(0, 12).toLowerCase(), ...data, createdAt: Date.now() });
    }
    await this.storage.put("wishes:" + s.uid, list);
    return json({ wishes: list });
  }

  async deleteWish(s, wid) {
    const list = (await this.wishes(s.uid)).filter((w) => w.id !== wid);
    await this.storage.put("wishes:" + s.uid, list);
    return json({ wishes: list });
  }

  async secretStatus(s) {
    const draw = await this.storage.get("draw");
    const assigned = draw.done ? await this.storage.get("assign:" + s.uid) : null;
    return json({
      drawDone: !!draw.done,
      participating: !!assigned,
      revealed: !!(await this.storage.get("revealed:" + s.uid)),
    });
  }

  // Solo devuelve a quién le regala ESTA persona, y la lista de deseos de esa persona.
  async reveal(s) {
    const draw = await this.storage.get("draw");
    if (!draw.done) return fail(400, "El sorteo todavía no se ha hecho.");
    const rid = await this.storage.get("assign:" + s.uid);
    if (!rid) return fail(400, "No participaste en este sorteo. Habla con quien administra la app.");
    const receiver = (await this.members()).find((m) => m.id === rid);
    await this.storage.put("revealed:" + s.uid, true);
    return json({ receiver: { id: rid, name: receiver ? receiver.name : "?" }, wishes: await this.wishes(rid) });
  }

  // ---------- administración (no puede ver asignaciones) ----------
  async admin(path, method, body) {
    let members = await this.members();
    const draw = await this.storage.get("draw");

    if (path === "/state" && method === "GET") {
      const rows = [];
      for (const m of members) {
        rows.push({
          id: m.id, name: m.name, enabled: m.enabled,
          wishes: (await this.wishes(m.id)).length,
          revealed: draw.done ? !!(await this.storage.get("revealed:" + m.id)) : false,
          inDraw: draw.done ? (draw.participants || []).includes(m.id) : false,
        });
      }
      return json({ members: rows, draw: { done: !!draw.done, at: draw.at || null, count: (draw.participants || []).length } });
    }

    if (path === "/members" && method === "POST") {
      const name = clean(body.name, 40);
      const pw = clean(body.password, 100);
      if (!name) return fail(400, "Escribe el nombre del integrante.");
      if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) return fail(400, "Ya existe alguien con ese nombre.");
      if (pw.length < 6) return fail(400, "La contraseña debe tener al menos 6 caracteres.");
      let id = slugify(name), n = 2;
      while (members.some((m) => m.id === id) || id === "admin") id = slugify(name) + "-" + n++;
      members.push({ id, name, enabled: true });
      await this.storage.put("pw:" + id, await hashPassword(pw));
      await this.storage.put("members", members);
      return json({ ok: true });
    }

    const mm = path.match(/^\/members\/([a-z0-9-]+)(\/password)?$/);
    if (mm) {
      const m = members.find((x) => x.id === mm[1]);
      if (!m) return fail(404, "Ese integrante no existe.");
      if (mm[2] && method === "POST") {
        const pw = clean(body.password, 100);
        if (pw.length < 6) return fail(400, "La contraseña debe tener al menos 6 caracteres.");
        await this.storage.put("pw:" + m.id, await hashPassword(pw));
        const all = await this.storage.list({ prefix: "sess:" });
        for (const [k, v] of all) if (v.uid === m.id) await this.storage.delete(k);
        return json({ ok: true });
      }
      if (!mm[2] && method === "PUT") {
        if (typeof body.name === "string") {
          const name = clean(body.name, 40);
          if (!name) return fail(400, "El nombre no puede quedar vacío.");
          if (members.some((x) => x.id !== m.id && x.name.toLowerCase() === name.toLowerCase()))
            return fail(400, "Ya existe alguien con ese nombre.");
          m.name = name;
        }
        if (typeof body.enabled === "boolean") {
          if (draw.done) return fail(400, "El sorteo ya se hizo. Para cambiar participantes, reinicia el sorteo primero.");
          m.enabled = body.enabled;
        }
        await this.storage.put("members", members);
        return json({ ok: true });
      }
    }

    if (path === "/draw" && method === "POST") {
      if (draw.done) return fail(409, "El sorteo ya se realizó. Para hacerlo de nuevo, primero reinícialo.");
      const ids = members.filter((m) => m.enabled).map((m) => m.id);
      if (ids.length < 2) return fail(400, "Se necesitan al menos dos participantes.");
      // Mezcla aleatoria hasta que nadie quede consigo mismo (todas las asignaciones a la vez).
      let receivers;
      do {
        receivers = [...ids];
        for (let i = receivers.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [receivers[i], receivers[j]] = [receivers[j], receivers[i]];
        }
      } while (receivers.some((r, i) => r === ids[i]));
      const old = await this.storage.list({ prefix: "assign:" });
      for (const k of old.keys()) await this.storage.delete(k);
      for (let i = 0; i < ids.length; i++) await this.storage.put("assign:" + ids[i], receivers[i]);
      await this.storage.put("draw", { done: true, at: Date.now(), participants: ids });
      return json({ ok: true });
    }

    if (path === "/draw/reset" && method === "POST") {
      if (clean(body.confirm, 20).toUpperCase() !== "REINICIAR") return fail(400, "Escribe REINICIAR para confirmar.");
      for (const prefix of ["assign:", "revealed:"]) {
        const old = await this.storage.list({ prefix });
        for (const k of old.keys()) await this.storage.delete(k);
      }
      await this.storage.put("draw", { done: false });
      return json({ ok: true });
    }

    return fail(404, "No encontrado.");
  }
}
