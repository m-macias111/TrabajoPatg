const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { getSessionUser } = require('../middleware/auth');


// Recupera el catálogo completo de productos junto con los datos del productor
// y sus coordenadas. Solo incluye productos de productores verificados y no
// bloqueados, que son los visibles públicamente. Convierte a número los campos
// devueltos como texto por el driver (precios, peso y coordenadas).
async function getProductsWithProducers() {
    const result = await pool.query(
        `SELECT p.id, p.producer_id, p.name, p.category, p.price, p.kg, p.pickup_day, p.image_url, p.stock,
                u.id AS producer_db_id, u.name AS producer_name,
                ST_Y(u.location::geometry) AS lat,
                ST_X(u.location::geometry) AS lng
         FROM products p
         JOIN users u ON p.producer_id = u.id
         WHERE u.status = 'VERIFIED' AND u.is_blocked = FALSE
         ORDER BY p.id`
    );
    return result.rows.map(r => ({
        ...r,
        price: parseFloat(r.price),
        kg: parseFloat(r.kg),
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lng),
    }));
}

// Recupera los productores verificados y no bloqueados para representarlos en
// el mapa de la página principal.
async function getPublicProducers() {
    const result = await pool.query(
        `SELECT id, name, last_name AS "lastName", locality, phone, history, profile_image AS "profileImage",
                status, is_blocked AS "isBlocked", parcel_layer AS "parcelLayer",
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lng
         FROM users
         WHERE role = 'PRODUCER' AND status = 'VERIFIED' AND is_blocked = FALSE
         ORDER BY id`
    );
    return result.rows.map(r => ({
        ...r,
        verified: true,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lng),
    }));
}

// GET / — Página principal: renderiza la tienda con el catálogo de productos y
// el mapa de productores. Ante un error de consulta degrada con elegancia,
// mostrando la página con listas vacías en lugar de fallar.
router.get('/', async (req, res) => {
    try {
        const [products, producers] = await Promise.all([
            getProductsWithProducers(),
            getPublicProducers()
        ]);
        res.render('index', { products, producers, page: 'home' });
    } catch (err) {
        console.error('Error cargando home:', err.message);
        res.render('index', { products: [], producers: [], page: 'home' });
    }
});

// GET /about — Página informativa «Quiénes somos».
router.get('/about', (req, res) => {
    res.render('about', { page: 'about' });
});

// GET /login — Formulario de inicio de sesión.
router.get('/login', (req, res) => {
    res.render('login', { page: 'login' });
});

// GET /register — Formulario de registro. El parámetro de consulta `role`
// preselecciona el tipo de cuenta (cliente por defecto).
router.get('/register', (req, res) => {
    const role = req.query.role || 'client';
    res.render('register', { page: 'register', role });
});

// GET /forgot-password — Formulario para solicitar el restablecimiento de
// contraseña.
router.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { page: 'forgot-password' });
});

// GET /reset-password — Formulario para definir la nueva contraseña a partir
// del token recibido por correo.
router.get('/reset-password', (req, res) => {
    const token = req.query.token || '';
    res.render('reset-password', { page: 'reset-password', token });
});

// GET /producer-profile — Perfil público de un productor con sus productos y
// sus reseñas (incluida la valoración media). El parámetro `from` registra la
// procedencia de la navegación para ofrecer un retorno coherente en la interfaz.
router.get('/producer-profile', async (req, res) => {
    const id = parseInt(req.query.id) || 0;
    const from = req.query.from || 'store';
    try {
        const producerResult = await pool.query(
            `SELECT id, name, last_name AS "lastName", locality, phone, history,
                    profile_image AS "profileImage", status
             FROM users WHERE id = $1 AND role = 'PRODUCER'`,
            [id]
        );
        const producer = producerResult.rows[0] || null;

        const productsResult = await pool.query(
            `SELECT p.id, p.producer_id, p.name, p.category, p.price, p.kg, p.pickup_day, p.image_url, p.stock,
                    u.name AS producer_name,
                    ST_Y(u.location::geometry) AS lat,
                    ST_X(u.location::geometry) AS lng
             FROM products p
             JOIN users u ON p.producer_id = u.id
             WHERE p.producer_id = $1`,
            [id]
        );
        const products = productsResult.rows.map(r => ({
            ...r,
            price: parseFloat(r.price),
            kg: parseFloat(r.kg),
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lng),
        }));

        // Reseñas del productor
        const reviewsResult = await pool.query(
            `SELECT rating, comment, client_name, created_at FROM reviews WHERE producer_id = $1 ORDER BY created_at DESC`,
            [id]
        );
        const reviews = reviewsResult.rows;
        const avgRating = reviews.length
            ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
            : null;

        res.render('producer-profile', { page: 'producer-profile', producer, products, from, reviews, avgRating });
    } catch (err) {
        console.error('Error producer-profile:', err.message);
        res.render('producer-profile', { page: 'producer-profile', producer: null, products: [], from: 'store', reviews: [], avgRating: null });
    }
});

