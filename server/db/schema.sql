-- Kilómetro 0 — Esquema de base de datos
-- Ejecutar: psql -h localhost -U km0_user -d km0_db -f server/db/schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;

-- Tipos enumerados (con guards para re-ejecución segura)
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('CLIENT', 'PRODUCER', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE verification_status AS ENUM ('UNVERIFIED', 'VERIFIED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Usuarios (clientes y productores en la misma tabla, diferenciados por role)
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    role            user_role NOT NULL DEFAULT 'CLIENT',
    name            VARCHAR(255) NOT NULL,
    last_name       VARCHAR(255),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    phone           VARCHAR(50),
    locality        VARCHAR(255),
    status          verification_status DEFAULT 'UNVERIFIED',
    is_blocked      BOOLEAN DEFAULT FALSE,
    -- Campos exclusivos de productores
    dni             VARCHAR(50),
    cadastral_ref   VARCHAR(255),
    history         TEXT,
    profile_image   TEXT,
    location        GEOMETRY(Point, 4326),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Productos (asociados a un productor)
CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    producer_id INT REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    category    VARCHAR(100) DEFAULT 'Otros',
    price       DECIMAL(10,2) NOT NULL,
    kg          DECIMAL(10,2) NOT NULL DEFAULT 1,
    pickup_day  VARCHAR(100),
    image_url   VARCHAR(500),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Pedidos
CREATE TABLE IF NOT EXISTS orders (
    id           SERIAL PRIMARY KEY,
    client_id    INT REFERENCES users(id) ON DELETE SET NULL,
    client_email VARCHAR(255),
    qr_code      VARCHAR(255) UNIQUE NOT NULL,
    total_price  DECIMAL(10,2) NOT NULL,
    status       order_status DEFAULT 'PENDING',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Líneas de pedido
CREATE TABLE IF NOT EXISTS order_items (
    id           SERIAL PRIMARY KEY,
    order_id     INT REFERENCES orders(id) ON DELETE CASCADE,
    product_id   INT REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(255),
    quantity     INT NOT NULL DEFAULT 1,
    unit_price   DECIMAL(10,2) NOT NULL
);

-- Favoritos
CREATE TABLE IF NOT EXISTS favorites (
    client_id   INT REFERENCES users(id) ON DELETE CASCADE,
    product_id  INT REFERENCES products(id) ON DELETE CASCADE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, product_id)
);

-- Columnas adicionales (idempotentes con ALTER TABLE IF NOT EXISTS column)
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_payload TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500);
-- Nombre de pila del titular del productor (name = nombre de la granja, last_name = apellidos)
ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_name VARCHAR(255);
-- Nombre de la capa de GeoServer (workspace:capa) con la huella de la parcela
-- del productor, publicada a partir de su referencia catastral.
ALTER TABLE users ADD COLUMN IF NOT EXISTS parcel_layer VARCHAR(255);
-- image_url pasa a TEXT para admitir imágenes subidas en base64 (VARCHAR(500) se queda corto)
ALTER TABLE products ALTER COLUMN image_url TYPE TEXT;

-- Tokens para recuperación de contraseña
CREATE TABLE IF NOT EXISTS reset_tokens (
    id         SERIAL PRIMARY KEY,
    user_id    INT REFERENCES users(id) ON DELETE CASCADE,
    token      VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used       BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reseñas de productores
CREATE TABLE IF NOT EXISTS reviews (
    id          SERIAL PRIMARY KEY,
    producer_id INT REFERENCES users(id) ON DELETE CASCADE,
    client_id   INT REFERENCES users(id) ON DELETE SET NULL,
    client_name VARCHAR(255),
    rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (producer_id, client_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_users_location ON users USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_products_producer ON products (producer_id);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_id);
CREATE INDEX IF NOT EXISTS idx_orders_qr ON orders (qr_code);
CREATE INDEX IF NOT EXISTS idx_reviews_producer ON reviews (producer_id);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON reset_tokens (token);
