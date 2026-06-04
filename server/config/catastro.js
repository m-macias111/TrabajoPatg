/**
 * config/catastro.js
 * Utilidades para la validación y obtención de coordenadas de referencias catastrales.
 * Incluye soporte para el Catastro oficial de España y validación offline para 
 * las regiones con régimen foral (País Vasco y Navarra).
 */

/**
 * Verifica la integridad de una referencia catastral de 20 caracteres mediante
 * el cálculo de sus dos dígitos de control. El algoritmo pondera cada carácter
 * (convertido a su valor numérico) por una secuencia de pesos fija y aplica
 * aritmética modular para derivar las letras de control, comparándolas con las
 * dos últimas posiciones de la referencia.
 *
 * @param {string} referenciaCatastral Referencia de exactamente 20 caracteres.
 * @returns {boolean} true si los dígitos de control son coherentes.
 */
function validarReferenciaCatastral(referenciaCatastral) {
    if (!referenciaCatastral || referenciaCatastral.length !== 20) {
        return false;
    }

    const rc = referenciaCatastral.toUpperCase();
    const pesoPosicion = [13, 15, 12, 5, 4, 17, 9, 21, 3, 7, 1];
    const letraDc = 'MQWERTYUIOPASDFGHJKLBZX';

    // Se calculan los dos dígitos de control usando subcadenas específicas
    const cadenaPrimerDC = rc.substring(0, 7) + rc.substring(14, 18);
    const cadenaSegundoDC = rc.substring(7, 14) + rc.substring(14, 18);

    // Calcula un dígito de control sobre la cadena dada: acumula el valor
    // ponderado de cada carácter y proyecta el resultado al alfabeto de control.
    function calcularDC(cadena) {
        let suma = 0;
        for (let i = 0; i < cadena.length; i++) {
            let valor = cadena.charCodeAt(i);
            if (valor >= 65 && valor <= 90) { // A-Z
                valor = valor - 64;          // A=1 ... N=14 ... Z=26 (ASCII)
                // En el alfabeto catastral la 'Ñ' ocupa la posición 15, así que
                // las letras de la O a la Z se desplazan una posición hacia arriba.
                if (valor > 14) valor += 1;
            } else { // 0-9
                valor = parseInt(cadena[i], 10);
            }
            suma += valor * pesoPosicion[i % pesoPosicion.length];
        }
        return letraDc[suma % 23];
    }

    const dc1 = calcularDC(cadenaPrimerDC);
    const dc2 = calcularDC(cadenaSegundoDC);

    return (dc1 + dc2) === rc.substring(18, 20);
}

/**
 * Valida una referencia catastral aplicando la estrategia adecuada según su
 * provincia de origen. Las provincias de régimen foral (Álava, Gipuzkoa,
 * Bizkaia y Navarra) no están integradas en el servicio nacional del Catastro,
 * por lo que se validan localmente contra los formatos admitidos. El resto se
 * comprueba primero offline (dígitos de control) y, si procede, contra el
 * servicio web oficial OVCCallejero del Catastro.
 *
 * @param {string} rc Referencia catastral introducida por el usuario.
 * @returns {Promise<Object>} Objeto con `valid` y, en caso afirmativo, los
 *   datos de localización; en caso negativo, el motivo en `error`.
 */
