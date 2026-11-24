# Navidad en Familia 🎄

Aplicación web privada para que la familia comparta sus listas de deseos y haga el sorteo del Amigo Secreto.

- Ingreso con nombre y contraseña personal.
- Lista de deseos de hasta 6 regalos, con descripción, enlace y foto.
- Sorteo aleatorio y confidencial: cada persona ve solo a quién le regala y la lista de esa persona.
- Panel de administración para integrantes, contraseñas y sorteo.

Funciona en Cloudflare Workers (gratis). La documentación técnica está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

```bash
npm install
npm run dev   # http://127.0.0.1:8787
```

## Administración

Desde "Entrar como administración" se pueden agregar, editar, sacar del sorteo o eliminar integrantes, restablecer contraseñas y hacer el sorteo cuando todos estén listos.
