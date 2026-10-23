# RG Asesorías y Seguros — Puesta en marcha (GitHub Pages + Supabase)

Arquitectura (la misma de La Percha):
- **GitHub Pages** sirve la web (`index.html`), el panel (`admin/`) y la página de caso del cliente (`caso/`).
- **Supabase** guarda solicitudes, conversaciones y actividad, gestiona el inicio de sesión del equipo y ejecuta dos Edge Functions:
  - `rg-ai`: el asistente, con la clave de Anthropic solo en el servidor;
  - `notificar-cliente`: el correo al cliente cuando un asesor le responde.

> Nunca pongas la clave `service_role`, la contraseña de la base de datos, la clave de Anthropic ni la contraseña del correo en `config.js` ni en el repositorio.

## 1. Crear el proyecto de Supabase
1. https://supabase.com → **New project** (región recomendada: *South America (São Paulo)*).
2. **SQL Editor → New query** → pega TODO `supabase/01_esquema.sql` → **Run**. Se puede volver a ejecutar sin perder datos.
3. **Project Settings → API Keys**: copia la **Project URL** y la clave **publishable** en `config.js`:
   ```js
   window.RG_CONFIG = { supabaseUrl: 'https://TU-PROYECTO.supabase.co', supabaseKey: 'sb_publishable_...' };
   ```

## 2. Inicio de sesión del equipo
1. **Authentication → Sign In / Providers**: desactiva **Allow new users to sign up**. Nadie puede registrarse solo.
2. **Authentication → URL Configuration**: en **Site URL** pon la URL de GitHub Pages (p. ej. `https://TU-USUARIO.github.io/TU-REPO/`).
3. **Authentication → Users → Add user → Create new user**: correo y contraseña de la dueña, con **Auto Confirm User** marcado.
4. En **SQL Editor**, dale el rol de administración:
   ```sql
   update public.perfiles set rol = 'admin', nombre = 'NOMBRE DE LA DUEÑA' where email = 'CORREO_DE_LA_DUEÑA';
   ```
5. Para cada asesor, créalo igual en *Add user*. Después la dueña le asigna el rol desde el panel → **Equipo**. Una cuenta sin rol no ve nada.

## 3. Edge Functions (RG AI y correos)
Requiere [Node.js](https://nodejs.org). Desde la carpeta del repositorio:
```bash
npx supabase login
npx supabase link --project-ref TU_PROJECT_REF
npx supabase functions deploy rg-ai --no-verify-jwt
npx supabase functions deploy notificar-cliente
```
Secretos (en **Edge Functions → Secrets** o por consola):
```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGINS=https://TU-USUARIO.github.io SITE_URL=https://TU-USUARIO.github.io/TU-REPO/
npx supabase secrets set SMTP_HOST=smtp.office365.com SMTP_PORT=587 SMTP_USER=Comercial@rgasesoriasyseguros.com.co SMTP_PASS=... "SMTP_FROM=RG Asesorías y Seguros <Comercial@rgasesoriasyseguros.com.co>"
```

| Secreto | Para qué | De dónde sale |
|---|---|---|
| `ANTHROPIC_API_KEY` | RG AI | https://platform.claude.com → API Keys (cuenta con método de pago). **Define un límite de gasto mensual.** |
| `ALLOWED_ORIGINS` | Solo tu sitio puede usar RG AI | El origen de GitHub Pages, sin ruta. Si luego usas el dominio propio, agrégalo separado por coma: `https://www.rgasesoriasyseguros.com.co` |
| `SITE_URL` | Enlace al caso dentro del correo | URL completa del sitio, terminada en `/` |
| `SMTP_*` | Correo al cliente cuando el asesor responde | **Microsoft 365**: `smtp.office365.com`, puerto 587. El administrador de M365 debe habilitar *SMTP AUTH* en ese buzón. Alternativa: Gmail con contraseña de aplicación (`smtp.gmail.com`, 587), como en La Percha. |
| `RG_AI_MODELO` | Opcional | Por defecto `claude-opus-5-5` |

Sin SMTP todo funciona igual: el mensaje queda en el caso y el panel avisa al asesor que debe compartir el enlace por WhatsApp (botón incluido).

## 4. Publicar en GitHub Pages
Sube al repositorio: `index.html`, `config.js`, `assets/`, `admin/`, `caso/` y `supabase/` (no contiene secretos).
Después: **Settings → Pages → Deploy from a branch → main / (root)**.

## 5. Pruebas después de instalar (hazlas en este orden)
1. Envía el formulario de Contacto con tus datos. Debe llevarte a la página de tu caso (`caso/#…`).
2. Entra a `TU-SITIO/admin/` con la cuenta de la dueña. La solicitud aparece con un punto rojo y el indicador dice **En vivo**.
3. Responde desde el panel. Debe llegar el correo con el botón "Ver y responder" y, en la página del caso, la respuesta (no las notas internas).
4. Contesta desde la página del caso. En el panel aparece el aviso "Nuevo mensaje de un cliente".
5. Abre RG AI en la web y pregunta algo. En el panel → Resumen sube "Consultas a RG AI".
6. Entra con un asesor: no debe ver Resumen ni Equipo.

## Qué hace cada pieza
- Datos y permisos: `supabase/01_esquema.sql`. Ninguna tabla es accesible desde el navegador público; todo pasa por funciones que validan rol y datos. Hay límites antispam por IP en el formulario y en RG AI.
- Panel: `admin/` (Resumen y Equipo solo para administración).
- Página de caso del cliente: `caso/`. El enlace lleva un código secreto en la parte `#…`, que el navegador no envía a ningún servidor.
- Ley 1581: el formulario guarda la fecha de la autorización. Desde el panel, la administración puede eliminar los datos de un titular que lo pida.
