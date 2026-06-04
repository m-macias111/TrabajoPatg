const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const emailService = require('../config/email');
const { JWT_SECRET } = require('../middleware/auth');
const { validateCadastralRef } = require('../config/catastro');
const { provisionParcel } = require('../config/parcels');

const SALT_ROUNDS = 10;

// POST /api/login — Autentica al usuario. Las credenciales del administrador se
// validan contra las variables de entorno; el resto, contra el hash bcrypt
// almacenado. Si la verificación es correcta se emite un JWT que se entrega en
// una cookie httpOnly con 24 horas de vigencia.
router.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    // Credenciales del administrador, definidas por configuración (no en la BD).
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASS) {
        const user = { email, name: 'Administrador', role: 'admin' };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
        res.cookie('km0_jwt', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user });
    }

    try {
        const result = await pool.query(
            'SELECT id, name, last_name, email, password_hash, role, status, is_blocked FROM users WHERE email = $1',
            [email]
        );
        const dbUser = result.rows[0];
        if (!dbUser) return res.json({ success: false, message: 'Email o contraseña incorrectos.' });

        const match = await bcrypt.compare(password, dbUser.password_hash);
        if (!match) return res.json({ success: false, message: 'Email o contraseña incorrectos.' });

        if (dbUser.is_blocked) return res.json({ success: false, message: 'Tu cuenta ha sido bloqueada por un administrador.' });

        const role = dbUser.role === 'PRODUCER' ? 'producer' : 'client';
        const user = { email: dbUser.email, name: dbUser.name, role, id: dbUser.id };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
        res.cookie('km0_jwt', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user });
    } catch (err) {
        console.error('Error en login:', err.message);
        res.status(500).json({ success: false, message: 'Error del servidor.' });
    }
});

// POST /api/logout — Cierra la sesión eliminando la cookie que contiene el JWT.
router.post('/api/logout', (req, res) => {
    res.clearCookie('km0_jwt');
    res.json({ success: true });
});

// POST /api/register — Da de alta un usuario. Comprueba que el correo no esté
// ya registrado y cifra la contraseña. Si el rol es productor, valida además la
// referencia catastral antes de crear la cuenta. Tras el alta inicia sesión
// automáticamente emitiendo el JWT correspondiente.
router.post('/api/register', async (req, res) => {
    const { name, lastName, ownerName, email, role, password, dni, catastral, address, phone } = req.body;

    try {
        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length > 0) {
            return res.json({ success: false, message: 'Este correo ya está registrado.' });
        }

        const hash = await bcrypt.hash(password, SALT_ROUNDS);

        if (role === 'producer') {
            const catValidation = await validateCadastralRef(catastral);
            if (!catValidation.valid) {
                return res.json({ success: false, message: catValidation.error });
            }

            const result = await pool.query(
                `INSERT INTO users (role, name, last_name, owner_name, email, password_hash, phone, locality, status, dni, cadastral_ref)
                 VALUES ('PRODUCER', $1, $2, $3, $4, $5, $6, $7, 'UNVERIFIED', $8, $9)
                 RETURNING id`,
                [name, lastName || null, ownerName || null, email, hash, phone || null, address || null, dni || null, catastral || null]
            );
            const id = result.rows[0].id;

            // Aprovisionamiento de la huella de la parcela en segundo plano:
            // obtiene la geometría (pygeoapi), genera el shapefile y publica la
            // capa en GeoServer. Se lanza sin await para no bloquear ni romper el
            // registro si el Catastro/GeoServer no responden; el polígono solo se
            // mostrará en el mapa tras la verificación del productor.
            provisionParcel(id, catastral).catch(err =>
                console.error('[register] provisionParcel falló:', err.message));

            const user = { email, name, role: 'producer', id };
            const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
            res.cookie('km0_jwt', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
            return res.json({ success: true, id });
        } else {
            const result = await pool.query(
                `INSERT INTO users (role, name, last_name, email, password_hash, status)
                 VALUES ('CLIENT', $1, $2, $3, $4, 'UNVERIFIED')
                 RETURNING id`,
                [name, lastName || null, email, hash]
            );
            const id = result.rows[0].id;
            const user = { email, name, role: 'client', id };
            const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
            res.cookie('km0_jwt', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
            return res.json({ success: true, id });
        }
    } catch (err) {
        console.error('Error en registro:', err.message);
        res.status(500).json({ success: false, message: 'Error del servidor.' });
    }
});

// POST /api/auth/forgot-password — Inicia la recuperación de contraseña. Genera
// un token aleatorio con caducidad de una hora, invalida los anteriores del
// mismo usuario y lo envía por correo. Por seguridad responde siempre con éxito,
// sin revelar si el correo está o no registrado.
router.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email requerido.' });

    try {
        const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
        // Siempre devolvemos éxito para no revelar si el email existe
        if (result.rows.length === 0) return res.json({ success: true });

        const user = result.rows[0];
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

        // Invalidar tokens anteriores del mismo usuario
        await pool.query('UPDATE reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE', [user.id]);
        await pool.query(
            'INSERT INTO reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
            [user.id, token, expiresAt]
        );

        const resetLink = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
        await emailService.sendPasswordReset({ to: email, name: user.name, resetLink });

        res.json({ success: true });
    } catch (err) {
        console.error('Error forgot-password:', err.message);
        res.status(500).json({ success: false, message: 'Error del servidor.' });
    }
});

