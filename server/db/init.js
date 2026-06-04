/**
 * Script de inicialización del esquema de la base de datos. Lee el fichero
 * schema.sql y lo ejecuta como una única sentencia contra PostgreSQL, creando
 * las tablas, índices y extensiones definidos. Está pensado para ejecutarse de
 * forma puntual durante el aprovisionamiento del entorno.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function initDb() {
    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        
        console.log('Ejecutando schema.sql...');
        await pool.query(schemaSql);
        console.log('Esquema creado correctamente.');
        
        process.exit(0);
    } catch (err) {
        console.error('Error inicializando la base de datos:', err);
        process.exit(1);
    }
}

initDb();
