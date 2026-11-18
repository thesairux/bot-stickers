# bot-stickers 🤖✨

Bot de WhatsApp que convierte en **sticker** todo lo que le mandes:

| Le mandas…                                   | Te devuelve…                                   |
| -------------------------------------------- | ---------------------------------------------- |
| 📷 Una foto                                   | Sticker normal                                 |
| 🎥 Un video o GIF                             | Sticker animado (primeros 8 s)                 |
| 🐦 Un enlace de **X / Twitter**               | Un sticker por cada foto / video / GIF del tweet |
| 📌 Un enlace de **Pinterest** (`pin.it/…` o `pinterest.com/pin/…`) | Sticker de la imagen, GIF o video del pin (incluye *idea pins* con varias páginas) |

Los stickers son WebP de 512×512 que **mantienen la proporción** de la imagen con bordes
transparentes. Si prefieres que llene todo el cuadrado, escribe **`recortar`** en el pie de
foto o junto al enlace.

Inspirado en [Daniel-Cossio/whatsapp-sticker-bot](https://github.com/Daniel-Cossio/whatsapp-sticker-bot).

---

## Cómo funciona

El bot usa [Baileys](https://github.com/WhiskeySockets/Baileys) para conectarse a WhatsApp
como un **dispositivo vinculado** (igual que WhatsApp Web), así que no necesitas la API
oficial ni pagar nada. Luego:

- **Fotos / videos**: los descarga de WhatsApp y los convierte con `ffmpeg`.
- **X / Twitter**: obtiene los medios con las APIs públicas de FxTwitter / VxTwitter
  (y `yt-dlp` como respaldo).
- **Pinterest**: resuelve los enlaces cortos `pin.it`, consulta la API pública de
  Pinterest (la misma que usa la web) y, si falla, lee el HTML del pin o usa `yt-dlp`.

## Requisitos

- **Node.js 20 o superior**
- **ffmpeg** (con soporte WebP; las versiones normales lo traen)
- **yt-dlp** (opcional pero recomendado: es el respaldo para videos)

```bash
# Ubuntu / Debian
sudo apt install ffmpeg python3-pip && pip install -U yt-dlp
# macOS
brew install node ffmpeg yt-dlp
# Windows (PowerShell)
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp
```

## Instalación

```bash
git clone https://github.com/thesairux/bot-stickers.git
cd bot-stickers
npm install
cp .env.example .env     # en Windows: copy .env.example .env
npm start
```

La primera vez aparece un **código QR** en la terminal. En tu teléfono abre
WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo** y escanéalo.
La sesión se guarda en la carpeta `auth_info/`, así que no tendrás que volver a escanear.

Al conectarse, el bot se pone como **foto de perfil** la imagen `assets/profile.jpg` 🐱 y
como **descripción** *"stickers :D made by triton"* (solo la primera vez o cuando las
cambias). Para usar otras, cambia `PROFILE_PICTURE` / `PROFILE_STATUS` en `.env`; la foto se
recorta al centro en cuadrado automáticamente.

> ¿No puedes escanear el QR (por ejemplo, en un servidor)? Pon el número en
> `PAIRING_NUMBER=5215512345678` dentro de `.env` y el bot te dará un **código de 8 dígitos**
> para usar en *Vincular con número de teléfono*.

## ¿Con qué número lo uso? (elige una opción)

### Opción A — En tu propio número (lo más rápido)

Vincula el bot con **tu** WhatsApp y mándale las fotos/enlaces a tu chat
**"Mensaje para ti" (Tú)**. Ya viene activado (`RESPOND_IN_SELF_CHAT=true`).

El bot **nunca** convierte lo que mandas a otras personas: solo reacciona en tu chat
personal (y en los grupos que tú autorices).

> ⚠️ En esta opción el bot **es** tu cuenta, así que la foto y descripción del bot serían las
> tuyas. Si no quieres que las cambie, pon `PROFILE_PICTURE=` y `PROFILE_STATUS=` (vacíos)
> en `.env`.

### Opción B — En un número aparte (recomendado si lo compartirás)

Vincula el bot con un segundo número (otro chip, WhatsApp Business, etc.) y en `.env` pon
el tuyo para que te responda:

```env
ALLOWED_NUMBERS=5215512345678
```

Puedes poner varios separados por comas. Si se te olvida, cuando alguien no autorizado le
escriba el bot muestra su número en la consola para que lo copies.

**¿Bot público?** Si el número es solo del bot, pon `ALLOW_EVERYONE=true`: a **cualquiera**
que le mande una foto, video o enlace le devuelve el sticker, y a quien solo escriba texto
("hola") le explica una vez qué mandar. Para evitar abusos, cada persona fuera de
`ALLOWED_NUMBERS` puede pedir como máximo `PUBLIC_RATE_LIMIT` stickers por minuto.

### Grupos (opcional)

Agrega el bot a un grupo, escribe **`!id`** y copia el ID que te responde (también sale en
la consola) en `.env`:

```env
ALLOWED_GROUPS=120363000000000000@g.us
```

En esos grupos convierte toda foto, video o enlace que se mande.

Después de cambiar `.env`, reinicia el bot.

## Comandos

Hay dos formas de pedir stickers:

- **Automático** (sin escribir nada): en tu chat "Mensaje para ti", con los números de
  `ALLOWED_NUMBERS` y en los grupos de `ALLOWED_GROUPS`, toda foto, video o enlace se
  convierte solo.
- **Con `.sticker`** (para cualquiera, en privado o en grupos, si `PUBLIC_COMMANDS=true`):

| Comando                 | Qué hace                                                        |
| ----------------------- | --------------------------------------------------------------- |
| Foto/video con `.sticker` en el texto | Lo convierte en sticker                           |
| Responder `.sticker` a un mensaje | Convierte la foto, video, GIF o enlace del mensaje citado |
| `.sticker <enlace>`     | Convierte el enlace de X o Pinterest                            |
| `.sticker recortar`     | Sticker recortado al cuadrado (sin bordes transparentes)        |
| `.ayuda`                | Muestra la ayuda                                                |
| `.id`                   | Muestra el ID del chat (para configurar grupos)                 |

También sirven con `!` o `/` (`!sticker`, `/s`…) y la forma corta `.s`. Tú puedes usar
`.sticker` en cualquier chat (por ejemplo, respondiendo a una foto que te mandó un amigo).
Para evitar abusos, cada persona que no está en tus listas puede pedir como máximo
`PUBLIC_RATE_LIMIT` stickers por minuto.

Mientras trabaja reacciona con ⏳, al terminar con ✅ y si algo falla con ❌ (y te dice por qué).

## Configuración (`.env`)

| Variable                   | Por defecto     | Descripción |
| -------------------------- | --------------- | ----------- |
| `STICKER_PACK_NAME`        | `Bot Stickers`  | Nombre del paquete que se ve al tocar el sticker |
| `STICKER_AUTHOR`           | `bot-stickers`  | Autor del sticker |
| `RESPOND_IN_SELF_CHAT`     | `true`          | Responder en tu chat "Mensaje para ti" |
| `ALLOWED_NUMBERS`          | *(vacío)*       | Números que pueden usar el bot por privado |
| `ALLOWED_GROUPS`           | *(vacío)*       | IDs de grupos donde funciona |
| `ALLOW_EVERYONE`           | `false`         | Bot público: convierte lo que cualquiera le mande en privado, sin comando |
| `PUBLIC_COMMANDS`          | `true`          | Cualquiera puede pedir stickers con `.sticker` (privado o grupos) |
| `PUBLIC_RATE_LIMIT`        | `5`             | Máximo de stickers por minuto por persona fuera de `ALLOWED_NUMBERS` |
| `LOG_MESSAGES`             | `true`          | Mostrar en la consola qué recibe el bot y qué hace |
| `PAIRING_NUMBER`           | *(vacío)*       | Vincular con código en vez de QR |
| `PROFILE_PICTURE`          | `assets/profile.jpg` | Foto de perfil del bot (vacío = no cambiarla) |
| `PROFILE_STATUS`           | `stickers :D made by triton` | Descripción ("Info") del bot, máx. 139 caracteres (vacío = no cambiarla) |
| `MAX_VIDEO_SECONDS`        | `8`             | Duración máxima del sticker animado |
| `MAX_DOWNLOAD_MB`          | `60`            | Tamaño máximo de archivo a descargar |
| `MAX_STICKERS_PER_MESSAGE` | `6`             | Máximo de stickers por mensaje/enlace |
| `CONCURRENCY`              | `2`             | Conversiones simultáneas |
| `YTDLP_PATH`               | `yt-dlp`        | Ruta a `yt-dlp` |
| `AUTH_DIR`                 | `auth_info`     | Carpeta donde se guarda la sesión |
| `LOG_LEVEL`                | `warn`          | Logs de Baileys (`silent`, `info`, `debug`…) |

## Con Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f      # aquí aparece el QR la primera vez
```

La sesión queda en `./auth_info`, así que sobrevive a reinicios del contenedor.

## ¿Dónde dejarlo corriendo?

Gasta poco (≈300 MB de RAM), **no necesita abrir puertos** y solo pide un disco que no se
borre (para `auth_info/`). Sirve:

- Tu PC / laptop encendida, una Raspberry Pi o un Android viejo con Termux.
- Una VM gratis: **Oracle Cloud Always Free**, **Google Cloud e2-micro**, o AWS/Azure
  (12 meses gratis).
- Evita servicios que se "duermen" o borran el disco (planes gratis de Render, Vercel,
  Netlify…): se cae la conexión y pierdes la sesión.

## Problemas comunes

- **No me responde**: revisa la consola. Si dice *"Ignoré un mensaje de …"*, agrega ese
  número a `ALLOWED_NUMBERS`. En la opción A, asegúrate de escribir en el chat
  **"Mensaje para ti"**.
- **"ffmpeg no está instalado"**: instálalo y verifica que `ffmpeg -version` funcione.
- **Un enlace de X o Pinterest falla**: actualiza `yt-dlp` (`pip install -U yt-dlp`);
  esos sitios cambian seguido. Los posts privados o con restricción de edad no se pueden
  descargar.
- **Sale "QR expiró" o "código 408"**: el QR dura ~1 minuto; si no alcanzas, aparece uno
  nuevo solo. Si la terminal lo muestra deformado, abre la imagen `qr.png` que se crea en la
  carpeta del bot, o usa `PAIRING_NUMBER` para vincular con código. Si dice *"no se pudo
  establecer la conexión"*, revisa tu internet (VPN, wifi del colegio/trabajo, antivirus).
- **Se desvinculó**: si cierras la sesión desde el teléfono el bot borra `auth_info/` y se
  apaga; vuelve a iniciarlo para escanear un QR nuevo.

## Desarrollo

```bash
npm test
```

```
src/
├── index.js          # punto de entrada
├── bot.js            # conexión a WhatsApp (QR / código, reconexión)
├── connection.js     # explica por qué se cortó la conexión
├── handler.js        # qué hacer con cada mensaje
├── access.js         # quién puede usar el bot
├── messages.js       # leer texto, medios, citas y comandos
├── sticker.js        # ffmpeg → WebP 512×512 + metadatos
├── download.js       # descargas con límite, HLS y yt-dlp
├── limiter.js        # límite de conversiones simultáneas
├── profile.js        # foto y descripción del perfil del bot
└── sources/
    ├── twitter.js    # X / Twitter
    └── pinterest.js  # Pinterest
```

## Aviso

Este proyecto usa una librería **no oficial** de WhatsApp. Úsalo para fines personales y
con moderación: WhatsApp puede bloquear números que envían mensajes masivos o automatizados.
Si te preocupa, usa un número secundario (opción B). Respeta los derechos de autor del
contenido que conviertas.
