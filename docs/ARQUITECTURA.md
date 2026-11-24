# Navidad en Familia — Especificación técnica

Este documento describe cómo está construida la aplicación, por qué se tomaron esas decisiones y qué buenas prácticas de desarrollo y de seguridad sigue. Complementa la especificación de producto (`Navidad.md`).

## 1. Resumen

| Tema | Decisión |
|---|---|
| Tipo de app | Aplicación web de una sola página (SPA), responsive, pensada primero para teléfonos |
| Servidor | Cloudflare Workers (plan gratuito) |
| Base de datos | Un Durable Object con almacenamiento SQLite persistente (plan gratuito) |
| Frontend | HTML, CSS y JavaScript sin frameworks, en un solo archivo |
| Código | GitHub (`HedyAnn/navidad2026`) |
| Publicación | Cloudflare Workers Builds: cada cambio en la rama `main` se publica solo |
| Dirección | `https://navidad2026.<cuenta>.workers.dev` |

**Por qué esta arquitectura.** La app es para 5 personas y unas semanas de uso. Se priorizó: costo cero, un solo link público, datos que no se pierden, la menor cantidad de piezas posible y que la confidencialidad del sorteo se garantice en el servidor. Cloudflare Workers no se “duerme” como otros hostings gratuitos, y el Durable Object da una base de datos consistente sin tener que crear ni configurar nada aparte.

## 2. Diagrama

```
 Teléfono / computador
        │  HTTPS (cookie de sesión HttpOnly)
        ▼
 ┌─────────────────────────────┐
 │ Worker (src/worker.js)       │
 │  GET /        → app.html     │
 │  /api/*       → Casa         │
 └──────────────┬──────────────┘
                ▼
 ┌─────────────────────────────┐
 │ Durable Object "Casa"        │  ← una sola instancia
 │  • autenticación y sesiones  │     procesa las solicitudes
 │  • listas de deseos          │     de a una (sin carreras)
 │  • sorteo y asignaciones     │
 │  • administración            │
 │  Almacenamiento SQLite       │
 └─────────────────────────────┘
```

## 3. Estructura del repositorio

```
src/worker.js     Servidor: rutas, permisos, sorteo, contraseñas
src/app.html      Interfaz completa (estilos y JavaScript incluidos)
src/seed.js       Integrantes iniciales y HASH de sus contraseñas (nunca el texto)
tests/            Pruebas de punta a punta de la API
preview/          Vista previa con servidor simulado (no se publica)
docs/             Esta documentación
wrangler.toml     Configuración de Cloudflare
```

## 4. Modelo de datos

Se guarda como pares clave → valor dentro del Durable Object.

| Clave | Contenido |
|---|---|
| `members` | Lista de integrantes: `{ id, name, enabled }` |
| `pw:<id>` | `{ salt, hash }` de la contraseña (también `pw:admin`) |
| `wishes:<id>` | Hasta 6 deseos: `{ id, title, description, link, image }` |
| `draw` | `{ done, at, participants[] }` |
| `assign:<id>` | El `id` de la persona a quien `<id>` le regala |
| `revealed:<id>` | `true` cuando la persona ya abrió su regalo |
| `sess:<token>` | `{ uid, exp }` sesión activa |
| `lock:<id>` | Intentos fallidos de ingreso |

Las imágenes se reducen en el navegador (máximo 640 px, JPEG) y se guardan junto al deseo, con un límite de ~200 KB cada una.

## 5. API

Todas las respuestas son JSON. Las rutas marcadas con 🔒 exigen sesión.

| Método y ruta | Quién | Qué hace |
|---|---|---|
| `GET /api/members` | Público | Nombres para el selector de ingreso (sin datos sensibles) |
| `POST /api/login` | Público | Ingreso con integrante + contraseña |
| `POST /api/logout` | Cualquiera | Cierra la sesión |
| `GET /api/me` 🔒 | Todos | Quién soy |
| `POST /api/password` 🔒 | Todos | Cambia la propia contraseña (pide la actual) |
| `GET /api/dashboard` 🔒 | Integrante | Resumen para el inicio |
| `GET/POST /api/wishes` 🔒 | Integrante | Ver o agregar deseos **propios** |
| `PUT/DELETE /api/wishes/:id` 🔒 | Integrante | Editar o borrar un deseo **propio** |
| `GET /api/secret` 🔒 | Integrante | Estado del sorteo para mí |
| `POST /api/secret/reveal` 🔒 | Integrante | Mi amigo secreto y **solo su** lista |
| `GET /api/admin/state` 🔒 | Admin | Estado general (sin asignaciones) |
| `POST /api/admin/members` 🔒 | Admin | Agregar integrante |
| `PUT /api/admin/members/:id` 🔒 | Admin | Cambiar nombre o participación |
| `POST /api/admin/members/:id/password` 🔒 | Admin | Restablecer contraseña |
| `POST /api/admin/draw` 🔒 | Admin | Hacer el sorteo (una sola vez) |
| `POST /api/admin/draw/reset` 🔒 | Admin | Reiniciar, exige escribir `REINICIAR` |

## 6. Reglas de negocio y cómo se cumplen

