const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { getCadastralCoords } = require('../config/catastro');

// POST /api/admin/block — Bloquea o desbloquea una cuenta (productor o cliente).
// Una cuenta bloqueada no puede iniciar sesión ni, en el caso de productores,
// aparecer en el catálogo público.
router.post('/api/admin/block', requireAuth('admin'), async (req, res) => {
    const { type, id, block } = req.body;
    const role = type === 'producer' ? 'PRODUCER' : 'CLIENT';

    try {
        const result = await pool.query(
            'UPDATE users SET is_blocked = $1 WHERE id = $2 AND role = $3 RETURNING id',
            [block, parseInt(id), role]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true });
    } catch (err) {
        console.error('Error admin/block:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/admin/remove-photo — Elimina la foto de perfil de un productor,
// como medida de moderación ante contenido inapropiado.
router.post('/api/admin/remove-photo', requireAuth('admin'), async (req, res) => {
    const { id } = req.body;
    try {
        const result = await pool.query(
            "UPDATE users SET profile_image = '' WHERE id = $1 AND role = 'PRODUCER' RETURNING id",
            [parseInt(id)]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false });
        res.json({ success: true });
    } catch (err) {
        console.error('Error admin/remove-photo:', err.message);
        res.status(500).json({ success: false });
    }
});

// POST /api/admin/cancel-order — Cancela cualquier pedido por decisión
// administrativa y reintegra su stock. La operación es idempotente: solo actúa
// si el pedido no estaba ya cancelado.
router.post('/api/admin/cancel-order', requireAuth('admin'), async (req, res) => {
    const orderId = parseInt(req.body.order_id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Solo cancela (y devuelve stock) si no estaba ya cancelado — idempotente
        const result = await client.query(
            "UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND status != 'CANCELLED' RETURNING id",
            [orderId]
        );
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false });
        }
        await client.query(
            `UPDATE products p
             SET stock = stock + oi.quantity
             FROM order_items oi
             WHERE oi.order_id = $1 AND oi.product_id = p.id AND p.stock IS NOT NULL`,
            [orderId]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error admin/cancel-order:', err.message);
        res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// GET /api/admin/catastro-coords/:rc — Resuelve las coordenadas de una
// referencia catastral para que el administrador pueda situar al productor en
// el mapa durante el proceso de verificación.
router.get('/api/admin/catastro-coords/:rc', requireAuth('admin'), async (req, res) => {
    try {
        const coords = await getCadastralCoords(req.params.rc);
        res.json(coords);
    } catch (err) {
        console.error('Error admin/catastro-coords:', err.message);
        res.status(500).json({ success: false, error: 'Error interno del servidor.' });
    }
});

// GET /api/admin/kpis — Calcula los indicadores del panel de administración
// (número de productores, productores pendientes de verificar, clientes,
// pedidos del día e ingresos acumulados). Las consultas se lanzan en paralelo
// con Promise.all para minimizar la latencia total.
router.get('/api/admin/kpis', requireAuth('admin'), async (req, res) => {
    try {
        const [totalProducers, pendingProducers, totalClients, ordersToday, totalRevenue] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM users WHERE role = 'PRODUCER'"),
            pool.query("SELECT COUNT(*) FROM users WHERE role = 'PRODUCER' AND status = 'UNVERIFIED' AND is_blocked = FALSE"),
            pool.query("SELECT COUNT(*) FROM users WHERE role = 'CLIENT'"),
            pool.query("SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE AND status != 'CANCELLED'"),
            pool.query("SELECT COALESCE(SUM(total_price), 0) AS total FROM orders WHERE status = 'COMPLETED'")
        ]);
        res.json({
            success: true,
            totalProducers: parseInt(totalProducers.rows[0].count),
            pendingProducers: parseInt(pendingProducers.rows[0].count),
            totalClients: parseInt(totalClients.rows[0].count),
            ordersToday: parseInt(ordersToday.rows[0].count),
            totalRevenue: parseFloat(totalRevenue.rows[0].total)
        });
    } catch (err) {
        console.error('Error admin/kpis:', err.message);
        res.status(500).json({ success: false });
    }
});

// GET /api/admin/client/:id — Devuelve la ficha detallada de un cliente: sus
// datos de perfil y el historial de pedidos con sus líneas agregadas mediante
// json_agg.
router.get('/api/admin/client/:id', requireAuth('admin'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false });
    try {
        const [clientResult, ordersResult] = await Promise.all([
            pool.query(
                `SELECT id, name, last_name AS "lastName", email, profile_image AS "profileImage",
                        is_blocked AS "isBlocked", created_at
                 FROM users WHERE id = $1 AND role = 'CLIENT'`,
                [id]
            ),
            pool.query(
                `SELECT o.id AS order_id, o.qr_code, o.status, o.total_price, o.created_at, o.rejection_reason,
                        json_agg(json_build_object('name', oi.product_name, 'price', oi.unit_price, 'qty', oi.quantity)) AS items
                 FROM orders o
                 LEFT JOIN order_items oi ON oi.order_id = o.id
                 WHERE o.client_id = $1
                 GROUP BY o.id ORDER BY o.created_at DESC`,
                [id]
            )
        ]);
        if (!clientResult.rows[0]) return res.status(404).json({ success: false });
        const client = clientResult.rows[0];
        const orders = ordersResult.rows.map(o => ({ ...o, total_price: parseFloat(o.total_price) }));
        res.json({ success: true, client, orders });
    } catch (err) {
        console.error('Error admin/client:', err.message);
        res.status(500).json({ success: false });
    }
});

module.exports = router;
