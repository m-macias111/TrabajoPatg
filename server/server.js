const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Variables disponibles en todas las plantillas EJS sin necesidad de pasarlas
// explícitamente en cada res.render().
app.locals.geoserverUrl = process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver';
app.locals.geoserverWorkspace = process.env.GEOSERVER_WORKSPACE || 'km0';
// URL pública de GeoServer para peticiones WMS desde el navegador (distinta a la URL interna)
app.locals.geoserverPublicUrl = process.env.GEOSERVER_PUBLIC_URL || process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver';
app.locals.geoserverProvincesWorkspace = process.env.GEOSERVER_PROVINCES_WORKSPACE || 'gggggggggg';

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// Middleware que expone en cada petición un acceso perezoso al usuario de la
// sesión, evitando repetir la lectura y verificación del token en cada ruta.
const { getSessionUser } = require('./middleware/auth');
app.use((req, res, next) => {
    req.getSessionUser = () => getSessionUser(req);
    next();
});

// Routers de la API REST. El router de páginas (renderizado de vistas EJS) se
// monta en último lugar para que las rutas de la API tengan prioridad sobre las
// rutas de navegación.
app.use(require('./routes/auth'));
app.use(require('./routes/producers'));
app.use(require('./routes/orders'));
app.use(require('./routes/admin'));

app.use(require('./routes/pages'));

const PORT = process.env.PORT || 3000;

// Se inicializa el servicio de correo antes de aceptar peticiones, de modo que
// el transporte SMTP esté disponible cuando se procese el primer pedido.
require('./config/email').init().then(() => {
    app.listen(PORT, () => {
        console.log(`Kilometro 0 corriendo en http://localhost:${PORT}`);
    });
});