async function validateCadastralRef(rc) {
    if (!rc) {
        return { valid: false, error: 'La referencia catastral es obligatoria.' };
    }
    const cleanRc = rc.trim().toUpperCase().replace(/[\s.-]/g, '');

    // Los dos primeros dígitos codifican la provincia según la numeración del INE.
    const provCode = cleanRc.substring(0, 2);
    // 01 = Álava, 20 = Gipuzkoa, 48 = Bizkaia, 31 = Navarra
    const isForal = ['01', '20', '48', '31'].includes(provCode);

    if (isForal) {
        let province = '';
        if (provCode === '01') province = 'Álava';
        else if (provCode === '20') province = 'Gipuzkoa';
        else if (provCode === '48') province = 'Bizkaia';
        else if (provCode === '31') province = 'Navarra';

        // Validar si cumple el formato de 20 caracteres nacional
        if (cleanRc.length === 20) {
            const isValidDC = validarReferenciaCatastral(cleanRc);
            if (isValidDC) {
                return {
                    valid: true,
                    isForal: true,
                    province,
                    data: {
                        direccion: `Referencia Foral de ${province}`,
                        provincia: province,
                        municipio: 'Municipio Foral'
                    }
                };
            } else {
                return { valid: false, error: 'Dígitos de control incorrectos para la referencia catastral foral. Revise el formato.' };
            }
        } else {
            // Validar formatos forales locales (ej. Número Fijo de Bizkaia de 9 posiciones, u otras entre 8 y 16)
            if (cleanRc.length >= 8 && cleanRc.length <= 16 && /^[0-9A-Z]+$/.test(cleanRc)) {
                return {
                    valid: true,
                    isForal: true,
                    province,
                    data: {
                        direccion: `Referencia Foral Local de ${province}`,
                        provincia: province,
                        municipio: 'Municipio Foral'
                    }
                };
            } else {
                return { valid: false, error: `La referencia catastral de ${province} debe tener 20 caracteres (nacional) o entre 8 y 16 caracteres (local).` };
            }
        }
    }

    // Régimen común (resto de España)
    if (cleanRc.length !== 20) {
        return { valid: false, error: 'La referencia catastral debe tener exactamente 20 caracteres.' };
    }

    // Validación offline de control para evitar llamadas API innecesarias
    if (!validarReferenciaCatastral(cleanRc)) {
        return { valid: false, error: 'Dígitos de control incorrectos. Verifique la referencia catastral.' };
    }

    try {
        const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=&Municipio=&RC=${cleanRc}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Error en el servidor del Catastro (${response.status})`);
        }
        const xmlText = await response.text();

        // La respuesta es un XML simple y de estructura conocida, por lo que se
        // extraen los campos relevantes mediante expresiones regulares en lugar
        // de incorporar una dependencia de parseo XML completa.
        const errReg = /<cod>([^<]+)<\/cod>/g;
        const msgReg = /<des>([^<]+)<\/des>/g;
        const errors = [];
        const messages = [];
        let match;
        
        while ((match = errReg.exec(xmlText)) !== null) {
            errors.push(match[1].trim());
        }
        while ((match = msgReg.exec(xmlText)) !== null) {
            messages.push(match[1].trim());
        }

        // Si la RC está mal formada (4) o no existe (5)
        if (errors.includes('4') || errors.includes('5') || errors.includes('ERR')) {
            const errorMsg = messages[0] || 'La referencia catastral no existe en el Catastro.';
            return { valid: false, error: errorMsg };
        }

        if (!xmlText.includes('<ldt>')) {
            return { valid: false, error: 'La referencia catastral no se encuentra registrada o es inválida.' };
        }

        const ldtMatch = xmlText.match(/<ldt>([^<]+)<\/ldt>/);
        const provMatch = xmlText.match(/<prov>([^<]+)<\/prov>/);
        const munMatch = xmlText.match(/<muni>([^<]+)<\/muni>/);

        const address = ldtMatch ? ldtMatch[1].trim() : 'Dirección no disponible';
        const provincia = provMatch ? provMatch[1].trim() : '';
        const municipio = munMatch ? munMatch[1].trim() : '';

        return {
            valid: true,
            isForal: false,
            data: {
                direccion: address,
                provincia: provincia,
                municipio: municipio
            }
        };
    } catch (error) {
        console.error('Error al validar RC con Catastro:', error);
        return {
            valid: false,
            error: 'No se pudo conectar con el servidor de Catastro para la verificación en tiempo real. Inténtelo más tarde.'
        };
    }
}

/**
 * Obtiene las coordenadas geográficas (latitud/longitud, EPSG:4326) asociadas a
 * una referencia catastral para situar el marcador en el mapa. Para los
 * territorios forales —no cubiertos por el servicio nacional— se devuelve la
 * coordenada de la capital de provincia como aproximación, dejando al usuario
 * el ajuste fino. Para el régimen común se consulta el servicio OVCCoordenadas
 * del Catastro, que requiere los 14 primeros caracteres de la referencia.
 *
 * @param {string} rc Referencia catastral.
 * @returns {Promise<Object>} `{ success, lat, lng, address }` o `{ success:false, error }`.
 */
async function getCadastralCoords(rc) {
    if (!rc) {
        return { success: false, error: 'Referencia catastral requerida' };
    }
    const cleanRc = rc.trim().toUpperCase().replace(/[\s.-]/g, '');
    const provCode = cleanRc.substring(0, 2);

    // Fallback de coordenadas para territorios históricos
    const foralCapitals = {
        '01': { lat: 42.8467, lng: -2.6723, address: 'Vitoria-Gasteiz, Álava (Mueve el marcador a la granja)' },
        '20': { lat: 43.3183, lng: -1.9812, address: 'Donostia, Gipuzkoa (Mueve el marcador a la granja)' },
        '48': { lat: 43.2630, lng: -2.9350, address: 'Bilbao, Bizkaia (Mueve el marcador a la granja)' },
        '31': { lat: 42.8125, lng: -1.6456, address: 'Pamplona, Navarra (Mueve el marcador a la granja)' }
    };

    if (foralCapitals[provCode]) {
        return {
            success: true,
            isForal: true,
            lat: foralCapitals[provCode].lat,
            lng: foralCapitals[provCode].lng,
            address: foralCapitals[provCode].address
        };
    }

    if (cleanRc.length >= 8 && cleanRc.length <= 16 && !cleanRc.match(/^[0-9]{2}/)) {
        // Asumimos formato foral local si no empieza con código numérico (ej. letra inicial)
        return {
            success: true,
            isForal: true,
            lat: 43.2630,
            lng: -2.9350,
            address: 'Ubicación Foral (Mueve el marcador a la granja)'
        };
    }

    // Régimen común (Consulta_CPMRC requiere exactamente 14 caracteres)
    const rc14 = cleanRc.substring(0, 14);
    
    try {
        const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCoordenadas.asmx/Consulta_CPMRC?Provincia=&Municipio=&SRS=EPSG:4326&RC=${rc14}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Error en servidor del Catastro (${response.status})`);
        }
        const xmlText = await response.text();

        if (!xmlText.includes('<xcen>') || !xmlText.includes('<ycen>')) {
            return { success: false, error: 'No se encontraron coordenadas para esta referencia.' };
        }

        const xcenMatch = xmlText.match(/<xcen>([^<]+)<\/xcen>/);
        const ycenMatch = xmlText.match(/<ycen>([^<]+)<\/ycen>/);
        const ldtMatch = xmlText.match(/<ldt>([^<]+)<\/ldt>/);

        if (!xcenMatch || !ycenMatch) {
            return { success: false, error: 'Coordenadas mal formadas en la respuesta del Catastro.' };
        }

        const lng = parseFloat(xcenMatch[1]);
        const lat = parseFloat(ycenMatch[1]);
        const address = ldtMatch ? ldtMatch[1].trim() : 'Dirección catastral';

        return {
            success: true,
            isForal: false,
            lat,
            lng,
            address
        };
    } catch (error) {
        console.error('Error al obtener coordenadas:', error);
        return { success: false, error: error.message || 'Error al conectar con el servidor de Catastro.' };
    }
}

module.exports = {
    validarReferenciaCatastral,
    validateCadastralRef,
    getCadastralCoords
};