// POST /api/auth/reset-password — Completa el restablecimiento. Verifica que el
// token exista, no se haya usado y no haya expirado; en tal caso actualiza el
// hash de la contraseña y marca el token como consumido para impedir su reúso.
router.post('/api/auth/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Datos inválidos.' });
    }

    try {
        const result = await pool.query(
            `SELECT rt.id, rt.user_id, rt.expires_at, rt.used
             FROM reset_tokens rt
             WHERE rt.token = $1`,
            [token]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Enlace inválido o expirado.' });
        }

        const resetToken = result.rows[0];
        if (resetToken.used) return res.json({ success: false, message: 'Este enlace ya ha sido utilizado.' });
        if (new Date() > new Date(resetToken.expires_at)) {
            return res.json({ success: false, message: 'El enlace ha expirado. Solicita uno nuevo.' });
        }

        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, resetToken.user_id]);
        await pool.query('UPDATE reset_tokens SET used = TRUE WHERE id = $1', [resetToken.id]);

        res.json({ success: true });
    } catch (err) {
        console.error('Error reset-password:', err.message);
        res.status(500).json({ success: false, message: 'Error del servidor.' });
    }
});

// GET /api/me — Devuelve los datos básicos de la sesión actual (nombre, rol y
// foto de perfil). Para el administrador, que no tiene registro en la BD, se
// responde directamente con los datos del token.
router.get('/api/me', async (req, res) => {
    const user = req.getSessionUser();
    if (!user) return res.json({ success: false });
    if (user.role === 'admin' || !user.id) {
        return res.json({ success: true, user: { name: user.name, role: user.role, profileImage: null } });
    }
    try {
        const result = await pool.query(
            'SELECT name, profile_image AS "profileImage" FROM users WHERE id = $1',
            [user.id]
        );
        const dbUser = result.rows[0];
        res.json({
            success: true,
            user: {
                name: dbUser ? dbUser.name : user.name,
                role: user.role,
                profileImage: dbUser ? dbUser.profileImage : null
            }
        });
    } catch (err) {
        console.error('Error /api/me:', err.message);
        res.json({ success: false });
    }
});

// POST /api/user/profile-image — Actualiza la foto de perfil del usuario
// autenticado, almacenada como cadena Base64 en la base de datos.
router.post('/api/user/profile-image', async (req, res) => {
    const user = req.getSessionUser();
    if (!user) return res.status(401).json({ success: false, message: 'No autenticado.' });

    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ success: false, message: 'No se envió imagen' });

    try {
        await pool.query('UPDATE users SET profile_image = $1 WHERE id = $2', [imageBase64, user.id]);
        res.json({ success: true, profileImage: imageBase64 });
    } catch (err) {
        console.error('Error guardando imagen en DB:', err.message);
        res.status(500).json({ success: false, message: 'Error interno guardando la foto.' });
    }
});

// GET /api/auth/validate-reset-token — Comprueba, antes de mostrar el
// formulario, si un token de restablecimiento sigue siendo válido (no usado y
// no expirado).
router.get('/api/auth/validate-reset-token', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.json({ valid: false });

    try {
        const result = await pool.query(
            'SELECT id, used, expires_at FROM reset_tokens WHERE token = $1',
            [token]
        );
        if (result.rows.length === 0) return res.json({ valid: false });
        const t = result.rows[0];
        const valid = !t.used && new Date() <= new Date(t.expires_at);
        res.json({ valid });
    } catch (err) {
        res.json({ valid: false });
    }
});

module.exports = router;
