# Kilómetro 0 — Plataforma de Venta Directa Local

Una aplicación web full-stack diseñada para conectar productores agroalimentarios locales con consumidores de proximidad, fomentando el comercio justo, la sostenibilidad y la reducción de la huella de carbono («kilómetro cero»).

---

## 1. Back-End

### 1.1 Requisitos previos
- [Node.js](https://nodejs.org/) v18 o superior
- [Docker](https://www.docker.com/) y Docker Compose

### 1.2 Instalación rápida

```bash
git clone <URL_DEL_REPOSITORIO>
cd kilometro0
npm install
```

### 1.3 Variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
PORT=3000

# Base de datos (el contenedor Docker mapea 5432→5435)
DATABASE_URL=postgres://km0_user:km0_password@localhost:5435/km0_db
DB_HOST=localhost
DB_PORT=5435
DB_NAME=km0_db
DB_USER=km0_user
DB_PASSWORD=km0_password

# Autenticación
JWT_SECRET=tu_clave_secreta_aqui

# Credenciales del administrador por defecto
ADMIN_EMAIL=admin@admin
ADMIN_PASS=admin
ADMIN_CONTACT_EMAIL=admin@km0local.es

# Correo (dejar vacío para usar Ethereal en modo test)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=

# GeoServer (interno — usado por el servidor Node.js)
GEOSERVER_URL=http://localhost:8080/geoserver
# GeoServer (público — usado por el navegador para WMS)
GEOSERVER_PUBLIC_URL=http://<IP_PUBLICA>:8080/geoserver
GEOSERVER_USER=admin
GEOSERVER_PASS=geoserver
GEOSERVER_WORKSPACE=km0
# Workspace de la capa de límites provinciales
GEOSERVER_PROVINCES_WORKSPACE=gggggggggg
SHAPEFILE_DIR=./geoserver_shapefiles

# pygeoapi
PYGEOAPI_URL=http://localhost:5000
```

### 1.4 Levantar los servicios

```bash
docker compose up -d          # PostGIS (5435), GeoServer (8080), pygeoapi (5000)
npm run db:init               # Crea el esquema (tablas, tipos, índices espaciales)
npm run db:seed               # Poblado inicial con datos de prueba
npm start                     # Servidor en http://localhost:3000
```

En producción (VM sin gestor de procesos):
```bash
nohup node server/server.js > app.log 2>&1 &
```

Para reiniciar después de un `git pull`:
```bash
kill -9 $(lsof -t -i:3000) 2>/dev/null; sleep 1
nohup node server/server.js > app.log 2>&1 &
```

> **Nota:** el archivo `.env` está en `.gitignore`. En el servidor de producción hay que crearlo/editarlo manualmente y reiniciar el proceso Node.js para que los cambios tengan efecto.

---

## 2. Arquitectura

### 2.1 Back-End: Node.js + Express
- **Autenticación:** JWT firmado con `jsonwebtoken`, almacenado en cookie `httpOnly` con `sameSite: lax` y expiración de 7 días. Las contraseñas se hashean con `bcrypt`.
- **Base de datos:** Pool de conexiones `pg` a PostgreSQL/PostGIS. Transacciones con `BEGIN/COMMIT/ROLLBACK` y bloqueo optimista (`FOR UPDATE`) para control de stock en pedidos concurrentes.

### 2.2 Base de Datos: PostgreSQL + PostGIS
- Geometrías espaciales en columnas `GEOGRAPHY(Point, 4326)` para las ubicaciones de productores.
- Cálculos de proximidad usando `ST_Distance` y `ST_MakePoint`.
- Índices espaciales GIST para búsquedas por radio eficientes.

### 2.3 Servicios geoespaciales

#### GeoServer
Publica las parcelas catastrales de cada productor verificado como capas WFS (`km0:parcel_<id>`), y también aloja la capa de límites provinciales (`gggggggggg:provincias`).

#### pygeoapi — Proceso catastral
`pygeoapi/processes/catastro_parcela.py` implementa un proceso OGC API-Processes que recibe una referencia catastral y devuelve la huella de la parcela en GeoJSON (EPSG:4326) consultando el WFS INSPIRE del Catastro.

> Las referencias **forales** (País Vasco y Navarra) no están cubiertas por el WFS INSPIRE nacional; en ese caso no se genera parcela y se mantiene únicamente el marcador-punto.

#### Flujo de aprovisionamiento de parcelas
Al registrarse un productor con referencia catastral, el backend ejecuta en segundo plano (*fire-and-forget*):
1. Llama al proceso pygeoapi para obtener la geometría de la parcela.
2. Convierte la geometría en shapefile con `mapshaper`.
3. Publica el shapefile en GeoServer vía su API REST.
4. Guarda el nombre de la capa en `users.parcel_layer`.

```bash
# Probar el proceso de forma aislada:
curl -X POST http://localhost:5000/processes/catastro-parcela/execution \
  -H "Content-Type: application/json" \
  -d '{"inputs":{"referencia_catastral":"<RC>"}}'
```

#### Proxy de capas geoespaciales
Para evitar problemas de CORS, el navegador no accede directamente a GeoServer para las capas vectoriales:

| Endpoint | Descripción |
|---|---|
| `GET /api/parcels` | FeatureCollection GeoJSON con las parcelas de productores verificados |
| `GET /api/provincias` | FeatureCollection GeoJSON con los límites provinciales (cacheado en memoria) |

---

## 3. Front-End

### 3.1 Stack
- **Plantillas:** EJS (SSR con Express)
- **Estilos:** Vanilla CSS con variables CSS (`--primary`, `--shadow-sm`…). Sin frameworks externos.
- **Lógica:** Vanilla JavaScript + Fetch API

### 3.2 Mapa interactivo (Leaflet)

El mapa de la página principal combina varias capas:

| Capa | Tipo | Descripción |
|---|---|---|
| OpenStreetMap | Tile base | Siempre visible |
| Marcadores de productores | Leaflet markers | Filtrados dinámicamente; color por categoría de producto |
| Parcelas catastrales | GeoJSON overlay | Polígono de la finca de cada productor verificado |
| **Ortofoto PNOA** (opcional) | WMS — IGN España | Activable desde el panel de capas; opacidad 75 % para mantener visible el OSM |
| **Límites provinciales** (opcional) | GeoJSON — GeoServer | Activable desde el panel de capas; cargado bajo demanda vía `/api/provincias` |

**Panel de capas** (esquina superior derecha del mapa): dos checkboxes para activar/desactivar la ortofoto PNOA y los límites provinciales. Los marcadores siempre quedan por encima gracias a panes Leaflet con z-index diferenciado.

**Filtros:**
- Búsqueda por texto (nombre de producto o granja)
- Filtro por categoría (Verduras, Frutas, Carnes, Lácteos, Miel, Bebidas, Otros)
- Radio de distancia con geolocalización HTML5 y círculo dinámico (`L.circle`)
- Filtro de precio máximo (slider ajustado al precio más alto del catálogo)

### 3.3 Otras funcionalidades del cliente
- **Carrito persistente:** `localStorage` con cantidades por producto, control de stock y validación contra la API en el momento de tramitar.
- **Reserva con QR:** Al completar un pedido, el servidor genera un código QR único (`qr_payload`) que se renderiza en el navegador con la librería `qrcodejs`.
- **Favoritos:** Los clientes pueden guardar productos favoritos. Los iconos del corazón reflejan el estado en tiempo real (relleno/hueco).
- **Reseñas:** Los clientes pueden valorar con estrellas y comentar productores después de una compra.
- **Sesión:** Al cerrar sesión se limpia tanto `km0_user` como `km0_cart` de `localStorage`.

---

## 4. Estructura del proyecto

```
kilometro0/
├── server/
│   ├── server.js              # Entrada Express, app.locals globales
│   ├── config/
│   │   ├── db.js              # Pool PostgreSQL
│   │   ├── email.js           # Nodemailer (test/producción)
│   │   ├── parcels.js         # Orquestación catastro → shapefile → GeoServer
│   │   └── catastro.js        # Cliente WFS Catastro
│   ├── middleware/
│   │   └── auth.js            # JWT: getSessionUser, requireAuth
│   └── routes/
│       ├── auth.js            # /api/login, /api/logout, /api/register
│       ├── producers.js       # /api/parcels, /api/provincias, /api/favorites, ...
│       ├── orders.js          # /api/orders, /api/reviews
│       ├── admin.js           # /api/admin/...
│       └── pages.js           # Rutas de renderizado EJS
├── views/
│   ├── index.ejs              # Tienda + mapa
│   ├── about.ejs              # Página informativa
│   ├── producer-profile.ejs   # Perfil público de productor
│   ├── producer-app.ejs       # Dashboard productor
│   ├── client-app.ejs         # Dashboard cliente
│   ├── admin-app.ejs          # Panel de administración
│   └── partials/
│       ├── head.ejs
│       └── footer.ejs
├── public/
│   ├── css/
│   └── img/
├── pygeoapi/                  # Configuración y procesos pygeoapi
├── docker-compose.yml         # PostGIS, GeoServer, pygeoapi
└── .env                       # Variables de entorno (no en git)
```

---

## 5. Credenciales por defecto (desarrollo)

| Servicio | Usuario | Contraseña |
|---|---|---|
| App (admin) | `admin@admin` | `admin` |
| PostgreSQL | `km0_user` | `km0_password` |
| GeoServer | `admin` | `geoserver` |
