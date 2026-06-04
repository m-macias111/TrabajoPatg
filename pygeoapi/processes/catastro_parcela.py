# =============================================================================
# catastro_parcela.py
# Proceso OGC API - Processes para pygeoapi.
#
# Recibe una referencia catastral española y devuelve la geometría (huella) de
# la parcela en GeoJSON (EPSG:4326). Es un proceso "puro": no escribe en disco
# ni publica nada; se limita a consultar el servicio WFS INSPIRE del Catastro,
# parsear el GML y devolver la geometría. La orquestación (shapefile + GeoServer)
# la realiza el backend Node a partir de esta respuesta.
# =============================================================================

import logging
import re
import urllib.request
import urllib.error
from xml.etree import ElementTree as ET

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

LOGGER = logging.getLogger(__name__)

# Servicio WFS INSPIRE de Parcelas Catastrales (Cadastral Parcels) del Catastro.
# La stored query "GetParcel" admite el parámetro `refcat` con la referencia
# catastral de 14 caracteres y devuelve la geometría de la parcela en GML 3.2.
WFS_CP_URL = 'https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx'

# Espacios de nombres usados en la respuesta GML del Catastro.
GML_NS = 'http://www.opengis.net/gml/3.2'

PROCESS_METADATA = {
    'version': '1.0.0',
    'id': 'catastro-parcela',
    'title': {
        'en': 'Cadastral parcel geometry',
        'es': 'Geometría de parcela catastral'
    },
    'description': {
        'en': ('Given a Spanish cadastral reference, returns the geometry '
               '(footprint) of the parcel as GeoJSON in EPSG:4326, querying '
               'the Catastro INSPIRE Cadastral Parcels WFS service.'),
        'es': ('Dada una referencia catastral española, devuelve la geometría '
               '(huella) de la parcela en GeoJSON (EPSG:4326), consultando el '
               'servicio WFS INSPIRE de Parcelas Catastrales del Catastro.')
    },
    'jobControlOptions': ['sync-execute'],
    'keywords': ['catastro', 'parcela', 'inspire', 'cadastre', 'km0'],
    'inputs': {
        'referencia_catastral': {
            'title': 'Referencia catastral',
            'description': ('Referencia catastral (14 a 20 caracteres). Solo se '
                            'utilizan los 14 primeros, que identifican la parcela.'),
            'schema': {'type': 'string'},
            'minOccurs': 1,
            'maxOccurs': 1
        }
    },
    'outputs': {
        'parcela': {
            'title': 'Parcela',
            'description': 'Geometría de la parcela y metadatos asociados.',
            'schema': {'contentMediaType': 'application/json'}
        }
    },
    'example': {
        'inputs': {
            'referencia_catastral': '13077A018000390000FP'
        }
    }
}


