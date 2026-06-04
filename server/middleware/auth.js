const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_km0';

/**
 * Recupera el usuario autenticado a partir del JWT almacenado en la cookie de
 * sesión. Devuelve el payload decodificado si el token es válido y no ha
 * expirado, o null en caso contrario (ausencia de cookie, firma inválida o
 * caducidad), nunca lanza.
 */
function getSessionUser(req) {
    try {
        const token = req.cookies.km0_jwt;
        if (!token) return null;
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

/**
 * Genera un middleware de control de acceso. Exige una sesión válida y, de
 * forma opcional, que el usuario posea un rol concreto. Ante una sesión
 * inexistente redirige al login; ante un rol insuficiente, a la página de
 * inicio. Si la verificación es satisfactoria, adjunta el usuario a `req.user`.
 *
 * @param {string} [role] Rol requerido para acceder a la ruta.
 */
function requireAuth(role) {
    return (req, res, next) => {
        const user = getSessionUser(req);
        if (!user) return res.redirect('/login');
        if (role && user.role !== role) return res.redirect('/');
        req.user = user;
        next();
    };
}

module.exports = { getSessionUser, requireAuth, JWT_SECRET };