// GET /producer-app — Panel privado del productor. Requiere sesión con rol
// productor y reúne sus datos, su catálogo, los pedidos que le afectan y un
// resumen estadístico (ventas, ingresos y pedidos pendientes).
router.get('/producer-app', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.redirect('/login');

    try {
        const producerResult = await pool.query(
            `SELECT id, name, last_name AS "lastName", email, phone, locality, history,
                    profile_image AS "profileImage", status, dni, cadastral_ref AS "catastral",
                    ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
             FROM users WHERE email = $1 AND role = 'PRODUCER'`,
            [user.email]
        );
        if (producerResult.rows.length === 0) return res.redirect('/login');
        const producer = producerResult.rows[0];
        producer.verified = producer.status === 'VERIFIED';

        const productsResult = await pool.query(
            'SELECT * FROM products WHERE producer_id = $1 ORDER BY id',
            [producer.id]
        );
        const products = productsResult.rows.map(r => ({ ...r, price: parseFloat(r.price), kg: parseFloat(r.kg) }));

        // Pedidos que incluyen productos de este productor
        const ordersResult = await pool.query(
            `SELECT o.id AS order_id, o.client_email, o.qr_code, o.status, o.total_price, o.created_at,
                    json_agg(json_build_object('id', oi.product_id, 'name', oi.product_name, 'price', oi.unit_price)) AS items
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             JOIN products p ON p.id = oi.product_id
             WHERE p.producer_id = $1
             GROUP BY o.id
             ORDER BY o.created_at DESC`,
            [producer.id]
        );
        const orders = ordersResult.rows.map(o => ({
            ...o,
            total_price: parseFloat(o.total_price),
            items: o.items || []
        }));

        // Estadísticas
        const notCancelled = orders.filter(o => o.status !== 'CANCELLED');
        const totalSales = notCancelled.length;
        const totalRevenue = notCancelled.reduce((sum, o) => sum + parseFloat(o.total_price), 0);
        const pendingOrders = orders.filter(o => o.status === 'PENDING').length;

        res.render('producer-app', {
            page: 'producer-app',
            producer,
            products,
            orders,
            stats: { totalSales, totalRevenue, pendingOrders },
            adminEmail: process.env.ADMIN_CONTACT_EMAIL || process.env.ADMIN_EMAIL || 'admin@km0local.es'
        });
    } catch (err) {
        console.error('Error producer-app:', err.message);
        res.redirect('/login');
    }
});

// GET /client-app — Panel privado del cliente. Requiere sesión con rol cliente
// y muestra su historial de pedidos (con el payload del QR para regenerarlo en
// el navegador) y sus productos favoritos.
router.get('/client-app', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'client') return res.redirect('/login');

    try {
        const clientResult = await pool.query(
            'SELECT id, name, last_name AS "lastName", email, profile_image AS "profileImage" FROM users WHERE id = $1',
            [user.id]
        );
        if (clientResult.rows.length === 0) return res.redirect('/login');
        const client = clientResult.rows[0];

        // Pedidos del cliente (incluye qr_payload para generar QR en cliente)
        const ordersResult = await pool.query(
            `SELECT o.id AS order_id, o.qr_code, o.qr_payload, o.status, o.total_price, o.created_at, o.rejection_reason,
                    json_agg(json_build_object('name', oi.product_name, 'price', oi.unit_price, 'qty', oi.quantity)) AS items
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.client_id = $1
             GROUP BY o.id
             ORDER BY o.created_at DESC`,
            [user.id]
        );
        const orders = ordersResult.rows.map(o => ({
            ...o,
            total_price: parseFloat(o.total_price),
            items: o.items || []
        }));

        // Favoritos del cliente
        const favResult = await pool.query(
            `SELECT p.id, p.name, p.category, p.price, p.kg, p.pickup_day, p.image_url,
                    u.name AS producer_name, u.id AS producer_id
             FROM favorites f
             JOIN products p ON f.product_id = p.id
             JOIN users u ON p.producer_id = u.id
             WHERE f.client_id = $1`,
            [user.id]
        );
        const favorites = favResult.rows.map(r => ({ ...r, price: parseFloat(r.price), kg: parseFloat(r.kg) }));

        res.render('client-app', { page: 'client-app', client, orders, favorites });
    } catch (err) {
        console.error('Error client-app:', err.message);
        res.redirect('/login');
    }
});

// GET /admin-app — Panel de administración. Requiere sesión con rol
// administrador y carga la relación completa de productores, clientes y pedidos
// para su gestión y moderación.
router.get('/admin-app', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'admin') return res.redirect('/login');

    try {
        const producersResult = await pool.query(
            `SELECT id, name, last_name AS "lastName", email, phone, locality,
                    profile_image AS "profileImage", history, status, is_blocked AS "isBlocked",
                    dni, cadastral_ref AS "catastral",
                    ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
             FROM users WHERE role = 'PRODUCER' ORDER BY id`
        );
        const producers = producersResult.rows.map(p => ({
            ...p,
            verified: p.status === 'VERIFIED',
            lat: p.lat ? parseFloat(p.lat) : null,
            lng: p.lng ? parseFloat(p.lng) : null
        }));

        const clientsResult = await pool.query(
            `SELECT id, name, last_name AS "lastName", email, is_blocked AS "isBlocked", created_at
             FROM users WHERE role = 'CLIENT' ORDER BY id`
        );
        const clients = clientsResult.rows;

        const ordersResult = await pool.query(
            `SELECT o.id AS order_id, o.qr_code, o.status, o.total_price, o.client_email, o.client_id, o.created_at, o.rejection_reason,
                    json_agg(json_build_object('name', oi.product_name, 'price', oi.unit_price, 'qty', oi.quantity)) AS items
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             GROUP BY o.id
             ORDER BY o.created_at DESC`
        );
        const orders = ordersResult.rows.map(o => ({
            ...o,
            total_price: parseFloat(o.total_price),
            items: o.items || []
        }));

        res.render('admin-app', { page: 'admin-app', producers, clients, orders });
    } catch (err) {
        console.error('Error admin-app:', err.message);
        res.redirect('/login');
    }
});

module.exports = router;
