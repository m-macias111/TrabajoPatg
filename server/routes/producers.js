const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { getSessionUser, requireAuth } = require('../middleware/auth');
const { provisionParcel, GEOSERVER_URL, GEOSERVER_WORKSPACE, GS_AUTH } = require('../config/parcels');

// GET /api/parcels — Devuelve las huellas (polígonos) de las parcelas de los
// productores verificados como una única FeatureCollection GeoJSON. Actúa como
// proxy de mismo origen sobre GeoServer (WFS) para evitar problemas de CORS
// desde el navegador; consulta capa por capa y fusiona los resultados,
// anexando a cada feature el id y nombre del productor para enlazar el mapa.
router.get('/api/parcels', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, parcel_layer
             FROM users
             WHERE role = 'PRODUCER' AND status = 'VERIFIED' AND is_blocked = FALSE
               AND parcel_layer IS NOT NULL`
        );

        const features = [];
        await Promise.all(result.rows.map(async (p) => {
            const wfsUrl = `${GEOSERVER_URL}/${GEOSERVER_WORKSPACE}/wfs` +
                `?service=WFS&version=2.0.0&request=GetFeature` +
                `&typeNames=${encodeURIComponent(p.parcel_layer)}` +
                `&outputFormat=application/json&srsName=EPSG:4326`;
            try {
                const r = await fetch(wfsUrl, { headers: { Authorization: GS_AUTH } });
                if (!r.ok) return;
                const fc = await r.json();
                (fc.features || []).forEach(f => {
                    f.properties = { ...(f.properties || {}), producerId: p.id, producerName: p.name };
                    features.push(f);
                });
            } catch (e) {
                console.error(`[parcels] WFS de ${p.parcel_layer} falló:`, e.message);
            }
        }));

        res.json({ type: 'FeatureCollection', features });
    } catch (err) {
        console.error('Error /api/parcels:', err.message);
        res.json({ type: 'FeatureCollection', features: [] });
    }
});

// Caché en memoria de los límites provinciales (17 MB de GeoJSON que no cambian).
// Se rellena en la primera petición y se reutiliza en las siguientes.
let provincesCache = null;

// GET /api/provincias — Proxy WFS de mismo origen para la capa de límites
// provinciales almacenada en GeoServer. Devuelve el texto JSON directamente
// sin parsearlo/re-serializarlo para evitar el pico de memoria (~100 MB).
router.get('/api/provincias', async (req, res) => {
    try {
        if (!provincesCache) {
            const workspace = process.env.GEOSERVER_PROVINCES_WORKSPACE || 'gggggggggg';
            const wfsUrl = `${GEOSERVER_URL}/wfs?service=WFS&version=2.0.0&request=GetFeature` +
                `&typeNames=${workspace}:provincias&outputFormat=application/json&srsName=EPSG:4326`;
            const r = await fetch(wfsUrl, { headers: { Authorization: GS_AUTH } });
            if (!r.ok) throw new Error(`GeoServer respondió ${r.status}`);
            provincesCache = await r.text();
            console.log(`[provincias] cacheado: ${(provincesCache.length / 1e6).toFixed(1)} MB`);
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(provincesCache);
    } catch (err) {
        console.error('Error /api/provincias:', err.message);
        if (!res.headersSent) res.status(500).json({ type: 'FeatureCollection', features: [] });
    }
});

// GET /api/producers/by-email — Recupera el perfil de un productor a partir de
// su correo, incluyendo las coordenadas extraídas de la columna geográfica.
router.get('/api/producers/by-email', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, last_name, email, phone, locality, status, is_blocked,
                    dni, cadastral_ref, history, profile_image,
                    ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
             FROM users WHERE email = $1 AND role = 'PRODUCER'`,
            [req.query.email]
        );
        if (result.rows.length === 0) return res.json({ success: false });

        const p = result.rows[0];
        res.json({
            success: true,
            producer: {
                id: p.id, name: p.name, lastName: p.last_name, email: p.email,
                phone: p.phone, locality: p.locality,
                verified: p.status === 'VERIFIED',
                isBlocked: p.is_blocked,
                history: p.history, profileImage: p.profile_image,
                lat: parseFloat(p.lat), lng: parseFloat(p.lng)
            }
        });
    } catch (err) {
        console.error('Error producers/by-email:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/producers/:id/verify — Acción reservada al administrador que marca a
// un productor como verificado, habilitándolo para vender. Si se aportan
// coordenadas, actualiza también su ubicación en el mapa.
router.post('/api/producers/:id/verify', requireAuth('admin'), async (req, res) => {
    const { lat, lng } = req.body;
    try {
        let result;
        if (lat !== undefined && lng !== undefined) {
            result = await pool.query(
                `UPDATE users
                 SET status = 'VERIFIED',
                     location = ST_SetSRID(ST_MakePoint($1, $2), 4326)
                 WHERE id = $3 AND role = 'PRODUCER'
                 RETURNING id, cadastral_ref, parcel_layer`,
                [parseFloat(lng), parseFloat(lat), req.params.id]
            );
        } else {
            result = await pool.query(
                "UPDATE users SET status = 'VERIFIED' WHERE id = $1 AND role = 'PRODUCER' RETURNING id, cadastral_ref, parcel_layer",
                [req.params.id]
            );
        }
        if (result.rowCount === 0) return res.status(404).json({ success: false });

        // Si el productor aún no tiene parcela publicada (p. ej. se registró
        // antes de existir este flujo, o el aprovisionamiento falló), se
        // reintenta ahora: la verificación es justo cuando el polígono empieza
        // a mostrarse en el mapa. En segundo plano, sin bloquear la respuesta.
        const row = result.rows[0];
        if (!row.parcel_layer && row.cadastral_ref) {
            provisionParcel(row.id, row.cadastral_ref).catch(err =>
                console.error('[verify] provisionParcel falló:', err.message));
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error verify producer:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/producers/update-profile — Permite al productor actualizar los
// datos editables de su perfil (imagen, historia, localidad y nombre de la
// granja). El uso de COALESCE preserva los valores existentes en los campos no
// enviados, de modo que se admiten actualizaciones parciales.
router.post('/api/producers/update-profile', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.status(403).json({ success: false });

    const { profileImage, history, locality, name } = req.body;
    // El nombre de la granja no puede quedar vacío
    const cleanName = (typeof name === 'string' && name.trim()) ? name.trim() : null;
    try {
        await pool.query(
            `UPDATE users
             SET profile_image = COALESCE($1, profile_image),
                 history = COALESCE($2, history),
                 locality = COALESCE($3, locality),
                 name = COALESCE($4, name)
             WHERE email = $5 AND role = 'PRODUCER'`,
            [profileImage !== undefined ? profileImage : null,
             history !== undefined ? history : null,
             locality !== undefined ? locality : null,
             cleanName,
             user.email]
        );
        res.json({ success: true, name: cleanName });
    } catch (err) {
        console.error('Error update-profile:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/products/add — Añade un producto al catálogo del productor
// autenticado. El INSERT ... SELECT vincula el producto al id del usuario
// derivado de su correo, garantizando que solo pueda crearlo bajo su propia
// cuenta. Un stock nulo representa disponibilidad ilimitada.
router.post('/api/products/add', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.status(403).json({ success: false });

    const { name, category, price, kg, pickup_day, image_url, stock } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'Nombre y precio obligatorios' });

    try {
        const result = await pool.query(
            `INSERT INTO products (producer_id, name, category, price, kg, pickup_day, image_url, stock)
             SELECT id, $1, $2, $3, $4, $5, $6, $7 FROM users WHERE email = $8 AND role = 'PRODUCER'
             RETURNING *`,
            [name, category || 'Otros', parseFloat(price),
             parseFloat(kg) || 1.0, pickup_day || 'Consultar',
             image_url || 'https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=800',
             stock != null && stock !== '' ? parseInt(stock) : null,
             user.email]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true, product: result.rows[0] });
    } catch (err) {
        console.error('Error products/add:', err.message);
        res.status(500).json({ success: false });
    }
});

// PATCH /api/products/:id/image — Actualiza la imagen de un producto. La
// subconsulta sobre producer_id restringe la operación a productos propiedad
// del productor autenticado.
router.patch('/api/products/:id/image', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.status(403).json({ success: false });

    const { image } = req.body;
    if (!image || typeof image !== 'string') {
        return res.status(400).json({ success: false, message: 'No se envió ninguna imagen.' });
    }

    try {
        const result = await pool.query(
            `UPDATE products SET image_url = $1
             WHERE id = $2 AND producer_id = (SELECT id FROM users WHERE email = $3 AND role = 'PRODUCER')
             RETURNING id`,
            [image, parseInt(req.params.id), user.email]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true });
    } catch (err) {
        console.error('Error update product image:', err.message);
        res.status(500).json({ success: false });
    }
});

// DELETE /api/products/:id — Elimina un producto del catálogo, restringido a
// los productos pertenecientes al productor autenticado.
router.delete('/api/products/:id', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.status(403).json({ success: false });

    try {
        const result = await pool.query(
            `DELETE FROM products WHERE id = $1
             AND producer_id = (SELECT id FROM users WHERE email = $2 AND role = 'PRODUCER')`,
            [parseInt(req.params.id), user.email]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true });
    } catch (err) {
        console.error('Error delete product:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/client/update-profile — Actualiza la foto de perfil del cliente
// autenticado.
router.post('/api/client/update-profile', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'client') return res.status(403).json({ success: false });

    const { profileImage } = req.body;
    try {
        await pool.query(
            'UPDATE users SET profile_image = $1 WHERE id = $2 AND role = \'CLIENT\'',
            [profileImage || null, user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error client update-profile:', err.message);
        res.status(500).json({ success: false });
    }
});

// GET /api/favorites — Devuelve la lista de productos marcados como favoritos
// por el cliente, junto con el nombre del productor de cada uno.
router.get('/api/favorites', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'client') return res.status(403).json({ success: false, favorites: [] });

    try {
        const result = await pool.query(
            `SELECT p.id, p.name, p.category, p.price, p.kg, p.pickup_day, p.image_url,
                    u.name AS producer_name, u.id AS producer_id
             FROM favorites f
             JOIN products p ON f.product_id = p.id
             JOIN users u ON p.producer_id = u.id
             WHERE f.client_id = $1`,
            [user.id]
        );
        res.json({ success: true, favorites: result.rows });
    } catch (err) {
        console.error('Error get favorites:', err.message);
        res.status(500).json({ success: false, favorites: [] });
    }
});

// POST /api/favorites/toggle — Alterna el estado de favorito de un producto: lo
// elimina si ya estaba marcado o lo inserta en caso contrario. Devuelve la
// acción aplicada para que el cliente actualice la interfaz.
router.post('/api/favorites/toggle', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'client') return res.status(403).json({ success: false });

    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ success: false });

    try {
        // Verificar si ya existe el favorito
        const existing = await pool.query(
            'SELECT 1 FROM favorites WHERE client_id = $1 AND product_id = $2',
            [user.id, product_id]
        );

        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM favorites WHERE client_id = $1 AND product_id = $2', [user.id, product_id]);
            return res.json({ success: true, action: 'removed' });
        } else {
            await pool.query('INSERT INTO favorites (client_id, product_id) VALUES ($1, $2)', [user.id, product_id]);
            return res.json({ success: true, action: 'added' });
        }
    } catch (err) {
        console.error('Error favorites/toggle:', err.message);
        res.status(500).json({ success: false });
    }
});

