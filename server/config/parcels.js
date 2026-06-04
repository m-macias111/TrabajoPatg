/**
 * config/parcels.js
 * Orquestador de aprovisionamiento de parcelas catastrales.
 *
 * Flujo (disparado al registrarse un productor con referencia catastral):
 *   1. Llama al proceso pygeoapi "catastro-parcela" para obtener la geometría
 *      (huella) de la parcela en GeoJSON (EPSG:4326).
 *   2. Genera un shapefile por parcela a partir de esa geometría (mapshaper).
 *   3. Publica el shapefile como capa en GeoServer vía su API REST.
 *   4. Persiste el nombre de la capa publicada en users.parcel_layer.
 *
 * Es tolerante a fallos: cualquier error se registra pero no se propaga, de modo
 * que el registro del productor nunca se ve afectado si el Catastro o GeoServer
 * no están disponibles. El polígono solo se muestra en el mapa tras la
 * verificación del productor, así que el aprovisionamiento puede ir en segundo
 * plano (fire-and-forget) y reintentarse más adelante.
 */

const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');
const pool = require('./db');

const PYGEOAPI_URL = process.env.PYGEOAPI_URL || 'http://localhost:5000';
const GEOSERVER_URL = process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver';
const GEOSERVER_USER = process.env.GEOSERVER_USER || 'admin';
const GEOSERVER_PASS = process.env.GEOSERVER_PASS || 'geoserver';
const GEOSERVER_WORKSPACE = process.env.GEOSERVER_WORKSPACE || 'km0';
// Carpeta compartida con el contenedor de GeoServer
// (./geoserver_shapefiles -> /opt/geoserver/data_dir/shapefiles).
const SHAPEFILE_DIR = path.resolve(
    process.env.SHAPEFILE_DIR || path.join(__dirname, '../../geoserver_shapefiles')
);

// Cabecera de autenticación básica para la API REST de GeoServer.
const GS_AUTH = 'Basic ' + Buffer.from(`${GEOSERVER_USER}:${GEOSERVER_PASS}`).toString('base64');

// .prj WGS84 de respaldo por si mapshaper no generase el fichero de proyección.
const WGS84_PRJ =
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/**
 * Aprovisiona la parcela de un productor: obtiene la geometría, genera el
 * shapefile y lo publica en GeoServer. Devuelve el nombre de la capa publicada
 * (p. ej. "km0:parcel_5") o null si no se pudo completar.
 *
 * @param {number} producerId Identificador del productor en la tabla users.
 * @param {string} cadastralRef Referencia catastral introducida en el registro.
 * @returns {Promise<string|null>}
 */
async function provisionParcel(producerId, cadastralRef) {
    if (!producerId || !cadastralRef) return null;
    const layerBase = `parcel_${producerId}`;

    try {
        // 1. Geometría desde el proceso pygeoapi
        const geometry = await fetchParcelGeometry(cadastralRef);
        if (!geometry) {
            console.warn(`[parcels] Sin geometría para productor ${producerId} (RC ${cadastralRef}).`);
            return null;
        }

        // 2. Shapefile a partir del GeoJSON
        await writeShapefile(layerBase, geometry);

        // 3. Publicación en GeoServer
        await publishToGeoServer(layerBase);

        // 4. Persistir la capa asociada al productor
        const layerName = `${GEOSERVER_WORKSPACE}:${layerBase}`;
        await pool.query(
            'UPDATE users SET parcel_layer = $1 WHERE id = $2',
            [layerName, producerId]
        );
        console.log(`[parcels] Parcela publicada para productor ${producerId}: ${layerName}`);
        return layerName;
    } catch (err) {
        console.error(`[parcels] Error aprovisionando parcela del productor ${producerId}:`, err.message);
        return null;
    }
}

/**
 * Invoca el proceso OGC API - Processes "catastro-parcela" de pygeoapi y
 * devuelve la geometría GeoJSON de la parcela (o null si no hay).
 */
