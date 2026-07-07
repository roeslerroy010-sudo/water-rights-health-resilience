// regionSelect.js
// Spatial subbasin selection and hydrologic subnetwork extraction for the research MVP.

(function attachResearchRegionSelect(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ResearchRegionSelect = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function createApi() {
  "use strict";

  const OUTLET = "OUTLET";
  const EPS = 1e-9;
  const TRADE_SCOPE_LABELS = {
    external: "外部调水",
    internal: "内部解决",
  };

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function finiteNumber(value, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function nonNegative(value, fallback) {
    return Math.max(0, finiteNumber(value, fallback));
  }

  function firstFinite(values, fallback) {
    for (const value of values) {
      const n = finiteNumber(value, NaN);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  }

  function firstPositive(values, fallback) {
    for (const value of values) {
      const n = finiteNumber(value, NaN);
      if (Number.isFinite(n) && Math.abs(n) > EPS) return n;
    }
    return fallback;
  }

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function cleanId(value) {
    if (value === undefined || value === null || value === "") return null;
    return String(value);
  }

  function normalizeTradeScope(value) {
    return value === "internal" ? "internal" : "external";
  }

  function getTradeScopeLabel(tradeScope) {
    return TRADE_SCOPE_LABELS[normalizeTradeScope(tradeScope)] || TRADE_SCOPE_LABELS.external;
  }

  function readId(item, index) {
    const props = item && item.properties ? item.properties : {};
    return cleanId(item && (item.id || item.subbasinId || item.code || item.name))
      || cleanId(props.id || props.subbasinId || props.basin_id || props.SB_ID)
      || (index !== undefined ? "SB" + String(index + 1).padStart(2, "0") : null);
  }

  function readDownstream(item, topology) {
    const id = readId(item);
    if (id && topology && own(topology, id)) return cleanId(topology[id]);
    return cleanId(item && (item.downstream || item.downstreamId || item.drainsTo));
  }

  function getSupply(item) {
    return isObject(item && item.supply) ? item.supply : {};
  }

  function readSupplyNumber(item, names, fallback) {
    const supply = getSupply(item);
    const values = [];
    for (const name of names) {
      values.push(supply[name], item && item[name]);
    }
    if (typeof item?.supply === "number") values.push(item.supply);
    return firstFinite(values, fallback);
  }

  function readLocalSupply(item) {
    return nonNegative(readSupplyNumber(item, [
      "qLocal",
      "Q_local",
      "local",
      "localSupply",
      "localRunoff",
      "qAvail",
      "Q_avail",
      "available",
    ], 0), 0);
  }

  function readAvailableSupply(item) {
    return nonNegative(readSupplyNumber(item, [
      "qAvail",
      "Q_avail",
      "available",
      "qAvailable",
      "supply",
      "qLocal",
      "Q_local",
      "local",
      "localSupply",
      "localRunoff",
    ], 0), 0);
  }

  function readExistingExternalInflow(item) {
    const supply = getSupply(item);
    return nonNegative(firstPositive([
      supply.externalInflow,
      supply.transitInjection,
      supply.inflow,
      supply.mainstemInflow,
      supply.qTransit,
      supply.qExternal,
      item && item.externalInflow,
      item && item.transitInjection,
      item && item.inflow,
      item && item.mainstemInflow,
      item && item.qTransit,
      item && item.qExternal,
    ], 0), 0);
  }

  function sumSectorMap(map) {
    if (!isObject(map)) return 0;
    return ["urban", "eco", "agri", "industry"].reduce((sum, sector) => {
      return sum + nonNegative(map[sector], 0);
    }, 0);
  }

  function readBoundaryOutflow(item) {
    const supply = getSupply(item);
    const explicit = firstFinite([
      item && item.qOutflow,
      item && item.q_outflow,
      item && item.outflow,
      item && item.routedOutflow,
      item && item.downstreamOutflow,
      item && item.routeOutflow,
      supply.qOutflow,
      supply.q_outflow,
      supply.outflow,
      supply.routedOutflow,
      supply.downstreamOutflow,
      supply.routeOutflow,
      item && item.modelNode && item.modelNode.qOutflow,
    ], NaN);
    if (Number.isFinite(explicit)) {
      return {
        volume: nonNegative(explicit, 0),
        source: "qOutflow",
      };
    }

    const qAvail = readAvailableSupply(item);
    const withdrawn = firstFinite([
      item && item.qWithdrawn,
      item && item.withdrawn,
      item && item.withdrawal,
      supply.qWithdrawn,
      supply.withdrawn,
      item && item.modelNode && item.modelNode.qWithdrawn,
    ], NaN);
    if (Number.isFinite(withdrawn)) {
      return {
        volume: Math.max(0, qAvail - withdrawn),
        source: "qAvail-minus-withdrawn",
      };
    }

    const allocated = sumSectorMap(item && item.allocation);
    if (allocated > EPS) {
      return {
        volume: Math.max(0, qAvail - allocated),
        source: "qAvail-minus-allocation",
      };
    }

    return {
      volume: qAvail,
      source: "qAvail",
    };
  }

  function getSubbasinItems(source) {
    if (Array.isArray(source)) return source;
    if (!source) return [];
    if (Array.isArray(source.subbasins)) return source.subbasins;
    if (Array.isArray(source.basins)) return source.basins;
    if (Array.isArray(source.nodes)) return source.nodes;
    if (source.attrs) return getSubbasinItems(source.attrs);
    if (source.type === "FeatureCollection" && Array.isArray(source.features)) return source.features;
    if (Array.isArray(source.features)) {
      return source.features.map((feature, index) => ({
        ...(feature.properties || {}),
        id: feature.id || (feature.properties && feature.properties.id) || "SB" + String(index + 1).padStart(2, "0"),
        feature,
      }));
    }
    if (isObject(source.byId)) {
      return Object.entries(source.byId).map(([id, value]) => ({ ...(value || {}), id: value?.id || id }));
    }
    return Object.entries(source)
      .filter(([key, value]) => key !== "meta" && key !== "topology" && isObject(value))
      .map(([id, value]) => ({ ...value, id: value.id || id }));
  }

  function getTopology(source, items) {
    if (isObject(source && source.topology)) return source.topology;
    if (isObject(source && source.attrs && source.attrs.topology)) return source.attrs.topology;

    const topology = {};
    for (const item of items || []) {
      const id = readId(item);
      const downstream = readDownstream(item, null);
      if (id && downstream) topology[id] = downstream;
    }
    return topology;
  }

  function readCentroid(item) {
    const props = item && item.properties ? item.properties : {};
    const candidates = [
      item && item.centroid,
      props.centroid,
      item && item.center,
      props.center,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length >= 2) {
        const lng = finiteNumber(candidate[0], NaN);
        const lat = finiteNumber(candidate[1], NaN);
        if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
      }
    }
    return null;
  }

  function normalizeBbox(region) {
    if (!region) return null;
    const source = region.bbox || region.bounds || region;
    if (Array.isArray(source) && source.length >= 4) {
      const values = source.slice(0, 4).map((value) => finiteNumber(value, NaN));
      if (values.every(Number.isFinite)) {
        const minLng = Math.min(values[0], values[2]);
        const maxLng = Math.max(values[0], values[2]);
        const minLat = Math.min(values[1], values[3]);
        const maxLat = Math.max(values[1], values[3]);
        return [minLng, minLat, maxLng, maxLat];
      }
    }
    if (isObject(source)) {
      const sw = source.sw || source.southWest || source._southWest || (source.bounds && (source.bounds.sw || source.bounds.southWest));
      const ne = source.ne || source.northEast || source._northEast || (source.bounds && (source.bounds.ne || source.bounds.northEast));
      const swPoint = readLatLng(sw);
      const nePoint = readLatLng(ne);
      if (swPoint && nePoint) {
        return [
          Math.min(swPoint.lng, nePoint.lng),
          Math.min(swPoint.lat, nePoint.lat),
          Math.max(swPoint.lng, nePoint.lng),
          Math.max(swPoint.lat, nePoint.lat),
        ];
      }

      const west = firstFinite([source.west, source.minLng, source.minLon, source.left, source.lngMin, source.lonMin], NaN);
      const east = firstFinite([source.east, source.maxLng, source.maxLon, source.right, source.lngMax, source.lonMax], NaN);
      const south = firstFinite([source.south, source.minLat, source.bottom, source.latMin], NaN);
      const north = firstFinite([source.north, source.maxLat, source.top, source.latMax], NaN);
      if ([west, east, south, north].every(Number.isFinite)) {
        return [Math.min(west, east), Math.min(south, north), Math.max(west, east), Math.max(south, north)];
      }
      if (source._southWest && source._northEast) {
        return normalizeBbox({
          west: source._southWest.lng,
          south: source._southWest.lat,
          east: source._northEast.lng,
          north: source._northEast.lat,
        });
      }
    }
    return null;
  }

  function readLatLng(value) {
    if (Array.isArray(value) && value.length >= 2) {
      const lat = finiteNumber(value[0], NaN);
      const lng = finiteNumber(value[1], NaN);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    if (isObject(value)) {
      const lat = finiteNumber(value.lat ?? value.latitude, NaN);
      const lng = finiteNumber(value.lng ?? value.lon ?? value.longitude, NaN);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
  }

  function asGeometry(region) {
    if (!region) return null;
    if (region.type === "Feature") return region.geometry || null;
    if (region.geometry) return region.geometry;
    if (region.type === "Polygon" || region.type === "MultiPolygon") return region;
    if (region.type === "polygon" && Array.isArray(region.coordinates)) {
      return { type: "Polygon", coordinates: region.coordinates };
    }
    return null;
  }

  function pointOnSegment(point, a, b) {
    const x = point[0];
    const y = point[1];
    const x1 = a[0];
    const y1 = a[1];
    const x2 = b[0];
    const y2 = b[1];
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    if (Math.abs(cross) > EPS) return false;
    const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
    if (dot < -EPS) return false;
    const lenSq = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    return dot <= lenSq + EPS;
  }

  function pointInRing(point, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      if (pointOnSegment(point, a, b)) return true;
      const yi = finiteNumber(a[1], NaN);
      const yj = finiteNumber(b[1], NaN);
      const xi = finiteNumber(a[0], NaN);
      const xj = finiteNumber(b[0], NaN);
      if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
      const intersects = ((yi > point[1]) !== (yj > point[1]))
        && (point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function pointInPolygonCoordinates(point, coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
    if (!pointInRing(point, coordinates[0])) return false;
    for (let i = 1; i < coordinates.length; i += 1) {
      if (pointInRing(point, coordinates[i])) return false;
    }
    return true;
  }

  function pointInGeometry(point, geometry) {
    if (!geometry) return false;
    if (geometry.type === "Polygon") {
      return pointInPolygonCoordinates(point, geometry.coordinates);
    }
    if (geometry.type === "MultiPolygon") {
      return (geometry.coordinates || []).some((polygon) => pointInPolygonCoordinates(point, polygon));
    }
    return false;
  }

  function pointInRegion(point, region) {
    const geometry = asGeometry(region);
    if (geometry) return pointInGeometry(point, geometry);

    const bbox = normalizeBbox(region);
    return Boolean(bbox)
      && point[0] >= bbox[0] - EPS
      && point[0] <= bbox[2] + EPS
      && point[1] >= bbox[1] - EPS
      && point[1] <= bbox[3] + EPS;
  }

  function geometryBbox(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return null;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const visit = (node) => {
      if (!Array.isArray(node)) return;
      if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
        if (node[0] < minLng) minLng = node[0];
        if (node[0] > maxLng) maxLng = node[0];
        if (node[1] < minLat) minLat = node[1];
        if (node[1] > maxLat) maxLat = node[1];
        return;
      }
      node.forEach(visit);
    };
    visit(geometry.coordinates);
    if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
    return [minLng, minLat, maxLng, maxLat];
  }

  function bboxesIntersect(a, b) {
    return Boolean(a) && Boolean(b)
      && a[0] <= b[2] + EPS && b[0] <= a[2] + EPS
      && a[1] <= b[3] + EPS && b[1] <= a[3] + EPS;
  }

  function pointInBbox(point, bbox) {
    return Boolean(bbox)
      && point[0] >= bbox[0] - EPS && point[0] <= bbox[2] + EPS
      && point[1] >= bbox[1] - EPS && point[1] <= bbox[3] + EPS;
  }

  function firstRingVertexMean(geometry) {
    const ring = geometry.type === "Polygon"
      ? geometry.coordinates && geometry.coordinates[0]
      : geometry.coordinates && geometry.coordinates[0] && geometry.coordinates[0][0];
    if (!Array.isArray(ring) || !ring.length) return null;
    let sumLng = 0;
    let sumLat = 0;
    let count = 0;
    ring.forEach((vertex) => {
      const lng = finiteNumber(vertex && vertex[0], NaN);
      const lat = finiteNumber(vertex && vertex[1], NaN);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        sumLng += lng;
        sumLat += lat;
        count += 1;
      }
    });
    return count ? [sumLng / count, sumLat / count] : null;
  }

  function sampleGrid(geometry, bbox, resolution) {
    const points = [];
    const stepLng = (bbox[2] - bbox[0]) / resolution;
    const stepLat = (bbox[3] - bbox[1]) / resolution;
    for (let i = 0; i < resolution; i += 1) {
      for (let j = 0; j < resolution; j += 1) {
        const point = [bbox[0] + (i + 0.5) * stepLng, bbox[1] + (j + 0.5) * stepLat];
        if (pointInGeometry(point, geometry)) points.push(point);
      }
    }
    return points;
  }

  const MIN_SAMPLE_POINTS = 10;

  function buildSamplePoints(geometry, options = {}) {
    const normalized = asGeometry(geometry) || geometry;
    const bbox = geometryBbox(normalized);
    if (!normalized || !bbox) return [];
    if (bbox[2] - bbox[0] < EPS || bbox[3] - bbox[1] < EPS) {
      return [[(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]];
    }
    const baseResolution = Math.max(4, Math.round(Math.sqrt(finiteNumber(options.target, 256))));
    let points = sampleGrid(normalized, bbox, baseResolution);
    if (points.length < MIN_SAMPLE_POINTS) {
      points = sampleGrid(normalized, bbox, baseResolution * 2);
    }
    if (!points.length) {
      const fallbacks = [
        readCentroid(options.fallback ? { centroid: options.fallback } : null),
        firstRingVertexMean(normalized),
        [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      ].filter(Boolean);
      const inside = fallbacks.find((point) => pointInGeometry(point, normalized));
      points = [inside || fallbacks[fallbacks.length - 1]];
    }
    return points;
  }

  const sampleCache = new WeakMap();

  function getSamplePointsFor(geometry, options) {
    if (!isObject(geometry)) return [];
    if (sampleCache.has(geometry)) return sampleCache.get(geometry);
    const points = buildSamplePoints(geometry, options);
    sampleCache.set(geometry, points);
    return points;
  }

  function readGeometry(item) {
    if (!item) return null;
    if (item.feature && item.feature.geometry) return asGeometry(item.feature.geometry);
    if (item.geometry) return asGeometry(item.geometry);
    if (item.type === "Polygon" || item.type === "MultiPolygon") return item;
    return null;
  }

  const sampleIndexCache = new WeakMap();

  function buildSampleIndex(subbasinsGeojson) {
    if (!isObject(subbasinsGeojson)) return new Map();
    if (sampleIndexCache.has(subbasinsGeojson)) return sampleIndexCache.get(subbasinsGeojson);
    const index = new Map();
    getSubbasinItems(subbasinsGeojson).forEach((item, i) => {
      const id = readId(item, i);
      const geometry = readGeometry(item);
      if (!id || !geometry || index.has(id)) return;
      index.set(id, {
        points: getSamplePointsFor(geometry, { fallback: readCentroid(item) }),
        bbox: geometryBbox(geometry),
      });
    });
    sampleIndexCache.set(subbasinsGeojson, index);
    return index;
  }

  function regionToGeometry(region) {
    if (!region) return null;
    if (region.type === "ids") return null;
    const geometry = asGeometry(region);
    if (geometry) return geometry;
    const bbox = normalizeBbox(region);
    if (!bbox) return null;
    return {
      type: "Polygon",
      coordinates: [[
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]],
        [bbox[0], bbox[1]],
      ]],
    };
  }

  function coverageFraction(sample, regionGeometry, regionBbox) {
    if (!sample || !Array.isArray(sample.points) || !sample.points.length || !regionGeometry) return 0;
    const bbox = regionBbox || geometryBbox(regionGeometry);
    if (sample.bbox && bbox && !bboxesIntersect(sample.bbox, bbox)) return 0;
    let inside = 0;
    sample.points.forEach((point) => {
      if (bbox && !pointInBbox(point, bbox)) return;
      if (pointInGeometry(point, regionGeometry)) inside += 1;
    });
    return inside / sample.points.length;
  }

  const DEFAULT_COVERAGE_THRESHOLD = 0.3;

  function normalizeThreshold(value) {
    const n = finiteNumber(value, NaN);
    if (!Number.isFinite(n)) return DEFAULT_COVERAGE_THRESHOLD;
    return Math.min(1, Math.max(0, n));
  }

  function selectByCoverage(region, subbasinsGeojson, options = {}) {
    const regionGeometry = regionToGeometry(region);
    if (!regionGeometry) return [];
    const threshold = normalizeThreshold(options.threshold);
    const index = options.sampleIndex instanceof Map ? options.sampleIndex : buildSampleIndex(subbasinsGeojson);
    const regionBbox = geometryBbox(regionGeometry);
    const selected = [];
    index.forEach((sample, id) => {
      if (coverageFraction(sample, regionGeometry, regionBbox) >= threshold - EPS) selected.push(id);
    });
    return selected;
  }

  function selectSubbasins(region, subbasins, options = {}) {
    const items = getSubbasinItems(subbasins);
    if (!region || !items.length) return [];

    if (region.type === "ids" && Array.isArray(region.ids)) {
      const wanted = new Set(region.ids.map(cleanId).filter(Boolean));
      const selected = [];
      items.forEach((item, index) => {
        const id = readId(item, index);
        if (id && wanted.has(id)) {
          wanted.delete(id);
          selected.push(id);
        }
      });
      return selected;
    }

    const regionGeometry = regionToGeometry(region);
    const threshold = normalizeThreshold(options && options.threshold);
    const sampleIndex = options && options.sampleIndex instanceof Map ? options.sampleIndex : null;
    const regionBbox = regionGeometry ? geometryBbox(regionGeometry) : null;

    const selected = [];
    const seen = new Set();
    items.forEach((item, index) => {
      const id = readId(item, index);
      if (!id || seen.has(id)) return;

      const geometry = regionGeometry ? readGeometry(item) : null;
      if (geometry) {
        const sample = (sampleIndex && sampleIndex.get(id)) || {
          points: getSamplePointsFor(geometry, { fallback: readCentroid(item) }),
          bbox: geometryBbox(geometry),
        };
        if (coverageFraction(sample, regionGeometry, regionBbox) >= threshold - EPS) {
          seen.add(id);
          selected.push(id);
        }
        return;
      }

      const centroid = readCentroid(item);
      if (!centroid) return;
      if (pointInRegion(centroid, region)) {
        seen.add(id);
        selected.push(id);
      }
    });
    return selected;
  }

  function cloneSubbasin(item) {
    const clone = { ...item };
    if (isObject(item.demand)) clone.demand = { ...item.demand };
    if (isObject(item.supply)) clone.supply = { ...item.supply };
    if (isObject(item.healthWeight)) clone.healthWeight = { ...item.healthWeight };
    if (isObject(item.sectorValue)) clone.sectorValue = { ...item.sectorValue };
    if (isObject(item.complianceCost)) clone.complianceCost = { ...item.complianceCost };
    if (Array.isArray(item.centroid)) clone.centroid = item.centroid.slice();
    if (Array.isArray(item.adminCities)) clone.adminCities = item.adminCities.slice();
    if (Array.isArray(item.downstreamReach)) clone.downstreamReach = item.downstreamReach.slice();
    return clone;
  }

  function computeDownstreamReach(id, topology) {
    const reach = [];
    const seen = new Set([id]);
    let current = topology[id];
    while (current && current !== OUTLET) {
      if (seen.has(current)) {
        throw new Error("Cycle detected in selected subnetwork at " + current);
      }
      reach.push(current);
      seen.add(current);
      current = topology[current];
    }
    reach.push(OUTLET);
    return reach;
  }

  function assertTopologyReachesOutlet(topology) {
    Object.keys(topology).forEach((id) => {
      computeDownstreamReach(id, topology);
    });
  }

  function buildUpstreamIndex(topology) {
    const index = {};
    Object.entries(isObject(topology) ? topology : {}).forEach(([id, downstream]) => {
      const from = cleanId(id);
      const to = cleanId(downstream);
      if (!from || !to || to === OUTLET) return;
      if (!index[to]) index[to] = [];
      index[to].push(from);
    });
    return index;
  }

  function cleanSeedIds(seedIds) {
    return (Array.isArray(seedIds) ? seedIds : [seedIds]).map(cleanId).filter(Boolean);
  }

  function expandUpstream(seedIds, topology) {
    const upstream = buildUpstreamIndex(topology);
    const result = new Set(cleanSeedIds(seedIds));
    const queue = [...result];
    while (queue.length) {
      const id = queue.pop();
      (upstream[id] || []).forEach((up) => {
        if (!result.has(up)) {
          result.add(up);
          queue.push(up);
        }
      });
    }
    return [...result];
  }

  function expandDownstream(seedIds, topology) {
    const map = isObject(topology) ? topology : {};
    const result = new Set(cleanSeedIds(seedIds));
    [...result].forEach((id) => {
      if (!own(map, id)) return;
      computeDownstreamReach(id, topology).forEach((downstream) => {
        if (downstream !== OUTLET) result.add(downstream);
      });
    });
    return [...result];
  }

  function selectByCity(city, source) {
    const target = cleanId(city);
    if (!target) return [];
    const items = getSubbasinItems(source);
    const selected = [];
    const seen = new Set();
    items.forEach((item, index) => {
      const props = item && item.properties ? item.properties : {};
      const cities = Array.isArray(item && item.adminCities)
        ? item.adminCities
        : (Array.isArray(props.adminCities) ? props.adminCities : []);
      if (!cities.some((value) => cleanId(value) === target)) return;
      const id = readId(item, index);
      if (id && !seen.has(id)) {
        seen.add(id);
        selected.push(id);
      }
    });
    return selected;
  }

  function extractMeta(source) {
    return {
      ...(isObject(source && source.meta) ? source.meta : {}),
      ...(isObject(source && source.attrs && source.attrs.meta) ? source.attrs.meta : {}),
    };
  }

  function extractSubNetwork(selectedIds, attrsOrNetwork, options = {}) {
    const tradeScope = normalizeTradeScope(options.tradeScope);
    const tradeScopeLabel = getTradeScopeLabel(tradeScope);
    const allowBoundaryInflow = tradeScope !== "internal";
    const requestedIds = Array.isArray(selectedIds)
      ? selectedIds.map(cleanId).filter(Boolean)
      : [];
    const selectedSet = new Set(requestedIds);
    const items = getSubbasinItems(attrsOrNetwork);
    const topologyFull = getTopology(attrsOrNetwork, items);
    const byId = new Map();

    items.forEach((item, index) => {
      const id = readId(item, index);
      if (id && !byId.has(id)) byId.set(id, item);
    });

    const selectedItems = requestedIds
      .filter((id, index) => selectedSet.has(id) && requestedIds.indexOf(id) === index)
      .map((id) => byId.get(id))
      .filter(Boolean);
    const selectedKnownIds = new Set(selectedItems.map((item) => readId(item)));
    const missingSelectedIds = requestedIds.filter((id) => !byId.has(id));
    const boundaryInflowById = Object.fromEntries([...selectedKnownIds].map((id) => [id, 0]));
    const boundaryLinks = [];

    for (const [id, item] of byId.entries()) {
      if (selectedKnownIds.has(id)) continue;
      const downstream = readDownstream(item, topologyFull);
      if (downstream && selectedKnownIds.has(downstream)) {
        const boundary = readBoundaryOutflow(item);
        if (allowBoundaryInflow) {
          boundaryInflowById[downstream] += boundary.volume;
          boundaryLinks.push({
            from: id,
            to: downstream,
            volume: boundary.volume,
            source: boundary.source,
          });
        }
      }
    }

    const topology = {};
    const internalEdges = [];
    const outletEdges = [];
    const subbasins = selectedItems.map((item) => {
      const id = readId(item);
      const downstreamFull = readDownstream(item, topologyFull);
      const downstream = downstreamFull && selectedKnownIds.has(downstreamFull) ? downstreamFull : OUTLET;
      topology[id] = downstream;
      if (downstream === OUTLET) {
        outletEdges.push({ from: id, to: OUTLET, originalTo: downstreamFull || null });
      } else {
        internalEdges.push({ from: id, to: downstream });
      }

      const node = cloneSubbasin(item);
      const supply = getSupply(item);
      const qLocal = readLocalSupply(item);
      const baseExternal = readExistingExternalInflow(item);
      const boundaryExternal = allowBoundaryInflow ? nonNegative(boundaryInflowById[id], 0) : 0;
      const externalInflow = baseExternal + boundaryExternal;

      node.id = id;
      node.downstream = downstream;
      node.supply = {
        ...supply,
        qLocal,
        qAvail: qLocal + externalInflow,
        externalInflow,
        boundaryExternalInflow: boundaryExternal,
        boundaryInflow: boundaryExternal,
      };
      if (supply.mainstemInflow !== undefined) {
        node.supply.mainstemInflow = nonNegative(supply.mainstemInflow, 0);
      }
      return node;
    });

    assertTopologyReachesOutlet(topology);
    subbasins.forEach((node) => {
      node.downstreamReach = computeDownstreamReach(node.id, topology);
    });

    return {
      subbasins,
      topology,
      scope: {
        tradeScope,
        tradeScopeLabel,
        selectedIds: [...selectedKnownIds],
      },
      meta: {
        ...extractMeta(attrsOrNetwork),
        selectedCount: subbasins.length,
        sourceCount: byId.size,
        missingSelectedIds,
        boundaryInflowById,
        boundaryLinks,
        tradeScope,
        tradeScopeLabel,
        boundaryInflowEnabled: allowBoundaryInflow,
        scope: {
          tradeScope,
          tradeScopeLabel,
        },
        internalEdges,
        outletEdges,
        generatedBy: "ResearchRegionSelect.extractSubNetwork",
      },
    };
  }

  return {
    selectSubbasins,
    extractSubNetwork,
    geometryBbox,
    buildSamplePoints,
    buildSampleIndex,
    regionToGeometry,
    coverageFraction,
    selectByCoverage,
    buildUpstreamIndex,
    expandUpstream,
    expandDownstream,
    selectByCity,
    _internals: {
      pointInRegion,
      normalizeBbox,
      pointInGeometry,
      readBoundaryOutflow,
    },
  };
});
