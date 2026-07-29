(function () {
  'use strict';

  const PALETTES = {
    healthGain: ['#e9f7ef', '#9bd7a8', '#2f9e44'],
    stressIndex: ['#fff4d6', '#f08c00', '#d9480f'],
    taxIntensity: ['#e6f4f1', '#1f7a8c', '#155e70'],
    inequity: ['#f0ebff', '#8d7be0', '#5f3dc4'],
    netTrade: ['#1f7a8c', '#adb5bd', '#2f9e44'],
  };

  const LAYER_META = {
    healthGain: { label: '健康收益', field: 'dalyAvoided' },
    stressIndex: { label: '水压力', field: 'stressIndex' },
    taxIntensity: { label: '税强度', field: 'taxIntensity' },
    inequity: { label: '不公平', field: 'inequity' },
    netTrade: { label: '交易净额', field: 'netTrade' },
  };
  const TILE_FALLBACK_URL = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22256%22 height=%22256%22 viewBox=%220 0 256 256%22%3E%3Crect width=%22256%22 height=%22256%22 fill=%22%23d7eceb%22/%3E%3Cpath d=%22M0 176 C50 156 94 196 146 176 S224 154 256 168%22 fill=%22none%22 stroke=%22%2380b7bd%22 stroke-width=%223%22 opacity=%220.5%22/%3E%3C/svg%3E';
  const FLOW_ANIMATION_LIMIT = 70;
  const FLOW_PARTICLE_LIMIT = 24;
  const FLOW_CHANGE_EPS = 0.001;
  const FLOW_AOI_BBOX = [112.5, 29.0, 116.0, 31.5];

  let leafletMap = null;
  let basinLayer = null;
  let riverLayer = null;
  let flowLayer = null;
  let legend = null;
  let regionRectLayer = null;
  let fittedBoundsKey = null;
  let fittedViewportKey = null;
  let userAdjustedView = false;
  let programmaticViewChange = false;
  let mapResizeObserver = null;
  let onSelectBasin = null;
  let onRegionChange = null;
  let onClearRegion = null;
  let latestPayload = null;
  let selectedRegion = null;
  let internalSelectedIds = new Set();
  let drawMode = false; // false | 'rect' | 'lasso'
  let drawCapture = null;
  let drawBox = null;
  let drawLassoSvg = null;
  let drawLassoPath = null;
  let drawing = null;
  let regionDrawButton = null;
  let regionLassoButton = null;
  let clearRegionButton = null;
  let expandUpstreamButton = null;
  let expandDownstreamButton = null;
  let citySelectControl = null;
  let thresholdSelectControl = null;
  let previewIds = new Set();
  let previewFrame = null;
  let localActiveLayer = null;
  let previousFlowVolumes = new Map();
  let changedFlowKeys = new Set();
  let clearChangedFlowTimer = null;

  function init(options) {
    const callbacks = normalizeInitOptions(options);
    onSelectBasin = callbacks.onSelectBasin;
    onRegionChange = callbacks.onRegionChange;
    onClearRegion = callbacks.onClearRegion;

    const mapElement = document.getElementById('map');
    if (!mapElement) return;

    if (window.L && typeof window.L.map === 'function') {
      leafletMap = window.L.map(mapElement, {
        center: [30.45, 114.35],
        zoom: 8,
        minZoom: 6,
        maxZoom: 12,
        zoomControl: true,
      });

      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 18,
        opacity: 0.48,
        errorTileUrl: TILE_FALLBACK_URL,
      }).addTo(leafletMap);

      mapElement.classList.add('leaflet-map-active');
      addLegend();
      watchMapViewport(mapElement);
    }

    ensureDrawOverlay(mapElement);
    bindRegionControls();
    ensureNetTradeLayerControl();
    syncRegionControls();
  }

  // 容器尺寸在首帧往往尚未稳定。若此刻 fitBounds，缩放会按错误的容器
  // 尺寸算出来，并被 fittedBoundsKey 永久锁定（实测 AOI 只占画面 2%）。
  // 这里监听尺寸变化让 Leaflet 重新量容器，并在用户尚未手动操作地图时
  // 重新取景；一旦用户自己平移或缩放过，就不再自动改动视野。
  function watchMapViewport(mapElement) {
    if (!leafletMap) return;

    leafletMap.on('zoomstart movestart', () => {
      if (!programmaticViewChange) userAdjustedView = true;
    });

    const handleResize = () => {
      if (!leafletMap) return;
      leafletMap.invalidateSize({ animate: false });
      refitBoundsIfNeeded();
    };

    if (typeof ResizeObserver === 'function') {
      mapResizeObserver = new ResizeObserver(handleResize);
      mapResizeObserver.observe(mapElement);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', handleResize);
    }
  }

  // 20px 粒度：忽略滚动条等微小抖动，只在容器真正变形时才重新取景
  function getViewportKey() {
    if (!leafletMap) return null;
    const size = leafletMap.getSize();
    return Math.round(size.x / 20) + 'x' + Math.round(size.y / 20);
  }

  function fitToBasins(bounds) {
    if (!leafletMap || !bounds || !bounds.isValid()) return;
    programmaticViewChange = true;
    leafletMap.invalidateSize({ animate: false });
    leafletMap.fitBounds(bounds.pad(0.12), { maxZoom: 9, animate: false });
    programmaticViewChange = false;
    fittedViewportKey = getViewportKey();
  }

  function refitBoundsIfNeeded() {
    if (userAdjustedView || !basinLayer) return;
    if (getViewportKey() === fittedViewportKey) return;
    fitToBasins(basinLayer.getBounds && basinLayer.getBounds());
  }

  function update(payload) {
    latestPayload = payload;
    if (!payload || !payload.network || !payload.result) return;
    refreshChangedFlowKeys(payload);

    if (leafletMap) {
      renderLeaflet(payload);
      return;
    }

    renderSvgFallback(payload);
  }

  function renderLeaflet(payload) {
    const L = window.L;
    const { network, result } = payload;
    const activeLayer = getActiveLayer(payload.activeLayer);
    const resultById = new Map(result.basinResults.map((item) => [item.id, item]));
    const selectionState = getSelectionState(payload);
    const mapContext = createMapContext(result, selectionState);

    if (basinLayer) basinLayer.remove();
    if (riverLayer) riverLayer.remove();
    if (flowLayer) flowLayer.remove();
    previewIds = new Set();

    riverLayer = L.geoJSON(network.riversGeojson, {
      style: {
        color: '#1f7a8c',
        weight: 3,
        opacity: 0.72,
      },
      interactive: false,
    }).addTo(leafletMap);

    basinLayer = L.geoJSON(network.subbasinsGeojson, {
      style: (feature) => styleFeature(feature, resultById, activeLayer, payload.selectedId, selectionState, mapContext),
      onEachFeature: (feature, layer) => {
        const id = String((feature.properties && feature.properties.id) || '');
        layer.on('click', () => {
          if (typeof onSelectBasin === 'function') onSelectBasin(id);
        });
        layer.bindPopup(() => renderPopup(resultById.get(id), mapContext));
      },
    }).addTo(leafletMap);
    openSelectedPopup(payload.selectedId);

    flowLayer = L.layerGroup();
    renderFlowLines(flowLayer, network, result, selectionState);
    flowLayer.addTo(leafletMap);
    updateLeafletRegionShape(selectionState.region);

    const bounds = basinLayer.getBounds && basinLayer.getBounds();
    const boundsKey = getNetworkBoundsKey(network);
    const networkChanged = boundsKey !== fittedBoundsKey;
    // 网络变了必须重新取景；网络没变但容器尺寸变过（首帧布局未稳定、
    // 窗口缩放）也要补一次，除非用户已经自己动过地图
    const viewportChanged = !userAdjustedView && getViewportKey() !== fittedViewportKey;
    if (bounds && bounds.isValid() && (networkChanged || viewportChanged)) {
      if (networkChanged) userAdjustedView = false;
      fitToBasins(bounds);
      fittedBoundsKey = boundsKey;
    }
    updateLegend(activeLayer);
    updateSelectionSummary(selectionState, payload);
    syncRegionControls();
  }

  function renderFlowLines(layerGroup, network, result, selectionState) {
    const L = window.L;
    const flowEntries = getRenderableFlowEntries(network, result, selectionState);
    const visibleFlows = flowEntries.map((entry) => entry.flow);
    const maxVolume = Math.max(...visibleFlows.map((flow) => flow.volume || 0), 1);
    const topAnimatedKeys = topFlowKeys(visibleFlows, FLOW_ANIMATION_LIMIT);
    const topParticleKeys = topFlowKeys(visibleFlows, FLOW_PARTICLE_LIMIT);

    flowEntries.forEach(({ flow, from, to, fromCentroid, toCentroid }) => {
      const key = flowKey(flow);
      const focus = getFlowFocus(flow, selectionState);
      const changed = changedFlowKeys.has(key);
      const animated = topAnimatedKeys.has(key);
      const latLngs = [
        [fromCentroid[1], fromCentroid[0]],
        [toCentroid[1], toCentroid[0]],
      ];
      const width = 1.6 + (flow.volume / maxVolume) * 5.6 + (focus.highlight ? 1.6 : 0) + (changed ? 1.2 : 0);
      const polyline = L.polyline(latLngs, {
        color: focus.highlight ? '#0b7285' : '#1f7a8c',
        weight: width,
        opacity: focus.dimmed ? 0.15 : focus.highlight ? 0.96 : 0.78,
        dashArray: animated ? '10 12' : null,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true,
        className: flowClassName('trade-flow-line', focus, changed, animated),
      }).addTo(layerGroup);
      polyline.bindTooltip(flowTooltip(flow, from, to), {
        sticky: true,
        direction: 'top',
        className: 'trade-flow-tooltip',
        opacity: 0.97,
      });

      const angle = bearingDegrees(fromCentroid, toCentroid);
      const midpoint = midpointLatLng(fromCentroid, toCentroid);
      L.marker(midpoint, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: flowClassName('trade-flow-arrow-icon', focus, changed, animated),
          html: `<span class="trade-flow-arrow" style="--flow-angle:${angle.toFixed(1)}deg"></span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      }).addTo(layerGroup);

      if (topParticleKeys.has(key)) {
        L.marker(midpoint, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: flowClassName('trade-flow-particle-icon', focus, changed, animated),
            html: `<span class="trade-flow-particle-rail" style="--flow-angle:${angle.toFixed(1)}deg"><i></i></span>`,
            iconSize: [58, 18],
            iconAnchor: [29, 9],
          }),
        }).addTo(layerGroup);
      }
    });
  }

  function openSelectedPopup(selectedId) {
    if (!basinLayer || !selectedId) return;
    basinLayer.eachLayer((layer) => {
      const id = String((layer.feature && layer.feature.properties && layer.feature.properties.id) || '');
      if (id === String(selectedId) && typeof layer.openPopup === 'function') {
        layer.openPopup();
      }
    });
  }

  function styleFeature(feature, resultById, activeLayer, selectedId, selectionState, mapContext) {
    const id = String((feature.properties && feature.properties.id) || '');
    const item = resultById.get(id);
    const regionSelected = selectionState.ids.has(id);
    const downstreamHighlighted = selectionState.downstreamIds.has(id);
    const tradePartner = selectionState.tradePartnerIds && selectionState.tradePartnerIds.has(id);
    const tradeDimmed = selectionState.selectedId && id !== selectionState.selectedId && !tradePartner && !downstreamHighlighted;
    const selected = regionSelected || (selectionState.selectedId && selectionState.selectedId === id);
    const dimmed = tradeDimmed || (selectionState.hasSelection && !regionSelected && selectionState.selectedId !== id && !downstreamHighlighted && !tradePartner);
    const net = readNetTrade(item, mapContext && mapContext.tradeAggregate);
    const tradeRole = net < FLOW_CHANGE_EPS * -1 ? ' trade-seller' : net > FLOW_CHANGE_EPS ? ' trade-buyer' : ' trade-neutral';
    const classNames = [
      downstreamHighlighted ? 'downstream-highlight' : '',
      selected ? 'basin-selected' : '',
      tradePartner ? 'trade-partner' : '',
      tradeDimmed ? 'trade-dimmed' : '',
      tradeRole.trim(),
    ].filter(Boolean).join(' ');
    return {
      color: selected ? '#17212b' : downstreamHighlighted ? '#d9480f' : tradePartner ? '#1c6dd0' : '#ffffff',
      weight: selected ? 3.4 : downstreamHighlighted ? 3 : tradePartner ? 2.8 : 1.5,
      fillColor: item ? colorFor(activeLayer, item, mapContext) : '#d9e1df',
      fillOpacity: dimmed ? 0.22 : selected ? 0.94 : downstreamHighlighted || tradePartner ? 0.88 : 0.78,
      opacity: 1,
      dashArray: downstreamHighlighted && !selected ? '4 4' : tradePartner && !selected ? '5 4' : null,
      className: classNames,
    };
  }

  function renderSvgFallback(payload) {
    const container = document.getElementById('svg-fallback');
    if (!container) return;

    const { network, result, selectedId } = payload;
    const activeLayer = getActiveLayer(payload.activeLayer);
    const resultById = new Map(result.basinResults.map((item) => [item.id, item]));
    const selectionState = getSelectionState(payload);
    const mapContext = createMapContext(result, selectionState);
    const bbox = getBoundingBox(network.subbasinsGeojson);
    const width = 1000;
    const height = 680;
    const pad = 34;
    const project = (point) => {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      const x = pad + ((point[0] - minLng) / Math.max(maxLng - minLng, 0.0001)) * (width - pad * 2);
      const y = height - pad - ((point[1] - minLat) / Math.max(maxLat - minLat, 0.0001)) * (height - pad * 2);
      return [x, y];
    };

    const riverPaths = (network.riversGeojson.features || [])
      .map((feature) => geometryToPath(feature.geometry, project))
      .filter(Boolean)
      .map((path) => `<path class="fallback-river" d="${path}"></path>`)
      .join('');

    const basinPaths = (network.subbasinsGeojson.features || [])
      .map((feature) => {
        const id = String((feature.properties && feature.properties.id) || '');
        const item = resultById.get(id);
        const regionSelected = selectionState.ids.has(id);
        const downstreamHighlighted = selectionState.downstreamIds.has(id);
        const tradePartner = selectionState.tradePartnerIds && selectionState.tradePartnerIds.has(id);
        const tradeDimmed = selectionState.selectedId && id !== selectionState.selectedId && !tradePartner && !downstreamHighlighted;
        const selected = (regionSelected || selectedId === id) ? ' selected' : '';
        const downstream = downstreamHighlighted ? ' downstream-highlight' : '';
        const partner = tradePartner ? ' trade-partner' : '';
        const dimmed = (tradeDimmed || (selectionState.hasSelection && !regionSelected && selectedId !== id && !downstreamHighlighted && !tradePartner)) ? ' dimmed' : '';
        const fill = item ? colorFor(activeLayer, item, mapContext) : '#d9e1df';
        const path = geometryToPath(feature.geometry, project);
        if (!path) return '';
        const itemName = item ? displayNameForEntity(item, id) : id;
        const itemCode = item ? technicalCodeFor(item, id) : id;
        const title = itemCode && itemCode !== itemName ? `${itemName} (${itemCode})` : itemName;
        return `<path class="fallback-basin${selected}${downstream}${partner}${dimmed}" data-basin-id="${escapeHtml(id)}" fill="${fill}" d="${path}"><title>${escapeHtml(title)}</title></path>`;
      })
      .join('');

    const regionBox = buildSvgRegionBox(selectionState.region, project);
    const flowPaths = buildSvgFlows(network, result, project, selectionState);
    const labels = network.basins.map((basin) => {
      const point = project(basin.centroid);
      return `<text class="svg-label" x="${point[0].toFixed(1)}" y="${point[1].toFixed(1)}" text-anchor="middle">${escapeHtml(shortName(displayNameForEntity(basin, basin.id)))}</text>`;
    }).join('');

    container.innerHTML = `
      <svg class="fallback-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="SVG 子流域地图">
        <defs>
          <marker id="fallback-flow-arrow" class="fallback-flow-arrow-marker" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z"></path>
          </marker>
        </defs>
        <rect width="${width}" height="${height}" fill="#cfe3e4"></rect>
        ${riverPaths}
        ${flowPaths}
        ${basinPaths}
        ${regionBox}
        ${labels}
      </svg>
    `;

    container.querySelectorAll('[data-basin-id]').forEach((element) => {
      element.addEventListener('click', () => {
        if (typeof onSelectBasin === 'function') onSelectBasin(element.dataset.basinId);
      });
    });
    updateSelectionSummary(selectionState, payload);
    syncRegionControls();
  }

  function buildSvgFlows(network, result, project, selectionState) {
    const flowEntries = getRenderableFlowEntries(network, result, selectionState);
    const visibleFlows = flowEntries.map((entry) => entry.flow);
    const maxVolume = Math.max(...visibleFlows.map((flow) => flow.volume || 0), 1);
    const topAnimatedKeys = topFlowKeys(visibleFlows, FLOW_ANIMATION_LIMIT);
    const topParticleKeys = topFlowKeys(visibleFlows, FLOW_PARTICLE_LIMIT);
    const paths = flowEntries.map(({ flow, from, to, fromCentroid, toCentroid }) => {
      const key = flowKey(flow);
      const focus = getFlowFocus(flow, selectionState);
      const className = flowClassName('fallback-flow flow-direction-forward', focus, changedFlowKeys.has(key), topAnimatedKeys.has(key));
      const a = project(fromCentroid);
      const b = project(toCentroid);
      const width = 1.6 + (flow.volume / maxVolume) * 5.6 + (focus.highlight ? 1.6 : 0);
      const path = `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
      return `<path class="${className}" marker-end="url(#fallback-flow-arrow)" stroke-width="${width.toFixed(1)}" d="${path}"><title>${flowTooltip(flow, from, to)}</title></path>`;
    }).join('');
    const particles = flowEntries
      .filter(({ flow }) => topParticleKeys.has(flowKey(flow)))
      .map(({ flow, fromCentroid, toCentroid }, index) => {
        const a = project(fromCentroid);
        const b = project(toCentroid);
        const focus = getFlowFocus(flow, selectionState);
        const path = `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
        const className = flowClassName('fallback-flow-share', focus, changedFlowKeys.has(flowKey(flow)), true);
        return `<circle class="${className}" r="${focus.highlight ? 4.8 : 3.8}">
          <animateMotion dur="${(2.4 + (index % 5) * 0.18).toFixed(2)}s" repeatCount="indefinite" path="${path}"></animateMotion>
        </circle>`;
      }).join('');
    return `${paths}${particles}`;
  }

  function buildSvgRegionBox(region, project) {
    const normalized = normalizeRegion(region);
    if (!normalized || normalized.type === 'ids') return '';

    if (normalized.type === 'Polygon') {
      const path = ringToPath(normalized.coordinates[0] || [], project);
      if (!path) return '';
      return `<path class="fallback-selection-box" d="${path}"></path>`;
    }

    const a = project([normalized.sw[1], normalized.sw[0]]);
    const b = project([normalized.ne[1], normalized.ne[0]]);
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    const width = Math.abs(a[0] - b[0]);
    const height = Math.abs(a[1] - b[1]);
    return `<rect class="fallback-selection-box" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}"></rect>`;
  }

  function geometryToPath(geometry, project) {
    if (!geometry) return '';
    if (geometry.type === 'Polygon') {
      return geometry.coordinates.map((ring) => ringToPath(ring, project)).join(' ');
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => ringToPath(ring, project))).join(' ');
    }
    if (geometry.type === 'LineString') {
      return lineToPath(geometry.coordinates, project);
    }
    if (geometry.type === 'MultiLineString') {
      return geometry.coordinates.map((line) => lineToPath(line, project)).join(' ');
    }
    return '';
  }

  function ringToPath(ring, project) {
    return lineToPath(ring, project) + ' Z';
  }

  function lineToPath(points, project) {
    return points.map((point, index) => {
      const [x, y] = project(point);
      return `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }

  function getBoundingBox(geojson) {
    const coords = [];
    (geojson.features || []).forEach((feature) => collectCoordinates(feature.geometry && feature.geometry.coordinates, coords));
    if (!coords.length) return [112.5, 29.0, 116.1, 31.3];
    const lngs = coords.map((point) => point[0]);
    const lats = coords.map((point) => point[1]);
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }

  function getNetworkBoundsKey(network) {
    const basins = Array.isArray(network && network.basins) ? network.basins : [];
    const first = basins[0] && basins[0].id;
    const last = basins[basins.length - 1] && basins[basins.length - 1].id;
    const bbox = network && network.subbasinsGeojson ? getBoundingBox(network.subbasinsGeojson) : [];
    const bboxKey = bbox.map((value) => Number(value).toFixed(4)).join(',');
    return `${network && network.source || 'network'}:${basins.length}:${first || ''}:${last || ''}:${bboxKey}`;
  }

  function collectCoordinates(coords, out) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      out.push(coords);
      return;
    }
    coords.forEach((item) => collectCoordinates(item, out));
  }

  function normalizeInitOptions(options) {
    if (typeof options === 'function') {
      return { onSelectBasin: options, onRegionChange: null, onClearRegion: null };
    }
    const config = options && typeof options === 'object' ? options : {};
    return {
      onSelectBasin: typeof config.onSelectBasin === 'function' ? config.onSelectBasin : null,
      onRegionChange: typeof config.onRegionChange === 'function' ? config.onRegionChange : null,
      onClearRegion: typeof config.onClearRegion === 'function' ? config.onClearRegion : null,
    };
  }

  function ensureNetTradeLayerControl() {
    const tabs = document.querySelector('.layer-tabs');
    if (!tabs || tabs.querySelector('[data-layer="netTrade"]')) {
      bindLayerTabs(tabs);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer-tab';
    button.dataset.layer = 'netTrade';
    button.textContent = LAYER_META.netTrade.label;
    tabs.appendChild(button);
    bindLayerTabs(tabs);
  }

  function bindLayerTabs(tabs) {
    if (!tabs || tabs.dataset.netTradeBound) return;
    tabs.dataset.netTradeBound = 'true';
    tabs.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('.layer-tab') : null;
      if (!button || !tabs.contains(button)) return;
      localActiveLayer = button.dataset.layer || 'healthGain';
      tabs.querySelectorAll('.layer-tab').forEach((item) => {
        item.classList.toggle('active', item === button);
      });
      const label = document.getElementById('active-layer-label');
      if (label) label.textContent = (LAYER_META[localActiveLayer] && LAYER_META[localActiveLayer].label) || localActiveLayer;
      if (latestPayload) update({ ...latestPayload, activeLayer: localActiveLayer });
    });
  }

  function getActiveLayer(payloadLayer) {
    return localActiveLayer || payloadLayer || 'healthGain';
  }

  function createMapContext(result, selectionState) {
    const tradeAggregate = getTradeAggregate(result);
    return {
      tradeAggregate,
      netTradeMax: getNetTradeMax(result, selectionState, tradeAggregate),
    };
  }

  function getTradeAggregate(result) {
    const provided = result && (result.tradeAggregate || result.trade_aggregate);
    const perNodeNet = readNumberMap(provided && (provided.nodeDelta || provided.perNodeNet));
    const nodeDelta = readNumberMap(provided && (provided.nodeDelta || provided.node_delta));
    const partnersByNode = readPartnersMap(provided && provided.partnersByNode);
    return { perNodeNet, nodeDelta, partnersByNode };
  }

  function readNumberMap(source) {
    const map = new Map();
    if (!source) return map;
    if (source instanceof Map) {
      source.forEach((value, key) => {
        const number = Number(value);
        if (Number.isFinite(number)) map.set(String(key), number);
      });
      return map;
    }
    Object.entries(source).forEach(([key, value]) => {
      const number = Number(value);
      if (Number.isFinite(number)) map.set(String(key), number);
    });
    return map;
  }

  function readPartnersMap(source) {
    const map = new Map();
    if (!source) return map;
    const entries = source instanceof Map ? Array.from(source.entries()) : Object.entries(source);
    entries.forEach(([key, value]) => {
      const entry = ensurePartnerEntry(map, String(key));
      toArray(value && value.buyers).map(getPartnerId).filter(Boolean).forEach((id) => entry.buyers.add(id));
      toArray(value && value.sellers).map(getPartnerId).filter(Boolean).forEach((id) => entry.sellers.add(id));
    });
    return map;
  }

  function getPartnerId(item) {
    if (item === undefined || item === null || item === '') return '';
    if (typeof item === 'object') {
      const id = item.id ?? item.nodeId ?? item.subbasinId ?? item.code;
      return id === undefined || id === null ? '' : String(id);
    }
    return String(item);
  }

  function ensurePartnerEntry(map, id) {
    if (!map.has(id)) map.set(id, { buyers: new Set(), sellers: new Set() });
    return map.get(id);
  }

  function getNetTradeMax(result, selectionState, tradeAggregate) {
    const rows = Array.isArray(result && result.basinResults) ? result.basinResults : [];
    const values = rows
      .filter((item) => !selectionState || !selectionState.hasSelection || selectionState.ids.has(String(item.id)))
      .map((item) => Math.abs(readNetTrade(item, tradeAggregate)));
    return Math.max(...values, 0);
  }

  function readNetTrade(item, tradeAggregate) {
    if (!item) return 0;
    const explicit = Number(item.netTrade ?? item.tradeNet ?? item.net_trade);
    if (Number.isFinite(explicit)) return explicit;
    const explicitNodeDelta = Number(item.nodeDelta ?? item.node_delta);
    if (Number.isFinite(explicitNodeDelta)) return -explicitNodeDelta;
    const id = String(item.id || '');
    return tradeAggregate && tradeAggregate.perNodeNet ? Number(tradeAggregate.perNodeNet.get(id) || 0) : 0;
  }

  function topFlowKeys(flows, limit) {
    return new Set([...flows]
      .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
      .slice(0, Math.max(0, limit))
      .map(flowKey));
  }

  function flowKey(flow) {
    const from = String(flow.from ?? flow.origin ?? flow.source ?? '');
    const to = String(flow.to ?? flow.target ?? flow.destination ?? '');
    const sector = flow.sector ? `:${flow.sector}` : '';
    return `${from}->${to}${sector}`;
  }

  function refreshChangedFlowKeys(payload) {
    const explicit = extractChangedFlowKeys(payload);
    const current = new Map();
    getAllFlows(payload && payload.result).forEach((flow) => {
      current.set(flowKey(flow), Number(flow.volume) || 0);
    });

    const detected = new Set();
    if (previousFlowVolumes.size) {
      current.forEach((volume, key) => {
        const previous = previousFlowVolumes.get(key);
        if (previous === undefined || Math.abs(previous - volume) > Math.max(FLOW_CHANGE_EPS, Math.abs(previous) * 0.015)) {
          detected.add(key);
        }
      });
      previousFlowVolumes.forEach((volume, key) => {
        if (!current.has(key) && volume > FLOW_CHANGE_EPS) detected.add(key);
      });
    }
    previousFlowVolumes = current;
    changedFlowKeys = explicit.size ? explicit : detected;
    scheduleChangedFlowClear();
  }

  function extractChangedFlowKeys(payload) {
    const result = payload && payload.result;
    const meta = result && result.meta;
    return toIdSet(
      (payload && payload.changedFlowKeys)
      || (result && result.changedFlowKeys)
      || (meta && meta.changedFlowKeys)
      || []
    );
  }

  function scheduleChangedFlowClear() {
    window.clearTimeout(clearChangedFlowTimer);
    if (!changedFlowKeys.size) return;
    clearChangedFlowTimer = window.setTimeout(() => {
      changedFlowKeys = new Set();
      document.querySelectorAll('.flow-changed').forEach((element) => {
        element.classList.remove('flow-changed');
      });
    }, 1600);
  }

  function getFlowFocus(flow, selectionState) {
    const selectedId = selectionState && selectionState.selectedId;
    if (!selectedId) return { highlight: false, dimmed: false };
    const from = String(flow.from ?? flow.origin ?? flow.source ?? '');
    const to = String(flow.to ?? flow.target ?? flow.destination ?? '');
    const related = from === selectedId || to === selectedId;
    return { highlight: related, dimmed: !related };
  }

  function flowClassName(base, focus, changed, animated) {
    return [
      base,
      focus && focus.highlight ? 'flow-highlighted' : '',
      focus && focus.dimmed ? 'flow-dimmed' : '',
      changed ? 'flow-changed' : '',
      animated ? 'flow-animated' : 'flow-static',
    ].filter(Boolean).join(' ');
  }

  function midpointLatLng(fromCentroid, toCentroid) {
    return [
      (Number(fromCentroid[1]) + Number(toCentroid[1])) / 2,
      (Number(fromCentroid[0]) + Number(toCentroid[0])) / 2,
    ];
  }

  function bearingDegrees(fromCentroid, toCentroid) {
    const fromLng = Number(fromCentroid[0]);
    const fromLat = Number(fromCentroid[1]);
    const toLng = Number(toCentroid[0]);
    const toLat = Number(toCentroid[1]);
    if ([fromLng, fromLat, toLng, toLat].some((value) => !Number.isFinite(value))) return 0;
    const lat1 = fromLat * Math.PI / 180;
    const lat2 = toLat * Math.PI / 180;
    const lngDelta = (toLng - fromLng) * Math.PI / 180;
    const y = Math.sin(lngDelta) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lngDelta);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function flowTooltip(flow, from, to) {
    const fromLabel = endpointLabel(flow, from, 'from');
    const toLabel = endpointLabel(flow, to, 'to');
    const price = formatPrice(flow.averageUnitCost || flow.price || flow.marketPrice);
    const codeText = [fromLabel.code, toLabel.code].filter(Boolean).join(' → ');
    const codeSuffix = codeText ? ` / Pfaf ${escapeHtml(codeText)}` : '';
    return `${escapeHtml(fromLabel.name)} → ${escapeHtml(toLabel.name)}${codeSuffix} / ${escapeHtml(formatWater(flow.volume))} / ${escapeHtml(price)} / 基于‘有交易 − 自给自足’的市场再配估算`;
  }

  function endpointLabel(flow, basin, side) {
    const isFrom = side === 'from';
    const id = firstText(isFrom
      ? [flow && flow.from, flow && flow.origin, flow && flow.source, flow && flow.seller]
      : [flow && flow.to, flow && flow.target, flow && flow.destination, flow && flow.buyer]);
    const basinCode = technicalCodeFor(basin, id);
    const code = firstText(isFrom
      ? [flow && flow.fromCode, flow && flow.originCode, flow && flow.sourceCode, flow && flow.sellerCode, basinCode, id]
      : [flow && flow.toCode, flow && flow.targetCode, flow && flow.destinationCode, flow && flow.buyerCode, basinCode, id]);
    const name = chooseDisplayName(isFrom
      ? [flow && flow.fromName, flow && flow.originName, flow && flow.sourceName, flow && flow.sellerName, basin && basin.name, basin && basin.nameZh, basin && basin.label, id]
      : [flow && flow.toName, flow && flow.targetName, flow && flow.destinationName, flow && flow.buyerName, basin && basin.name, basin && basin.nameZh, basin && basin.label, id], code);
    return { name, code };
  }

  function bindRegionControls() {
    regionDrawButton = document.getElementById('region-draw-toggle')
      || document.querySelector('[data-map-action="draw-region"]');
    regionLassoButton = document.getElementById('region-lasso-toggle')
      || document.querySelector('[data-map-action="lasso-region"]');
    clearRegionButton = document.getElementById('region-clear')
      || document.querySelector('[data-map-action="clear-region"]');

    if (regionDrawButton && !regionDrawButton.dataset.regionToolBound) {
      regionDrawButton.dataset.regionToolBound = 'true';
      regionDrawButton.addEventListener('click', () => setDrawMode(drawMode === 'rect' ? false : 'rect'));
    }

    if (regionLassoButton && !regionLassoButton.dataset.regionToolBound) {
      regionLassoButton.dataset.regionToolBound = 'true';
      regionLassoButton.addEventListener('click', () => setDrawMode(drawMode === 'lasso' ? false : 'lasso'));
    }

    if (clearRegionButton && !clearRegionButton.dataset.regionToolBound) {
      clearRegionButton.dataset.regionToolBound = 'true';
      clearRegionButton.addEventListener('click', () => clearRegion({ notify: true }));
    }

    bindSmartSelectControls();
    bindRegionKeyboardShortcuts();
  }

  // 徒手绘制本身依赖指针拖拽；键盘用户的等价路径是「按城市选择」加
  // 「扩选上游/下游」（均为原生 button/select，可 Tab 到并回车触发）。
  // 这里补上 Escape：绘制态会禁用地图拖拽，此前只能用鼠标退出。
  function bindRegionKeyboardShortcuts() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.body.dataset.regionKeyboardBound) return;
    document.body.dataset.regionKeyboardBound = 'true';

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (drawing) {
        cancelActiveDraw();
        event.preventDefault();
        return;
      }
      if (drawMode) {
        const activeButton = drawMode === 'lasso' ? regionLassoButton : regionDrawButton;
        setDrawMode(false);
        if (activeButton && typeof activeButton.focus === 'function') activeButton.focus();
        event.preventDefault();
      }
    });
  }

  function bindSmartSelectControls() {
    expandUpstreamButton = document.getElementById('region-expand-upstream');
    expandDownstreamButton = document.getElementById('region-expand-downstream');
    citySelectControl = document.getElementById('region-city-select');
    thresholdSelectControl = document.getElementById('coverage-threshold');

    if (expandUpstreamButton && !expandUpstreamButton.dataset.regionToolBound) {
      expandUpstreamButton.dataset.regionToolBound = 'true';
      expandUpstreamButton.addEventListener('click', () => expandSelection('upstream'));
    }

    if (expandDownstreamButton && !expandDownstreamButton.dataset.regionToolBound) {
      expandDownstreamButton.dataset.regionToolBound = 'true';
      expandDownstreamButton.addEventListener('click', () => expandSelection('downstream'));
    }

    if (citySelectControl && !citySelectControl.dataset.regionToolBound) {
      citySelectControl.dataset.regionToolBound = 'true';
      citySelectControl.addEventListener('change', () => {
        const option = citySelectControl.options[citySelectControl.selectedIndex];
        const city = citySelectControl.value;
        const label = option ? option.textContent : city;
        citySelectControl.value = '';
        if (city) selectCityRegion(city, label);
      });
    }

    if (thresholdSelectControl && !thresholdSelectControl.dataset.regionToolBound) {
      thresholdSelectControl.dataset.regionToolBound = 'true';
      thresholdSelectControl.addEventListener('change', () => {
        // Re-evaluate the current drawn region with the new threshold.
        if (selectedRegion && selectedRegion.type !== 'ids') {
          internalSelectedIds = selectIdsInRegion(selectedRegion, latestPayload && latestPayload.network);
          if (latestPayload) update(latestPayload);
          notifyRegionChange(selectedRegion, internalSelectedIds);
        }
      });
    }
  }

  function getCoverageThreshold() {
    const value = thresholdSelectControl ? Number(thresholdSelectControl.value) : NaN;
    if (Number.isFinite(value) && value > 0 && value <= 1) return value;
    return 0.3;
  }

  function getSeedIds() {
    if (internalSelectedIds.size) return Array.from(internalSelectedIds);
    const scope = getPayloadScope(latestPayload);
    if (scope && scope.mode === 'region' && Array.isArray(scope.selectedIds) && scope.selectedIds.length) {
      return scope.selectedIds.map(String);
    }
    if (latestPayload && latestPayload.selectedId) return [String(latestPayload.selectedId)];
    return [];
  }

  function expandSelection(direction) {
    const api = window.ResearchRegionSelect;
    const network = latestPayload && latestPayload.network;
    if (!api || !network || !network.topology) return;
    const seeds = getSeedIds();
    if (!seeds.length) return;
    const expand = direction === 'upstream' ? api.expandUpstream : api.expandDownstream;
    if (typeof expand !== 'function') return;
    const ids = expand(seeds, network.topology);
    applyIdsRegion(ids, direction === 'upstream' ? '上游扩选' : '下游路径', direction);
  }

  function selectCityRegion(city, label) {
    const api = window.ResearchRegionSelect;
    const network = latestPayload && latestPayload.network;
    if (!api || typeof api.selectByCity !== 'function' || !network) return;
    const ids = api.selectByCity(city, network.basins || network.subbasinsGeojson);
    if (!ids.length) return;
    applyIdsRegion(ids, `城市扩选 · ${label}`, 'city');
  }

  function applyIdsRegion(ids, label, source) {
    const list = Array.from(new Set(toArray(ids).map(String)));
    if (!list.length) return;
    setDrawMode(false);
    selectedRegion = { type: 'ids', ids: list, source: source || null, label: label || null };
    internalSelectedIds = new Set(list);
    updateLeafletRegionShape(selectedRegion);
    if (latestPayload) update(latestPayload);
    else syncRegionControls();
    notifyRegionChange(selectedRegion, internalSelectedIds);
  }

  function ensureDrawOverlay(mapElement) {
    if (drawCapture || !mapElement) return;
    drawCapture = document.createElement('div');
    drawCapture.className = 'map-draw-capture';
    drawCapture.setAttribute('aria-hidden', 'true');

    drawBox = document.createElement('div');
    drawBox.className = 'map-draw-box';
    drawCapture.appendChild(drawBox);

    drawLassoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    drawLassoSvg.setAttribute('class', 'map-draw-lasso');
    drawLassoPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    drawLassoSvg.appendChild(drawLassoPath);
    drawCapture.appendChild(drawLassoSvg);

    mapElement.appendChild(drawCapture);

    drawCapture.addEventListener('pointerdown', handleDrawPointerDown);
    drawCapture.addEventListener('pointermove', handleDrawPointerMove);
    drawCapture.addEventListener('pointerup', handleDrawPointerUp);
    drawCapture.addEventListener('pointercancel', cancelActiveDraw);
  }

  function setDrawMode(mode) {
    drawMode = mode === true ? 'rect' : (mode === 'rect' || mode === 'lasso' ? mode : false);
    const active = Boolean(drawMode);
    const mapElement = document.getElementById('map');
    if (mapElement) mapElement.classList.toggle('region-draw-active', active);

    if (leafletMap && leafletMap.dragging) {
      if (active) leafletMap.dragging.disable();
      else leafletMap.dragging.enable();
    }
    if (leafletMap && leafletMap.doubleClickZoom) {
      if (active) leafletMap.doubleClickZoom.disable();
      else leafletMap.doubleClickZoom.enable();
    }

    cancelActiveDraw();
    syncRegionControls();
  }

  const LASSO_MIN_STEP_PX = 3;
  const LASSO_MAX_POINTS = 512;

  function handleDrawPointerDown(event) {
    if (!drawMode || !drawCapture) return;
    event.preventDefault();
    event.stopPropagation();

    const point = getLocalPoint(event);
    drawing = {
      mode: drawMode,
      pointerId: event.pointerId,
      startPoint: point,
      currentPoint: point,
      startLatLng: pointToLatLng(point),
      points: drawMode === 'lasso' ? [point] : null,
    };
    drawCapture.setPointerCapture(event.pointerId);
    drawCapture.classList.add('drawing');
    const mapElement = document.getElementById('map');
    if (mapElement) mapElement.classList.add('region-drawing');
    if (drawing.mode === 'lasso') updateLassoPath(drawing.points);
    else updateDrawBox(point, point);
  }

  function handleDrawPointerMove(event) {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = getLocalPoint(event);
    drawing.currentPoint = point;
    if (drawing.mode === 'lasso') {
      const last = drawing.points[drawing.points.length - 1];
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      if ((dx * dx + dy * dy) >= LASSO_MIN_STEP_PX * LASSO_MIN_STEP_PX
        && drawing.points.length < LASSO_MAX_POINTS) {
        drawing.points.push(point);
        updateLassoPath(drawing.points);
      }
    } else {
      updateDrawBox(drawing.startPoint, point);
    }
    schedulePreview();
  }

  function handleDrawPointerUp(event) {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    const finishedDraw = drawing;
    const endPoint = getLocalPoint(event);
    cancelActiveDraw();

    if (finishedDraw.mode === 'lasso') {
      const region = lassoRegionFromPoints(finishedDraw.points);
      if (!region) return;
      applyRegion(region, { notify: true });
      setDrawMode(false);
      return;
    }

    const width = Math.abs(endPoint.x - finishedDraw.startPoint.x);
    const height = Math.abs(endPoint.y - finishedDraw.startPoint.y);
    const endLatLng = pointToLatLng(endPoint);
    if (width < 8 || height < 8) return;

    const region = regionFromLatLngs(finishedDraw.startLatLng, endLatLng);
    applyRegion(region, { notify: true });
    setDrawMode(false);
  }

  function cancelActiveDraw() {
    if (drawing && drawCapture && drawCapture.hasPointerCapture(drawing.pointerId)) {
      drawCapture.releasePointerCapture(drawing.pointerId);
    }
    drawing = null;
    clearPreview();
    if (drawCapture) drawCapture.classList.remove('drawing');
    if (drawBox) drawBox.style.display = 'none';
    if (drawLassoPath) drawLassoPath.setAttribute('d', '');
    if (drawLassoSvg) drawLassoSvg.style.display = 'none';
    const mapElement = document.getElementById('map');
    if (mapElement) mapElement.classList.remove('region-drawing');
  }

  function updateLassoPath(points) {
    if (!drawLassoSvg || !drawLassoPath || !points || !points.length) return;
    drawLassoSvg.style.display = 'block';
    const path = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(' ');
    drawLassoPath.setAttribute('d', `${path} Z`);
  }

  function lassoRegionFromPoints(points) {
    if (!Array.isArray(points) || points.length < 3) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach((point) => {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    });
    if (maxX - minX < 8 || maxY - minY < 8) return null;

    const ring = points.map((point) => {
      const latLng = pointToLatLng(point);
      return [latLng.lng, latLng.lat];
    });
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    return { type: 'Polygon', coordinates: [ring] };
  }

  function buildDraftRegion() {
    if (!drawing) return null;
    if (drawing.mode === 'lasso') {
      return lassoRegionFromPoints(drawing.points);
    }
    return regionFromLatLngs(drawing.startLatLng, pointToLatLng(drawing.currentPoint));
  }

  function schedulePreview() {
    if (previewFrame) return;
    previewFrame = window.requestAnimationFrame(() => {
      previewFrame = null;
      renderPreview();
    });
  }

  function renderPreview() {
    if (!drawing || !basinLayer) return;
    const region = buildDraftRegion();
    const ids = region
      ? selectIdsInRegion(region, latestPayload && latestPayload.network)
      : new Set();
    applyPreviewStyles(ids);
  }

  const PREVIEW_STYLE = {
    color: '#0b7285',
    weight: 3.2,
    dashArray: '4 3',
    fillOpacity: 0.9,
  };

  function applyPreviewStyles(ids) {
    if (!basinLayer) {
      previewIds = ids;
      return;
    }
    basinLayer.eachLayer((layer) => {
      const id = String((layer.feature && layer.feature.properties && layer.feature.properties.id) || '');
      const inNew = ids.has(id);
      const inOld = previewIds.has(id);
      if (inNew && !inOld && typeof layer.setStyle === 'function') {
        layer.setStyle(PREVIEW_STYLE);
        if (typeof layer.bringToFront === 'function') layer.bringToFront();
      } else if (!inNew && inOld && typeof basinLayer.resetStyle === 'function') {
        basinLayer.resetStyle(layer);
      }
    });
    previewIds = ids;
  }

  function clearPreview() {
    if (previewFrame) {
      window.cancelAnimationFrame(previewFrame);
      previewFrame = null;
    }
    if (basinLayer && previewIds.size && typeof basinLayer.resetStyle === 'function') {
      basinLayer.eachLayer((layer) => {
        const id = String((layer.feature && layer.feature.properties && layer.feature.properties.id) || '');
        if (previewIds.has(id)) basinLayer.resetStyle(layer);
      });
    }
    previewIds = new Set();
  }

  function updateDrawBox(start, end) {
    if (!drawBox) return;
    drawBox.style.display = 'block';
    drawBox.style.left = `${Math.min(start.x, end.x)}px`;
    drawBox.style.top = `${Math.min(start.y, end.y)}px`;
    drawBox.style.width = `${Math.abs(end.x - start.x)}px`;
    drawBox.style.height = `${Math.abs(end.y - start.y)}px`;
  }

  function getLocalPoint(event) {
    const mapElement = document.getElementById('map');
    const rect = mapElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  }

  function pointToLatLng(point) {
    if (leafletMap && typeof leafletMap.containerPointToLatLng === 'function') {
      const latLng = leafletMap.containerPointToLatLng([point.x, point.y]);
      return { lat: latLng.lat, lng: latLng.lng };
    }

    const mapElement = document.getElementById('map');
    const rect = mapElement ? mapElement.getBoundingClientRect() : { width: 1, height: 1 };
    const bbox = latestPayload && latestPayload.network
      ? getBoundingBox(latestPayload.network.subbasinsGeojson)
      : [112.5, 29.0, 116.1, 31.3];
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const lng = minLng + (point.x / Math.max(rect.width, 1)) * (maxLng - minLng);
    const lat = maxLat - (point.y / Math.max(rect.height, 1)) * (maxLat - minLat);
    return { lat, lng };
  }

  function regionFromLatLngs(a, b) {
    const south = Math.min(a.lat, b.lat);
    const north = Math.max(a.lat, b.lat);
    const west = Math.min(a.lng, b.lng);
    const east = Math.max(a.lng, b.lng);
    return {
      type: 'bbox',
      sw: [south, west],
      ne: [north, east],
    };
  }

  function applyRegion(region, options = {}) {
    const normalized = normalizeRegion(region);
    if (!normalized) return;
    selectedRegion = normalized;
    internalSelectedIds = selectIdsInRegion(normalized, latestPayload && latestPayload.network);

    if (latestPayload) update(latestPayload);
    else {
      updateLeafletRegionShape(normalized);
      syncRegionControls();
      updateSelectionSummary({ hasSelection: true, ids: internalSelectedIds, region: normalized }, latestPayload);
    }

    if (options.notify) notifyRegionChange(normalized, internalSelectedIds);
  }

  function clearRegion(options = {}) {
    selectedRegion = null;
    internalSelectedIds = new Set();
    setDrawMode(false);
    updateLeafletRegionShape(null);

    if (latestPayload) update(latestPayload);
    else {
      updateSelectionSummary({ hasSelection: false, ids: new Set(), region: null }, latestPayload);
      syncRegionControls();
    }

    if (options.notify) notifyClearRegion();
  }

  function notifyRegionChange(region, ids) {
    const selectedIds = Array.from(ids);
    if (typeof onRegionChange === 'function') {
      onRegionChange(region, selectedIds, { region, selectedIds });
    }
    dispatchRegionEvent(['research:region-change', 'research:regionchange', 'regionchange'], {
      region,
      selectedIds,
    });
  }

  function notifyClearRegion() {
    if (typeof onClearRegion === 'function') onClearRegion();
    dispatchRegionEvent(['research:region-clear', 'research:regionclear', 'region:clear'], {
      region: null,
      selectedIds: [],
      clear: true,
    });
  }

  function dispatchRegionEvent(names, detail) {
    names.forEach((name) => {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    });
  }

  function getSelectionState(payload) {
    const scope = getPayloadScope(payload);
    const scopeMode = scope && scope.mode;
    const explicitIds = getExplicitSelectedIds(payload);
    const downstreamIds = toIdSet(payload && payload.downstreamHighlightIds);
    const selectedId = payload && payload.selectedId ? String(payload.selectedId) : null;
    const payloadRegion = hasOwn(payload, 'region') ? payload.region : null;
    const region = normalizeRegion(payloadRegion)
      || normalizeRegion(scope && scope.region)
      || selectedRegion;
    const useInternalRegion = Boolean(selectedRegion && region && regionsEqual(region, selectedRegion) && scopeMode === 'global');
    const effectiveExplicitIds = useInternalRegion ? null : explicitIds;

    if (scopeMode === 'global' && !region) {
      return {
        hasSelection: false,
        ids: new Set(),
        downstreamIds,
        selectedId,
        tradePartnerIds: getTradePartnerIds(payload, selectedId),
        region: null,
      };
    }

    let ids = effectiveExplicitIds || internalSelectedIds;

    if (region && !effectiveExplicitIds && payload && payload.network) {
      ids = selectIdsInRegion(region, payload.network);
      if (region === selectedRegion || regionsEqual(region, selectedRegion)) internalSelectedIds = ids;
    }

    return {
      hasSelection: Boolean(region || scopeMode === 'region' || effectiveExplicitIds),
      ids,
      downstreamIds,
      selectedId,
      tradePartnerIds: getTradePartnerIds(payload, selectedId),
      region,
    };
  }

  function getTradePartnerIds(payload, selectedId) {
    if (!payload || !selectedId) return new Set();
    const aggregate = getTradeAggregate(payload.result);
    const partners = aggregate.partnersByNode.get(String(selectedId));
    if (!partners) return new Set();
    return new Set([...partners.buyers, ...partners.sellers].map(String));
  }

  function getPayloadScope(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.scope && typeof payload.scope === 'object') return payload.scope;
    if (payload.result && payload.result.meta && payload.result.meta.scope) return payload.result.meta.scope;
    return null;
  }

  function getExplicitSelectedIds(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (hasOwn(payload, 'selectedIds')) return toIdSet(payload.selectedIds);
    if (hasOwn(payload, 'selectedSubbasinIds')) return toIdSet(payload.selectedSubbasinIds);
    if (hasOwn(payload, 'regionSelectedIds')) return toIdSet(payload.regionSelectedIds);
    return null;
  }

  function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function toIdSet(value) {
    if (value instanceof Set) return new Set(Array.from(value, (item) => String(item)));
    if (Array.isArray(value)) return new Set(value.map((item) => String(item)));
    if (value && typeof value[Symbol.iterator] === 'function') {
      return new Set(Array.from(value, (item) => String(item)));
    }
    return new Set();
  }

  function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return Array.from(value);
    if (value && typeof value[Symbol.iterator] === 'function') return Array.from(value);
    return [];
  }

  function normalizeRegion(region) {
    if (!region) return null;
    if (region.type === 'ids' && Array.isArray(region.ids)) {
      const ids = region.ids.map(String).filter(Boolean);
      if (!ids.length) return null;
      return {
        type: 'ids',
        ids,
        source: region.source || null,
        label: region.label || null,
      };
    }
    const polygon = normalizePolygonRegionShape(region);
    if (polygon) return polygon;
    return normalizeBboxRegion(region);
  }

  function normalizePolygonRegionShape(region) {
    const geometry = region.type === 'Feature' ? region.geometry : region;
    if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) return null;
    const ring = geometry.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    return { type: 'Polygon', coordinates: geometry.coordinates };
  }

  function normalizeBboxRegion(region) {
    if (!region) return null;
    if (region.type === 'bbox' && Array.isArray(region.sw) && Array.isArray(region.ne)) {
      const south = Math.min(Number(region.sw[0]), Number(region.ne[0]));
      const north = Math.max(Number(region.sw[0]), Number(region.ne[0]));
      const west = Math.min(Number(region.sw[1]), Number(region.ne[1]));
      const east = Math.max(Number(region.sw[1]), Number(region.ne[1]));
      if ([south, north, west, east].some((value) => !Number.isFinite(value))) return null;
      return { type: 'bbox', sw: [south, west], ne: [north, east] };
    }
    if (Array.isArray(region.bbox) && region.bbox.length >= 4) {
      const [minLng, minLat, maxLng, maxLat] = region.bbox.map(Number);
      if ([minLng, minLat, maxLng, maxLat].some((value) => !Number.isFinite(value))) return null;
      return {
        type: 'bbox',
        sw: [Math.min(minLat, maxLat), Math.min(minLng, maxLng)],
        ne: [Math.max(minLat, maxLat), Math.max(minLng, maxLng)],
      };
    }
    return null;
  }

  function selectIdsInRegion(region, network) {
    const normalized = normalizeRegion(region);
    if (!normalized || !network) return new Set();

    if (normalized.type === 'ids') return new Set(normalized.ids);

    const api = window.ResearchRegionSelect;
    if (api && typeof api.selectByCoverage === 'function' && network.subbasinsGeojson) {
      try {
        const ids = api.selectByCoverage(normalized, network.subbasinsGeojson, {
          threshold: getCoverageThreshold(),
        });
        return new Set(ids.map(String));
      } catch (error) {
        // Fall through to the centroid heuristic below.
      }
    }

    const basins = Array.isArray(network.basins) ? network.basins : [];
    const ids = new Set();

    basins.forEach((basin) => {
      const centroid = getBasinCentroid(basin);
      if (!centroid) return;
      if (isLngLatInsideRegion(centroid, normalized)) ids.add(String(basin.id));
    });

    if (ids.size || !network.subbasinsGeojson) return ids;

    (network.subbasinsGeojson.features || []).forEach((feature) => {
      const id = String((feature.properties && feature.properties.id) || '');
      const centroid = getFeatureCentroid(feature);
      if (id && centroid && isLngLatInsideRegion(centroid, normalized)) ids.add(id);
    });
    return ids;
  }

  function isLngLatInsideRegion(point, normalized) {
    if (normalized.type === 'Polygon') {
      return pointInLngLatRing(point, normalized.coordinates[0] || []);
    }
    return isLngLatInsideBbox(point, normalized);
  }

  function pointInLngLatRing(point, ring) {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = Number(ring[i][0]);
      const yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]);
      const yj = Number(ring[j][1]);
      const intersects = ((yi > lat) !== (yj > lat))
        && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function getBasinCentroid(basin) {
    if (!basin) return null;
    if (Array.isArray(basin.centroid) && basin.centroid.length >= 2) {
      const lng = Number(basin.centroid[0]);
      const lat = Number(basin.centroid[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
    }
    if (basin.feature) return getFeatureCentroid(basin.feature);
    return null;
  }

  function getFeatureCentroid(feature) {
    const coords = [];
    collectCoordinates(feature && feature.geometry && feature.geometry.coordinates, coords);
    if (!coords.length) return null;
    const sums = coords.reduce((acc, point) => {
      acc.lng += Number(point[0]) || 0;
      acc.lat += Number(point[1]) || 0;
      return acc;
    }, { lng: 0, lat: 0 });
    return [sums.lng / coords.length, sums.lat / coords.length];
  }

  function isLngLatInsideBbox(point, region) {
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    return lat >= region.sw[0]
      && lat <= region.ne[0]
      && lng >= region.sw[1]
      && lng <= region.ne[1];
  }

  function getVisibleFlows(result, selectionState) {
    const flows = getAllFlows(result);
    if (!selectionState || !selectionState.hasSelection) return flows;
    return flows.filter((flow) => (
      selectionState.ids.has(String(flow.from))
      && selectionState.ids.has(String(flow.to))
    ));
  }

  function getRenderableFlowEntries(network, result, selectionState) {
    const basinById = new Map(((network && network.basins) || []).map((basin) => [String(basin.id), basin]));
    return getVisibleFlows(result, selectionState)
      .map((flow) => {
        const from = basinById.get(String(flow.from));
        const to = basinById.get(String(flow.to));
        const fromCentroid = getRenderableFlowCentroid(from);
        const toCentroid = getRenderableFlowCentroid(to);
        if (!from || !to || !fromCentroid || !toCentroid) return null;
        return { flow, from, to, fromCentroid, toCentroid };
      })
      .filter(Boolean);
  }

  function getRenderableFlowCentroid(basin) {
    const centroid = getBasinCentroid(basin);
    if (!isInsideAoi(centroid)) return null;
    return centroid;
  }

  function isInsideAoi(point) {
    if (!Array.isArray(point) || point.length < 2) return false;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    const [minLng, minLat, maxLng, maxLat] = FLOW_AOI_BBOX;
    return Number.isFinite(lng)
      && Number.isFinite(lat)
      && lng >= minLng
      && lng <= maxLng
      && lat >= minLat
      && lat <= maxLat;
  }

  function getAllFlows(result) {
    const aggregate = result && (result.tradeAggregate || result.trade_aggregate);
    const flows = Array.isArray(aggregate && aggregate.tradeFlows)
      ? aggregate.tradeFlows
      : Array.isArray(aggregate && aggregate.flows)
        ? aggregate.flows
        : Array.isArray(aggregate && aggregate.marketFlows)
          ? aggregate.marketFlows
          : [];
    return flows
      .map((flow) => {
        const from = flow.from ?? flow.origin ?? flow.source;
        const to = flow.to ?? flow.target ?? flow.destination;
        return {
          ...flow,
          from: from === undefined || from === null ? '' : String(from),
          to: to === undefined || to === null ? '' : String(to),
          volume: Number(flow.volume ?? flow.amount ?? flow.q) || 0,
        };
      })
      .filter((flow) => flow.from && flow.to && Number(flow.volume) > 0);
  }

  const REGION_SHAPE_STYLE = {
    className: 'leaflet-region-selection',
    color: '#17212b',
    weight: 2,
    opacity: 0.95,
    fillColor: '#1f7a8c',
    fillOpacity: 0.08,
    dashArray: '7 5',
    interactive: false,
  };

  function updateLeafletRegionShape(region) {
    if (!leafletMap || !window.L) return;
    if (regionRectLayer) {
      regionRectLayer.remove();
      regionRectLayer = null;
    }

    const normalized = normalizeRegion(region);
    if (!normalized || normalized.type === 'ids') return;

    if (normalized.type === 'Polygon') {
      const latLngs = (normalized.coordinates[0] || []).map((vertex) => [vertex[1], vertex[0]]);
      if (latLngs.length < 3) return;
      regionRectLayer = window.L.polygon(latLngs, REGION_SHAPE_STYLE).addTo(leafletMap);
      return;
    }

    regionRectLayer = window.L.rectangle([
      [normalized.sw[0], normalized.sw[1]],
      [normalized.ne[0], normalized.ne[1]],
    ], REGION_SHAPE_STYLE).addTo(leafletMap);
  }

  function updateSelectionSummary(selectionState, payload) {
    const element = document.getElementById('selected-basin');
    if (!element) return;
    if (payload && payload.selectedId && payload.result && Array.isArray(payload.result.basinResults)) {
      const selected = payload.result.basinResults.find((item) => item.id === payload.selectedId);
      element.textContent = selected ? displayNameForEntity(selected, payload.selectedId) : payload.selectedId;
      updateDownstreamSummary(payload);
      return;
    }
    if (selectionState && selectionState.hasSelection) {
      element.textContent = selectionState.ids.size ? `选区 ${selectionState.ids.size} 个` : '选区为空';
      updateDownstreamSummary(payload);
      return;
    }
    if (!payload || !payload.selectedId) element.textContent = '全域';
    updateDownstreamSummary(payload);
  }

  function updateDownstreamSummary(payload) {
    const element = document.getElementById('downstream-summary');
    if (!element) return;
    const ids = Array.isArray(payload && payload.downstreamHighlightIds) ? payload.downstreamHighlightIds : [];
    if (!payload || !payload.selectedId) {
      element.textContent = '未选中';
      return;
    }
    if (!ids.length) {
      element.textContent = '无下游影响';
      return;
    }
    const basinById = new Map(((payload.network && payload.network.basins) || []).map((basin) => [basin.id, basin]));
    const population = ids.reduce((sum, id) => {
      const basin = basinById.get(String(id));
      return sum + (Number(basin && basin.population) || 0);
    }, 0);
    element.textContent = `${ids.length} 个 / ${formatPeople(population)}`;
  }

  function syncRegionControls() {
    if (regionDrawButton) {
      const active = drawMode === 'rect';
      regionDrawButton.classList.toggle('active', active);
      regionDrawButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      regionDrawButton.textContent = active ? '取消圈选' : '矩形圈选';
    }
    if (regionLassoButton) {
      const active = drawMode === 'lasso';
      regionLassoButton.classList.toggle('active', active);
      regionLassoButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      regionLassoButton.textContent = active ? '取消套索' : '套索圈选';
    }
    if (clearRegionButton) {
      const selectionState = latestPayload ? getSelectionState(latestPayload) : {
        hasSelection: Boolean(selectedRegion || internalSelectedIds.size),
      };
      clearRegionButton.disabled = !selectionState.hasSelection;
    }
    const hasSeed = getSeedIds().length > 0;
    const hasTopology = Boolean(latestPayload && latestPayload.network && latestPayload.network.topology);
    if (expandUpstreamButton) expandUpstreamButton.disabled = !hasSeed || !hasTopology;
    if (expandDownstreamButton) expandDownstreamButton.disabled = !hasSeed || !hasTopology;
    if (citySelectControl) citySelectControl.disabled = !latestPayload || !latestPayload.network;
  }

  function regionsEqual(a, b) {
    if (!a || !b) return false;
    if (a.type !== b.type) return false;
    if (a.type === 'Polygon') {
      return JSON.stringify(a.coordinates) === JSON.stringify(b.coordinates);
    }
    if (a.type === 'ids') {
      if (a.ids.length !== b.ids.length) return false;
      const other = new Set(b.ids);
      return a.ids.every((id) => other.has(id));
    }
    return Array.isArray(a.sw) && Array.isArray(b.sw)
      && a.sw[0] === b.sw[0]
      && a.sw[1] === b.sw[1]
      && a.ne[0] === b.ne[0]
      && a.ne[1] === b.ne[1];
  }

  function colorFor(layerName, item, context) {
    const palette = PALETTES[layerName] || PALETTES.healthGain;
    const meta = LAYER_META[layerName] || LAYER_META.healthGain;
    if (layerName === 'netTrade') {
      const net = readNetTrade(item, context && context.tradeAggregate);
      const max = Math.max(Number(context && context.netTradeMax) || 0, Math.abs(net), 1);
      const normalized = Math.max(-1, Math.min(1, -net / max));
      return interpolate3(palette, (normalized + 1) / 2);
    }
    const rawValue = Number(item[meta.field] || 0);
    let t;
    if (layerName === 'healthGain') {
      t = Math.min(1, Math.sqrt(Math.max(0, rawValue)) / 18);
    } else {
      t = Math.max(0, Math.min(1, rawValue));
    }
    return interpolate3(palette, t);
  }

  function interpolate3(colors, t) {
    if (t <= 0.5) return mix(colors[0], colors[1], t * 2);
    return mix(colors[1], colors[2], (t - 0.5) * 2);
  }

  function mix(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    const rgb = ca.map((value, index) => Math.round(value + (cb[index] - value) * t));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }

  function addLegend() {
    if (!window.L || !leafletMap) return;
    legend = window.L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = window.L.DomUtil.create('div', 'map-legend');
      return div;
    };
    legend.addTo(leafletMap);
  }

  function updateLegend(layerName) {
    const element = document.querySelector('.map-legend');
    if (!element) return;
    const palette = PALETTES[layerName] || PALETTES.healthGain;
    const label = (LAYER_META[layerName] && LAYER_META[layerName].label) || layerName;
    const labels = layerName === 'netTrade'
      ? ['净买入', '自给', '净卖出']
      : ['低', '中', '高'];
    const note = layerName === 'netTrade'
      ? '<div class="legend-note">灰=自给/未参与交易；仅少数城市子流域净买卖。</div>'
      : '';
    element.innerHTML = `
      <div class="legend-title">${escapeHtml(label)}</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${palette[0]}"></span><span>${labels[0]}</span></div>
      <div class="legend-row"><span class="legend-swatch" style="background:${palette[1]}"></span><span>${labels[1]}</span></div>
      <div class="legend-row"><span class="legend-swatch" style="background:${palette[2]}"></span><span>${labels[2]}</span></div>
      ${note}
    `;
  }

  function renderPopup(item, context) {
    if (!item) return '<div class="basin-popup">暂无属性</div>';
    const netTrade = readNetTrade(item, context && context.tradeAggregate);
    const name = displayNameForEntity(item, item.id);
    const code = technicalCodeFor(item, item.id);
    return `
      <div class="basin-popup">
        <h3>${escapeHtml(name)}</h3>
        ${code ? `<div class="popup-code" title="技术 ID：${escapeHtml(code)}">Pfaf 编码：${escapeHtml(code)}</div>` : ''}
        <div class="popup-row"><span>DALY</span><strong>${formatNumber(item.dalyAvoided, 1)}</strong></div>
        <div class="popup-row"><span>健康收益</span><strong>${formatMoney(item.healthBenefitCny)}</strong></div>
        <div class="popup-row"><span>净交易</span><strong>${escapeHtml(formatSignedWater(netTrade))}（${netTradeRole(netTrade)}）</strong></div>
        <div class="popup-row"><span>下游人口</span><strong>${formatPeople(item.downstreamPopulationAffected)}</strong></div>
        <div class="popup-row"><span>水压力</span><strong>${formatPercent(item.stressIndex)}</strong></div>
        <div class="popup-row"><span>激励相容</span><strong>${item.incentiveCompatible ? '是' : '否'}</strong></div>
      </div>
    `;
  }

  function displayNameForEntity(entity, fallback) {
    const code = technicalCodeFor(entity, fallback);
    return chooseDisplayName([
      entity && entity.name,
      entity && entity.nameZh,
      entity && entity.label,
      entity && entity.displayName,
      fallback,
    ], code);
  }

  function technicalCodeFor(entity, fallback) {
    return firstText([
      entity && entity.code,
      entity && entity.pfafId,
      entity && entity.pfaf_id,
      fallback,
    ]);
  }

  function chooseDisplayName(candidates, fallbackCode) {
    const values = (candidates || []).map((value) => firstText([value])).filter(Boolean);
    const fallback = firstText([fallbackCode, '--']);
    const preferred = values.find((value) => !isTechnicalLabel(value) && value !== fallback);
    return preferred || values[0] || fallback;
  }

  function firstText(candidates) {
    const found = (candidates || []).find((value) => value !== undefined && value !== null && String(value).trim() !== '');
    return found === undefined ? '' : String(found);
  }

  function isTechnicalLabel(value) {
    const label = String(value || '').trim();
    return /^PF[_-]?\d+$/i.test(label) || /^\d{5,}$/.test(label);
  }

  function shortName(name) {
    return String(name || '').replace(/片区|汇流区|入境|灌区|源区/g, '').slice(0, 4);
  }

  function formatPercent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function formatPeople(value) {
    const number = Number(value) || 0;
    if (number >= 10000) return `${(number / 10000).toFixed(1)}万人`;
    return `${Math.round(number)}人`;
  }

  function formatWater(value) {
    const number = Number(value) || 0;
    const sign = number < 0 ? '−' : '';
    const abs = Math.abs(number);
    if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(2)}亿m³`;
    if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万m³`;
    return `${sign}${Math.round(abs)}m³`;
  }

  function formatSignedWater(value) {
    const number = Number(value) || 0;
    if (Math.abs(number) <= FLOW_CHANGE_EPS) return '0m³';
    return `${number >= 0 ? '+' : ''}${formatWater(number)}`;
  }

  function formatPrice(value) {
    return `${(Number(value) || 0).toFixed(3)}元/m³`;
  }

  function netTradeRole(value) {
    const number = Number(value) || 0;
    if (number < -FLOW_CHANGE_EPS) return '净卖出';
    if (number > FLOW_CHANGE_EPS) return '净买入';
    return '自给';
  }

  function formatMoney(value) {
    const number = Number(value) || 0;
    if (number >= 100000000) return `${(number / 100000000).toFixed(2)}亿元`;
    if (number >= 10000) return `${(number / 10000).toFixed(1)}万元`;
    return `${Math.round(number)}元`;
  }

  function formatNumber(value, digits) {
    return (Number(value) || 0).toLocaleString('zh-CN', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  window.ResearchMap = {
    init,
    update,
    setRegion: (region, selectedIds) => {
      const normalized = normalizeRegion(region);
      if (!normalized) return;
      selectedRegion = normalized;
      internalSelectedIds = selectedIds === undefined
        ? selectIdsInRegion(normalized, latestPayload && latestPayload.network)
        : toIdSet(selectedIds);
      if (latestPayload) update(latestPayload);
      else {
        updateLeafletRegionShape(normalized);
        syncRegionControls();
      }
    },
    clearRegion,
    startRegionDraw: () => setDrawMode('rect'),
    startLassoDraw: () => setDrawMode('lasso'),
    stopRegionDraw: () => setDrawMode(false),
    expandUpstream: () => expandSelection('upstream'),
    expandDownstream: () => expandSelection('downstream'),
    selectCity: (city, label) => selectCityRegion(city, label || city),
    getRegion: () => selectedRegion,
    getSelectedIds: () => Array.from(internalSelectedIds),
    refresh: () => latestPayload && update(latestPayload),
  };
})();