async function fetchParcelGeometry(cadastralRef) {
    const url = `${PYGEOAPI_URL}/processes/catastro-parcela/execution`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: { referencia_catastral: cadastralRef } })
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`pygeoapi respondió ${response.status}: ${text.slice(0, 200)}`);
    }
    const result = await response.json();
    // El proceso devuelve { geometry, bbox, ... }; admitimos también una
    // FeatureCollection por robustez ante cambios de formato de salida.
    if (result && result.geometry) return result.geometry;
    if (result && result.type === 'Feature' && result.geometry) return result.geometry;
    if (result && result.type && result.coordinates) return result;
    return null;
}

/**
 * Convierte una geometría GeoJSON en un shapefile (.shp/.shx/.dbf/.prj) escrito
 * en SHAPEFILE_DIR con el nombre base indicado. Envuelve la geometría en una
 * Feature para que mapshaper genere una tabla de atributos válida.
 */
async function writeShapefile(layerBase, geometry) {
    fs.mkdirSync(SHAPEFILE_DIR, { recursive: true });

    const featureCollection = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { layer: layerBase }, geometry }]
    };

    const input = { 'input.json': JSON.stringify(featureCollection) };
    const commands = `-i input.json -o format=shapefile ${layerBase}.shp`;
    const output = await mapshaper.applyCommands(commands, input);

    let wrotePrj = false;
    for (const [fileName, content] of Object.entries(output)) {
        fs.writeFileSync(path.join(SHAPEFILE_DIR, fileName), content);
        if (fileName.endsWith('.prj')) wrotePrj = true;
    }
    // Garantizar siempre un .prj WGS84 (GeoServer lo necesita para fijar el SRS).
    if (!wrotePrj) {
        fs.writeFileSync(path.join(SHAPEFILE_DIR, `${layerBase}.prj`), WGS84_PRJ);
    }
}

/**
 * Publica el shapefile como capa en GeoServer de forma idempotente: asegura el
 * workspace, recrea el datastore apuntando al fichero y publica el featuretype.
 */
async function publishToGeoServer(layerBase) {
    await ensureWorkspace();

    // Datastore: si ya existe, se elimina en cascada para re-publicar limpio.
    await gsRequest(
        'DELETE',
        `/rest/workspaces/${GEOSERVER_WORKSPACE}/datastores/${layerBase}?recurse=true`,
        null, null, [200, 404]
    );

    const dataStoreXml =
        `<dataStore><name>${layerBase}</name><connectionParameters>` +
        `<entry key="url">file:shapefiles/${layerBase}.shp</entry>` +
        `<entry key="charset">UTF-8</entry>` +
        `</connectionParameters></dataStore>`;
    await gsRequest(
        'POST',
        `/rest/workspaces/${GEOSERVER_WORKSPACE}/datastores`,
        dataStoreXml, 'application/xml', [200, 201]
    );

    const featureTypeXml =
        `<featureType><name>${layerBase}</name><nativeName>${layerBase}</nativeName>` +
        `<srs>EPSG:4326</srs><enabled>true</enabled></featureType>`;
    await gsRequest(
        'POST',
        `/rest/workspaces/${GEOSERVER_WORKSPACE}/datastores/${layerBase}/featuretypes`,
        featureTypeXml, 'application/xml', [200, 201]
    );
}

/** Crea el workspace de GeoServer si no existe (ignora el conflicto si ya está). */
async function ensureWorkspace() {
    await gsRequest(
        'POST', '/rest/workspaces',
        `<workspace><name>${GEOSERVER_WORKSPACE}</name></workspace>`,
        'application/xml', [200, 201, 401, 409, 500]
    );
}

/**
 * Helper para la API REST de GeoServer. Lanza si el código de estado no está
 * entre los aceptados.
 */
async function gsRequest(method, pathName, body, contentType, okStatuses) {
    const headers = { Authorization: GS_AUTH };
    if (contentType) headers['Content-Type'] = contentType;
    const response = await fetch(`${GEOSERVER_URL}${pathName}`, { method, headers, body });
    if (!okStatuses.includes(response.status)) {
        const text = await response.text().catch(() => '');
        throw new Error(`GeoServer ${method} ${pathName} -> ${response.status}: ${text.slice(0, 200)}`);
    }
    return response;
}

module.exports = {
    provisionParcel,
    fetchParcelGeometry,
    // Constantes reutilizadas por el endpoint que consume GeoServer.
    GEOSERVER_URL,
    GEOSERVER_WORKSPACE,
    GS_AUTH
};