class CatastroParcelaProcessor(BaseProcessor):
    """Obtiene la geometría de una parcela catastral desde el WFS del Catastro."""

    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):
        # `outputs` lo pasan las versiones recientes de pygeoapi (selección de
        # salidas); este proceso devuelve siempre el objeto completo, así que se
        # acepta por compatibilidad pero no se utiliza.
        rc = (data or {}).get('referencia_catastral')
        if not rc or not isinstance(rc, str):
            raise ProcessorExecuteError('Falta la referencia catastral.')

        # Normaliza igual que el backend Node: mayúsculas, sin separadores, y se
        # queda con los 14 caracteres que identifican la parcela.
        clean_rc = re.sub(r'[\s.\-]', '', rc.strip().upper())
        if len(clean_rc) < 14:
            raise ProcessorExecuteError(
                'La referencia catastral debe tener al menos 14 caracteres.')
        rc14 = clean_rc[:14]

        gml_text = self._fetch_parcel_gml(rc14)
        geometry = self._gml_to_geojson_geometry(gml_text)

        if geometry is None:
            raise ProcessorExecuteError(
                'No se encontró geometría para la referencia catastral '
                f'{rc14}. Puede no existir o pertenecer a territorio foral '
                '(no cubierto por el WFS INSPIRE nacional).')

        bbox = self._bbox(geometry)
        outputs = {
            'id': 'catastro-parcela',
            'referencia_catastral': rc14,
            'crs': 'EPSG:4326',
            'geometry': geometry,
            'bbox': bbox
        }
        return 'application/json', outputs

    # -- Helpers --------------------------------------------------------------

    def _fetch_parcel_gml(self, rc14):
        """Descarga el GML de la parcela desde el WFS INSPIRE del Catastro."""
        query = (
            f'{WFS_CP_URL}?service=WFS&version=2.0.0&request=GetFeature'
            f'&STOREDQUERIE_ID=GetParcel&refcat={rc14}'
            '&srsname=urn:ogc:def:crs:EPSG::4326'
        )
        try:
            req = urllib.request.Request(query, headers={'User-Agent': 'km0-pygeoapi'})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode('utf-8', errors='replace')
        except urllib.error.URLError as err:
            LOGGER.error('Error consultando el WFS del Catastro: %s', err)
            raise ProcessorExecuteError(
                'No se pudo conectar con el servicio WFS del Catastro.')

    def _gml_to_geojson_geometry(self, gml_text):
        """Extrae la geometría del GML y la devuelve como geometría GeoJSON.

        El Catastro modela la parcela como gml:MultiSurface -> gml:Surface ->
        gml:patches -> gml:PolygonPatch (uno o varios). Cada anillo viene como
        una gml:posList con pares de coordenadas. Con srsname EPSG:4326 el orden
        de ejes es lat,lon, así que se invierte a lon,lat (orden GeoJSON).
        Se admite también gml:Polygon como respaldo para otros emisores WFS.
        """
        try:
            root = ET.fromstring(gml_text)
        except ET.ParseError as err:
            LOGGER.error('GML no parseable: %s', err)
            return None

        # Cada PolygonPatch (o Polygon) representa un polígono; varios dentro de
        # un MultiSurface forman un MultiPolygon. Si el WFS devuelve una
        # excepción (RC inexistente, etc.) no habrá ninguno: "sin parcela".
        patches = list(root.iter(f'{{{GML_NS}}}PolygonPatch'))
        if not patches:
            patches = list(root.iter(f'{{{GML_NS}}}Polygon'))

        polygons = []
        for patch in patches:
            rings = self._polygon_rings(patch)
            if rings:
                polygons.append(rings)

        if not polygons:
            return None

        if len(polygons) == 1:
            return {'type': 'Polygon', 'coordinates': polygons[0]}
        return {'type': 'MultiPolygon', 'coordinates': polygons}

    def _polygon_rings(self, poly_el):
        """Devuelve los anillos [exterior, *interiores] de un gml:Polygon."""
        rings = []
        # Anillo exterior
        for tag in ('exterior', 'interior'):
            for ring_parent in poly_el.iter(f'{{{GML_NS}}}{tag}'):
                coords = self._extract_ring_coords(ring_parent)
                if coords:
                    rings.append(coords)
        return rings

    def _extract_ring_coords(self, ring_parent):
        """Lee la gml:posList de un anillo y devuelve [[lon, lat], ...]."""
        pos_list = ring_parent.find(f'.//{{{GML_NS}}}posList')
        if pos_list is None or not pos_list.text:
            return None
        nums = [float(v) for v in pos_list.text.split()]
        # Pares lat,lon -> invertir a lon,lat (GeoJSON)
        coords = [[nums[i + 1], nums[i]] for i in range(0, len(nums) - 1, 2)]
        # Asegura el anillo cerrado
        if coords and coords[0] != coords[-1]:
            coords.append(coords[0])
        return coords if len(coords) >= 4 else None

    def _bbox(self, geometry):
        """Calcula [minx, miny, maxx, maxy] de una geometría GeoJSON."""
        def iter_coords(coords):
            if coords and isinstance(coords[0], (int, float)):
                yield coords
            else:
                for c in coords:
                    yield from iter_coords(c)

        xs, ys = [], []
        for x, y in iter_coords(geometry['coordinates']):
            xs.append(x)
            ys.append(y)
        return [min(xs), min(ys), max(xs), max(ys)]

    def __repr__(self):
        return '<CatastroParcelaProcessor> catastro-parcela'