| Regla | Implementación |
|---|---|
| Solo integrantes registrados | No existe ruta de registro. Solo la administración agrega personas. |
| Cada uno edita solo su lista | Las rutas de deseos no reciben el dueño como parámetro: siempre usan el de la sesión. |
| La lista se ve solo por su dueño y por quien lo tiene en el sorteo | No hay ruta para ver listas ajenas. La única forma es `secret/reveal`, que busca `assign:<yo>` en el servidor. |
| Nadie se asigna a sí mismo; cada uno da y recibe exactamente un regalo | Se mezcla la lista con un generador aleatorio criptográfico (Fisher–Yates) y se repite hasta que nadie quede consigo mismo. Así cada combinación válida tiene la misma probabilidad. Las pruebas automáticas lo verifican. |
| Todas las asignaciones se generan a la vez | Se calculan en memoria y se guardan juntas dentro de la misma solicitud. |
| No se sortea dos veces por accidente | Si `draw.done` es verdadero la ruta responde 409. El Durable Object procesa una solicitud a la vez, así que dos clics simultáneos no generan dos sorteos. Reiniciar exige escribir `REINICIAR`. |
| La administración no conoce las asignaciones | Ninguna ruta de administración lee ni devuelve claves `assign:`. La cuenta de administración no puede usar `secret/reveal`. |
| Mínimo dos participantes | Validado en el servidor antes de sortear. |
| Persistencia | Almacenamiento durable de Cloudflare; sobrevive a cierres de sesión y a nuevas publicaciones. |

## 7. Seguridad

**Contraseñas**
- Se guardan con PBKDF2-SHA-256, 100.000 iteraciones y una sal aleatoria de 16 bytes por persona. Nunca se guardan en texto ni aparecen en el código: `seed.js` contiene solo hashes.
- La comparación del hash se hace en tiempo constante.
- Mínimo 6 caracteres. Cambiar la contraseña exige la actual y cierra las otras sesiones de esa persona. Restablecerla desde administración cierra todas sus sesiones.
- Tras 6 intentos fallidos sobre el mismo integrante, el ingreso se bloquea 10 minutos.

**Sesiones**
- Token aleatorio de 256 bits guardado en el servidor, con vencimiento a los 30 días.
- Cookie `HttpOnly` (JavaScript no puede leerla), `Secure` (solo HTTPS) y `SameSite=Lax`.
- Cerrar sesión borra el token en el servidor.

**Autorización**
- Cada solicitud vuelve a validar la sesión y el rol en el servidor. Ocultar botones en la interfaz es solo comodidad; la protección está en el backend.
- Las rutas de integrante y de administración están separadas por rol.

**Protección contra ataques comunes**
- *CSRF*: se rechazan solicitudes que cambian datos si vienen de otro origen, y se exige `Content-Type: application/json` (un formulario de otro sitio no puede enviarlo sin permiso del navegador).
- *XSS*: todo texto escrito por usuarios se escapa antes de mostrarse. Los enlaces solo aceptan `http`/`https` y se abren con `rel="noopener noreferrer"`. Las imágenes solo aceptan `data:image/jpeg|png|webp`.
- *Clickjacking*: cabecera `X-Frame-Options: DENY`.
- Las respuestas de la API llevan `Cache-Control: no-store`.
- Límites de tamaño en todos los campos (nombre 120, descripción 600, enlace 600, imagen ~200 KB, 6 deseos).
- La página pide no ser indexada por buscadores (`noindex`).
- Los errores del servidor no muestran detalles internos al usuario.

**Riesgos aceptados (por el tamaño del proyecto)**
- La lista de nombres del selector es pública, como pide la especificación.
- No hay verificación en dos pasos ni recuperación de contraseña por correo; la administración restablece contraseñas a mano.
- Quien tenga acceso a la cuenta de Cloudflare podría leer el almacenamiento. Mantener esa cuenta protegida (idealmente con verificación en dos pasos).

## 8. Buenas prácticas de desarrollo

- **Simplicidad**: sin frameworks ni dependencias en producción; dos archivos principales fáciles de leer.
- **Validación en el servidor** de todo dato que entra, aunque la interfaz también valide.
- **Mensajes claros** en español, que dicen qué pasó y cómo seguir.
- **Accesibilidad**: contraste suficiente, foco visible al navegar con teclado, botones de 48 px para el dedo, etiquetas en cada campo, respeta “reducir movimiento” del sistema.
- **Responsive**: diseño para teléfono primero; navegación inferior en móviles y superior en computador.
- **Pruebas**: `tests/api.test.mjs` recorre el flujo completo y verifica las reglas de privacidad.
- **Control de versiones**: todo cambio pasa por GitHub; Cloudflare publica desde `main`.
- **Sin secretos en el repositorio**: no hay contraseñas ni llaves en el código.

## 9. Cómo trabajar con el proyecto

```bash
npm install          # instala wrangler (solo para desarrollo)
npm run dev          # app local en http://127.0.0.1:8787
TEST_PASSWORDS='{"mario":"...","maria-angelica":"...","maria-jesus":"...","christian":"...","hedy":"...","admin":"..."}' npm test
npm run deploy       # publicación manual (normalmente la hace Cloudflare al subir a main)
```

Las pruebas hacen y reinician un sorteo: correrlas solo en local, nunca contra la app publicada.

## 10. Operación durante la temporada

1. Entregar a cada integrante su contraseña en privado y pedirle que la cambie en “Mi perfil”.
2. Esperar a que todos completen sus listas (la administración ve quién falta).
3. Revisar participantes y hacer el sorteo desde Administración.
4. Si alguien olvida su contraseña, restablecerla desde Administración.
5. Para una nueva Navidad: reiniciar el sorteo, ajustar integrantes y volver a sortear.
