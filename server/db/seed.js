// Kilómetro 0 — Script de poblado (seed) de la base de datos PostgreSQL.
// Uso: node server/db/seed.js   (desde la raíz del proyecto)
// Cifra las contraseñas con bcrypt e inserta un conjunto de datos de ejemplo
// (productores, clientes y productos) para disponer de un entorno de pruebas
// representativo.

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('../config/db');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;
const TEST_PASSWORD = '123';

const producers = [
    { name: 'Huerta del Jarama', lastName: 'García Ruiz', email: 'jarama@test.com', locality: 'San Martín de la Vega, Madrid', lat: 40.2128, lng: -3.5732, phone: '+34 600111222', verified: true, history: 'Nuestra huerta familiar lleva más de 40 años cultivando tomates, pimientos y lechugas a orillas del río Jarama. Riego por goteo y cero pesticidas.', profileImage: 'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=400', dni: 'DNI 12345678A', catastral: '28127A00200001' },
    { name: 'Granja Ávila Orgánica', lastName: 'Martín López', email: 'avila@test.com', locality: 'Navalcarnero, Madrid', lat: 40.2890, lng: -3.9310, phone: '+34 611222333', verified: true, history: 'Granja ecológica certificada. Criamos gallinas en libertad y cultivamos hortalizas de temporada en 12 hectáreas de campo abierto.', profileImage: 'https://images.unsplash.com/photo-1516253593875-bd7ba052b734?w=400', dni: 'DNI 23456789B', catastral: '28107A00100002' },
    { name: 'Quesería Sierra Norte', lastName: 'Pascual Sanz', email: 'queso@test.com', locality: 'Rascafría, Madrid', lat: 40.9040, lng: -3.8720, phone: '+34 622333444', verified: true, history: 'Elaboramos quesos artesanales con leche cruda de nuestras propias cabras que pastan libres en la Sierra de Guadarrama. Premiados en 2024.', profileImage: 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=400', dni: 'DNI 34567890C', catastral: '28151A00300003' },
    { name: 'Miel Sierra de Madrid', lastName: 'Álvarez Díaz', email: 'miel@test.com', locality: 'Miraflores de la Sierra, Madrid', lat: 40.8140, lng: -3.7680, phone: '+34 633444555', verified: true, history: 'Apicultores de tercera generación. Nuestras 200 colmenas están en plena Sierra de Madrid, produciendo miel cruda de romero, tomillo y encina.', profileImage: 'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?w=400', dni: 'DNI 45678901D', catastral: '28086A00100004' },
    { name: 'Carnes Valle del Lozoya', lastName: 'López Herrero', email: 'carne@test.com', locality: 'Buitrago del Lozoya, Madrid', lat: 40.9880, lng: -3.6350, phone: '+34 644555666', verified: true, history: 'Ganadería extensiva de vacuno y cerdo ibérico en el Valle del Lozoya. Bienestar animal garantizado y sacrificio en matadero local.', profileImage: 'https://images.unsplash.com/photo-1603048297172-c92544798d5e?w=400', dni: 'DNI 56789012E', catastral: '28028A00200005' },
    { name: 'Bodega Arganda', lastName: 'Ruiz Fernández', email: 'vino@test.com', locality: 'Arganda del Rey, Madrid', lat: 40.3010, lng: -3.4890, phone: '+34 655666777', verified: true, history: 'Viñedos centenarios en la D.O. Vinos de Madrid. Elaboramos tintos, blancos y rosados con variedades autóctonas como Malvar y Garnacha.', profileImage: 'https://images.unsplash.com/photo-1506377247377-2a5b3b417ebb?w=400', dni: 'DNI 67890123F', catastral: '28014A00300006' },
    { name: 'Huevos de Campo Chinchón', lastName: 'Moreno Gil', email: 'huevos@test.com', locality: 'Chinchón, Madrid', lat: 40.1400, lng: -3.4190, phone: '+34 666777888', verified: true, history: 'Gallinas camperas alimentadas con pienso ecológico y libertad total. Huevos frescos recogidos cada mañana, del corral a tu mesa en 24h.', profileImage: 'https://images.unsplash.com/photo-1569127959161-2b1297b2d9a6?w=400', dni: 'DNI 78901234G', catastral: '28052A00100007' },
    { name: 'Aceites de Villaconejos', lastName: 'Jiménez Torres', email: 'aceite@test.com', locality: 'Villaconejos, Madrid', lat: 40.1050, lng: -3.4820, phone: '+34 677888999', verified: true, history: 'Olivares tradicionales de la variedad Cornicabra. Prensado en frío en nuestra almazara familiar. Aceite de oliva virgen extra con D.O. Madrid.', profileImage: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=400', dni: 'DNI 89012345H', catastral: '28183A00200008' },
    { name: 'Huerta Valenciana', lastName: 'Ferrer Blasco', email: 'naranjas@test.com', locality: 'Carcaixent, Valencia', lat: 39.1230, lng: -0.4430, phone: '+34 688999000', verified: true, history: 'Cítricos con denominación de origen de la Ribera del Xúquer. Naranjas y mandarinas recolectadas por la mañana y enviadas el mismo día.', profileImage: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400', dni: 'DNI 90123456I', catastral: '46080A00300009' },
    { name: 'Conservas del Cantábrico', lastName: 'Gómez Pardo', email: 'conservas@test.com', locality: 'Santoña, Cantabria', lat: 43.4430, lng: -3.4580, phone: '+34 699000111', verified: true, history: 'Anchoas y bonito del norte preparados artesanalmente en nuestro obrador de Santoña. Tradición marinera desde 1952.', profileImage: 'https://images.unsplash.com/photo-1534483509719-8a22baa3789c?w=400', dni: 'DNI 01234567J', catastral: '39079A00100010' },
];

const clients = [
    { name: 'Carlos', lastName: 'Ruiz', email: 'carlos@test.com' },
    { name: 'Ana', lastName: 'López', email: 'ana@test.com' },
    { name: 'María', lastName: 'Santos', email: 'maria@test.com' },
];

// El campo pIdx referencia, mediante índice (base 0), al productor del array
// anterior al que pertenece cada producto.
const products = [
    { pIdx: 0, name: 'Pack Tomates Rosa 5kg', category: 'Verduras', price: 12.50, kg: 5.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?w=800' },
    { pIdx: 0, name: 'Cesta Verduras Temporada 8kg', category: 'Verduras', price: 18.00, kg: 8.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=800' },
    { pIdx: 0, name: 'Pimientos Padrón 1kg', category: 'Verduras', price: 6.00, kg: 1.0, pickup_day: 'Miércoles', image_url: 'https://images.unsplash.com/photo-1595856461972-749e39bf09cb?w=800' },
    { pIdx: 0, name: 'Lechugas Variadas Pack x6', category: 'Verduras', price: 4.50, kg: 2.0, pickup_day: 'Lunes', image_url: 'https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?w=800' },
    { pIdx: 1, name: 'Cesta Ecológica Semanal', category: 'Verduras', price: 22.00, kg: 6.0, pickup_day: 'Sábado', image_url: 'https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=800' },
    { pIdx: 1, name: 'Calabacines Ecológicos 3kg', category: 'Verduras', price: 5.50, kg: 3.0, pickup_day: 'Miércoles', image_url: 'https://images.unsplash.com/photo-1563252722-6434563a3089?w=800' },
    { pIdx: 1, name: 'Zanahorias Frescas 2kg', category: 'Verduras', price: 3.80, kg: 2.0, pickup_day: 'Miércoles', image_url: 'https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?w=800' },
    { pIdx: 2, name: 'Queso Curado de Cabra 1kg', category: 'Lácteos', price: 18.50, kg: 1.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=800' },
    { pIdx: 2, name: 'Queso Semicurado 500g', category: 'Lácteos', price: 9.90, kg: 0.5, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1559561853-08451507cbe7?w=800' },
    { pIdx: 2, name: 'Yogur Artesano de Cabra 1L', category: 'Lácteos', price: 4.50, kg: 1.0, pickup_day: 'Martes', image_url: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=800' },
    { pIdx: 3, name: 'Miel de Romero 1kg', category: 'Miel', price: 12.00, kg: 1.0, pickup_day: 'Lunes', image_url: 'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?w=800' },
    { pIdx: 3, name: 'Miel de Encina 500g', category: 'Miel', price: 8.50, kg: 0.5, pickup_day: 'Lunes', image_url: 'https://images.unsplash.com/photo-1587049352851-8d4e89134a66?w=800' },
    { pIdx: 3, name: 'Polen Fresco 250g', category: 'Miel', price: 9.00, kg: 0.25, pickup_day: 'Miércoles', image_url: 'https://images.unsplash.com/photo-1599839619722-39751411ea63?w=800' },
    { pIdx: 4, name: 'Chuletón de Ternera 1.2kg', category: 'Carnes', price: 32.00, kg: 1.2, pickup_day: 'Jueves', image_url: 'https://images.unsplash.com/photo-1558030006-450675393462?w=800' },
    { pIdx: 4, name: 'Carne Picada Ecológica 1kg', category: 'Carnes', price: 14.50, kg: 1.0, pickup_day: 'Jueves', image_url: 'https://images.unsplash.com/photo-1588168333986-5078d3ae3976?w=800' },
    { pIdx: 4, name: 'Secreto Ibérico 800g', category: 'Carnes', price: 19.00, kg: 0.8, pickup_day: 'Jueves', image_url: 'https://images.unsplash.com/photo-1544025162-836b761619cd?w=800' },
    { pIdx: 5, name: 'Tinto Crianza 6 botellas', category: 'Bebidas', price: 42.00, kg: 6.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1506377247377-2a5b3b417ebb?w=800' },
    { pIdx: 5, name: 'Blanco Malvar 2 botellas', category: 'Bebidas', price: 16.00, kg: 2.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1584916201218-f4242ceb4809?w=800' },
    { pIdx: 5, name: 'Rosado Garnacha Botella', category: 'Bebidas', price: 8.50, kg: 1.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1585553616435-2dc0a54e271d?w=800' },
    { pIdx: 6, name: 'Huevos Camperos Docena', category: 'Otros', price: 4.80, kg: 0.8, pickup_day: 'Martes y Viernes', image_url: 'https://images.unsplash.com/photo-1569127959161-2b1297b2d9a6?w=800' },
    { pIdx: 6, name: 'Huevos XL Pack 30 uds.', category: 'Otros', price: 11.00, kg: 2.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1498654077810-12c21d4d6dc3?w=800' },
    { pIdx: 7, name: 'AOVE Cornicabra 1L', category: 'Otros', price: 9.50, kg: 1.0, pickup_day: 'Sábado', image_url: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=800' },
    { pIdx: 7, name: 'AOVE Premium Edición Limitada 500ml', category: 'Otros', price: 14.00, kg: 0.5, pickup_day: 'Sábado', image_url: 'https://images.unsplash.com/photo-1545231027-637d2f6210f8?w=800' },
    { pIdx: 8, name: 'Naranjas de Zumo 10kg', category: 'Frutas', price: 14.00, kg: 10.0, pickup_day: 'Sábado', image_url: 'https://images.unsplash.com/photo-1611080626919-7cf5a9dbab5b?w=800' },
    { pIdx: 8, name: 'Mandarinas Clementinas 5kg', category: 'Frutas', price: 9.00, kg: 5.0, pickup_day: 'Sábado', image_url: 'https://images.unsplash.com/photo-1550258859-d088c27e2815?w=800' },
    { pIdx: 8, name: 'Limones Ecológicos 3kg', category: 'Frutas', price: 5.50, kg: 3.0, pickup_day: 'Viernes', image_url: 'https://images.unsplash.com/photo-1590502593747-422896500473?w=800' },
    { pIdx: 9, name: 'Anchoas del Cantábrico 8 filetes', category: 'Otros', price: 12.00, kg: 0.1, pickup_day: 'Lunes a Viernes', image_url: 'https://images.unsplash.com/photo-1534483509719-8a22baa3789c?w=800' },
    { pIdx: 9, name: 'Bonito del Norte en Aceite 250g', category: 'Otros', price: 8.50, kg: 0.25, pickup_day: 'Lunes a Viernes', image_url: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=800' },
];

/**
 * Vacía las tablas dependientes en orden de integridad referencial, reinicia
 * las secuencias de identificadores e inserta el conjunto de datos de ejemplo.
 * Toda la operación se ejecuta dentro de una transacción: si cualquier paso
 * falla, se revierte por completo para no dejar la base de datos en un estado
 * inconsistente.
 */
async function seed() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Limpiando tablas...');
        await client.query('DELETE FROM favorites');
        await client.query('DELETE FROM order_items');
        await client.query('DELETE FROM orders');
        await client.query('DELETE FROM products');
        await client.query('DELETE FROM users');
        await client.query('ALTER SEQUENCE users_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE products_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE orders_id_seq RESTART WITH 1');

        const hash = await bcrypt.hash(TEST_PASSWORD, SALT_ROUNDS);
        const producerIds = [];

        console.log('Insertando productores...');
        for (const p of producers) {
            const res = await client.query(
                `INSERT INTO users (role, name, last_name, email, password_hash, phone, locality, status, is_blocked, dni, cadastral_ref, history, profile_image, location)
                 VALUES ('PRODUCER', $1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11, ST_SetSRID(ST_MakePoint($12, $13), 4326))
                 RETURNING id`,
                [p.name, p.lastName, p.email, hash, p.phone, p.locality,
                 p.verified ? 'VERIFIED' : 'UNVERIFIED',
                 p.dni, p.catastral, p.history, p.profileImage, p.lng, p.lat]
            );
            producerIds.push(res.rows[0].id);
        }

        console.log('Insertando clientes...');
        for (const c of clients) {
            await client.query(
                `INSERT INTO users (role, name, last_name, email, password_hash, status)
                 VALUES ('CLIENT', $1, $2, $3, $4, 'UNVERIFIED')`,
                [c.name, c.lastName, c.email, hash]
            );
        }

        console.log('Insertando productos...');
        for (const p of products) {
            await client.query(
                `INSERT INTO products (producer_id, name, category, price, kg, pickup_day, image_url)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [producerIds[p.pIdx], p.name, p.category, p.price, p.kg, p.pickup_day, p.image_url]
            );
        }

        await client.query('COMMIT');
        console.log('');
        console.log('Seed completado:');
        console.log('   ' + producers.length + ' productores  |  ' + clients.length + ' clientes  |  ' + products.length + ' productos');
        console.log('Contrasena de prueba para todos los usuarios: "' + TEST_PASSWORD + '"');
        console.log('Admin: admin@admin / admin  (hardcoded, no esta en la DB)');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en seed:', err.message);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

seed().catch(() => process.exit(1));