// PATCH /api/products/:id/stock — Fija el stock de un producto a un valor
// absoluto. Un valor nulo indica disponibilidad ilimitada; cualquier otro debe
// ser un entero no negativo.
router.patch('/api/products/:id/stock', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.status(403).json({ success: false });

    const { stock } = req.body;
    const stockVal = (stock != null && stock !== '') ? parseInt(stock) : null;
    if (stockVal !== null && (!Number.isInteger(stockVal) || stockVal < 0)) {
        return res.status(400).json({ success: false, message: 'El stock debe ser 0 o mayor.' });
    }

    try {
        const result = await pool.query(
            `UPDATE products SET stock = $1
             WHERE id = $2 AND producer_id = (SELECT id FROM users WHERE email = $3 AND role = 'PRODUCER')
             RETURNING stock`,
            [stockVal, parseInt(req.params.id), user.email]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true, stock: result.rows[0].stock });
    } catch (err) {
        console.error('Error update stock:', err.message);
        res.status(500).json({ success: false });
    }
});

// PATCH /api/products/:id/stock/add — Incrementa el stock existente en la
// cantidad indicada mediante una operación de suma atómica en la propia
// sentencia UPDATE, evitando condiciones de carrera entre lecturas y escrituras.
router.patch('/api/products/:id/stock/add', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'producer') return res.status(403).json({ success: false });

    const add = parseInt(req.body.add);
    if (!Number.isInteger(add) || add <= 0) {
        return res.status(400).json({ success: false, message: 'Introduce cuántos packs quieres añadir.' });
    }

    try {
        // Suma atómica: COALESCE convierte un producto "sin límite" (null) en 0 + add
        const result = await pool.query(
            `UPDATE products SET stock = COALESCE(stock, 0) + $1
             WHERE id = $2 AND producer_id = (SELECT id FROM users WHERE email = $3 AND role = 'PRODUCER')
             RETURNING stock`,
            [add, parseInt(req.params.id), user.email]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true, stock: result.rows[0].stock });
    } catch (err) {
        console.error('Error add stock:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/reviews — Registra o actualiza la valoración de un cliente sobre un
// productor. Como requisito de autenticidad, solo se admite si el cliente tiene
// al menos un pedido completado con dicho productor. La cláusula ON CONFLICT
// garantiza una única reseña por par cliente-productor, sobrescribiendo la
// previa si existe.
router.post('/api/reviews', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.role !== 'client') return res.status(403).json({ success: false, message: 'Solo clientes pueden dejar reseñas.' });

    const { producer_id, rating, comment } = req.body;
    if (!producer_id || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'Datos inválidos.' });
    }

    try {
        // Verificar que el cliente tiene al menos un pedido completado con este productor
        const check = await pool.query(
            `SELECT 1 FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             JOIN products p ON p.id = oi.product_id
             WHERE o.client_id = $1 AND p.producer_id = $2 AND o.status = 'COMPLETED'
             LIMIT 1`,
            [user.id, parseInt(producer_id)]
        );
        if (check.rows.length === 0) {
            return res.json({ success: false, message: 'Solo puedes valorar productores de los que hayas recogido un pedido.' });
        }

        await pool.query(
            `INSERT INTO reviews (producer_id, client_id, client_name, rating, comment)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (producer_id, client_id)
             DO UPDATE SET rating = $4, comment = $5, created_at = CURRENT_TIMESTAMP`,
            [parseInt(producer_id), user.id, user.name, parseInt(rating), comment || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error post review:', err.message);
        res.status(500).json({ success: false });
    }
});

// GET /api/reviews/:producer_id — Devuelve todas las reseñas de un productor
// ordenadas de más reciente a más antigua, junto con la valoración media.
router.get('/api/reviews/:producer_id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT rating, comment, client_name, created_at
             FROM reviews WHERE producer_id = $1
             ORDER BY created_at DESC`,
            [parseInt(req.params.producer_id)]
        );
        const rows = result.rows;
        const avg = rows.length ? (rows.reduce((s, r) => s + r.rating, 0) / rows.length) : null;
        res.json({ success: true, reviews: rows, avgRating: avg ? avg.toFixed(1) : null, count: rows.length });
    } catch (err) {
        console.error('Error get reviews:', err.message);
        res.status(500).json({ success: false, reviews: [], avgRating: null, count: 0 });
    }
});

module.exports = router;
