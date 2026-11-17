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

> ¿No puedes escanear el QR (por ejemplo, en un servidor)? Pon el número en
> `PAIRING_NUMBER=5215512345678` dentro de `.env` y el bot te dará un **código de 8 dígitos**
> para usar en *Vincular con número de teléfono*.

## ¿Con qué número lo uso? (elige una opción)

### Opción A — En tu propio número (lo más rápido)

Vincula el bot con **tu** WhatsApp y mándale las fotos/enlaces a tu chat
**"Mensaje para ti" (Tú)**. Ya viene activado (`RESPOND_IN_SELF_CHAT=true`).

El bot **nunca** convierte lo que mandas a otras personas: solo reacciona en tu chat
personal (y en los grupos que tú autorices).

### Opción B — En un número aparte (recomendado si lo compartirás)

Vincula el bot con un segundo número (otro chip, WhatsApp Business, etc.) y en `.env` pon
el tuyo para que te responda:

```env
ALLOWED_NUMBERS=5215512345678
```

Puedes poner varios separados por comas. Si se te olvida, cuando alguien no autorizado le
escriba el bot muestra su número en la consola para que lo copies.
Con `ALLOW_EVERYONE=true` le responde a cualquiera (bot público).

### Grupos (opcional)

Agrega el bot a un grupo, escribe **`!id`** y copia el ID que te responde (también sale en
la consola) en `.env`:

```env
ALLOWED_GROUPS=120363000000000000@g.us
```

En esos grupos convierte toda foto, video o enlace que se mande.

Después de cambiar `.env`, reinicia el bot.

## Comandos

| Comando                 | Qué hace                                                        |
| ----------------------- | --------------------------------------------------------------- |
| *(mandar foto/video/enlace)* | Lo convierte en sticker automáticamente                    |
| `recortar` en el texto  | Sticker recortado al cuadrado (sin bordes transparentes)        |
| `!s` respondiendo a un mensaje | Convierte la foto, video o enlace del mensaje citado     |
| `!ayuda`                | Muestra la ayuda                                                |
| `!id`                   | Muestra el ID del chat (para configurar grupos)                 |

Mientras trabaja reacciona con ⏳, al terminar con ✅ y si algo falla con ❌ (y te dice por qué).

## Configuración (`.env`)

| Variable                   | Por defecto     | Descripción |
| -------------------------- | --------------- | ----------- |
| `STICKER_PACK_NAME`        | `Bot Stickers`  | Nombre del paquete que se ve al tocar el sticker |
| `STICKER_AUTHOR`           | `bot-stickers`  | Autor del sticker |
| `RESPOND_IN_SELF_CHAT`     | `true`          | Responder en tu chat "Mensaje para ti" |
| `ALLOWED_NUMBERS`          | *(vacío)*       | Números que pueden usar el bot por privado |
| `ALLOWED_GROUPS`           | *(vacío)*       | IDs de grupos donde funciona |
| `ALLOW_EVERYONE`           | `false`         | Responder a cualquier chat privado |
| `PAIRING_NUMBER`           | *(vacío)*       | Vincular con código en vez de QR |
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
├── handler.js        # qué hacer con cada mensaje
├── access.js         # quién puede usar el bot
├── messages.js       # leer texto, medios, citas y comandos
├── sticker.js        # ffmpeg → WebP 512×512 + metadatos
├── download.js       # descargas con límite, HLS y yt-dlp
├── limiter.js        # límite de conversiones simultáneas
└── sources/
    ├── twitter.js    # X / Twitter
    └── pinterest.js  # Pinterest
```

## Aviso

Este proyecto usa una librería **no oficial** de WhatsApp. Úsalo para fines personales y
con moderación: WhatsApp puede bloquear números que envían mensajes masivos o automatizados.
Si te preocupa, usa un número secundario (opción B). Respeta los derechos de autor del
contenido que conviertas.
