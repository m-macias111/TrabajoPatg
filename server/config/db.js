const { Pool } = require('pg');
require('dotenv').config();

// Configuración del pool de conexiones a PostgreSQL. Se prioriza la cadena de
// conexión unificada (DATABASE_URL), habitual en entornos de despliegue, y se
// recurre a los parámetros individuales con valores por defecto para desarrollo.
const poolConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'km0_db',
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
    };

const pool = new Pool(poolConfig);

// Captura los errores emitidos por clientes inactivos del pool (p. ej. caída de
// la conexión con el servidor) para evitar que una excepción no gestionada
// derribe el proceso de Node.
pool.on('error', (err) => {
    console.error('Error inesperado en el pool de PostgreSQL:', err.message);
});

module.exports = pool;
