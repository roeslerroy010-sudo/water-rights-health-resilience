// map.js — 基于Leaflet的流域地图可视化

let map;
let userMarkers = [];
let tradeFlowLines = [];
let healthRings = [];
let legendControl = null;

function initMap() {
  if (map) return;

  map = L.map('map', {
    center: [30.55, 114.30],
    zoom: 10,
    zoomControl: true,
  });

  // 高德地图中文瓦片（无需API密钥）
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    attribution: '&copy; 高德地图',
    maxZoom: 18,
    subdomains: ['1', '2', '3', '4'],
  }).addTo(map);

  L.rectangle([[30.15, 113.80], [31.00, 114.80]], {
    color: '#1a6b8a', weight: 2, fill: true,
    fillColor: '#1a6b8a', fillOpacity: 0.05, dashArray: '6, 4',
  }).addTo(map).bindPopup(BASIN_INFO.name);

  L.polyline([
    [30.80, 114.05], [30.70, 114.12], [30.60, 114.25],
    [30.50, 114.35], [30.40, 114.45], [30.30, 114.55],
  ], {
    color: '#3b82f6', weight: 3, opacity: 0.6,
  }).addTo(map).bindPopup('长江干流');

  // 图例
  legendControl = L.control({ position: 'bottomleft' });
  legendControl.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div class="legend-title">节点大小 = 分水量</div>
      <div class="legend-item"><span class="legend-dot" style="background:#16a34a;"></span> 健康优先</div>
      <div class="legend-item"><span class="legend-dot" style="background:#d97706;"></span> 农业用水</div>
      <div class="legend-item"><span class="legend-dot" style="background:#dc2626;"></span> 工业用水</div>
      <div class="legend-item"><span class="legend-dot" style="background:#6366f1;"></span> 能源用水</div>
      <hr style="margin:4px 0;border-color:#e5e7eb;">
      <div class="legend-item"><span class="legend-ring green"></span> 正向健康影响</div>
      <div class="legend-item"><span class="legend-ring red"></span> 损害健康（被征税）</div>
    `;
    return div;
  };
  legendControl.addTo(map);
}

function renderUserNodes(simulationResult) {
  userMarkers.forEach(function (m) { map.removeLayer(m); });
  userMarkers = [];
  healthRings.forEach(function (r) { map.removeLayer(r); });
  healthRings = [];

  simulationResult.userResults.forEach(function (user) {
    var typeConfig = TYPE_CONFIG[user.type] || { color: '#64748b' };
    var color = typeConfig.color;

    // 显著尺寸范围：16px 到 44px——分水变化肉眼可见
    var minSize = 16;
    var maxSize = 44;
    var frac = Math.min(1, Math.max(0, user.effectiveAllocation / 1700));
    var size = minSize + frac * (maxSize - minSize);

    // 健康影响光环：正向绿色、负向红色
    var healthImpact = user.healthImpact;
    var ringColor, ringOpacity;
    if (healthImpact > 5)       { ringColor = '#16a34a'; ringOpacity = 0.5 + Math.min(0.4, healthImpact / 80); }
    else if (healthImpact > 0)  { ringColor = '#16a34a'; ringOpacity = 0.3; }
    else if (healthImpact > -5) { ringColor = '#94a3b8'; ringOpacity = 0.2; }
    else                        { ringColor = '#dc2626'; ringOpacity = 0.4 + Math.min(0.4, Math.abs(healthImpact) / 40); }

    var ringSize = size + 12;

    // 健康光环（节点后方的独立圆圈）
    var ringIcon = L.divIcon({
      className: 'health-ring',
      html: '<div style="'
        + 'width:' + ringSize + 'px;height:' + ringSize + 'px;'
        + 'border:3px solid ' + ringColor + ';'
        + 'border-radius:50%;'
        + 'opacity:' + ringOpacity + ';'
        + 'box-sizing:border-box;'
        + '"></div>',
      iconSize: [ringSize, ringSize],
      iconAnchor: [ringSize / 2, ringSize / 2],
    });
    var ringMarker = L.marker([user.lat, user.lng], { icon: ringIcon, interactive: false }).addTo(map);
    healthRings.push(ringMarker);

    // 主节点
    var icon = L.divIcon({
      className: 'water-node',
      html: '<div style="'
        + 'width:' + size + 'px;height:' + size + 'px;'
        + 'background:' + color + ';'
        + 'border:2.5px solid white;'
        + 'border-radius:50%;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,0.3);'
        + 'display:flex;align-items:center;justify-content:center;'
        + 'color:white;font-size:' + Math.max(9, size * 0.35) + 'px;font-weight:700;'
        + '">' + user.name.charAt(0) + '</div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });

    var popupContent = '<div style="font-family:sans-serif;min-width:170px;">'
      + '<strong style="font-size:14px;">' + (typeConfig.icon || '') + ' ' + user.name + '</strong>'
      + '<hr style="margin:6px 0;border:none;border-top:1px solid #e5e7eb;">'
      + '<table style="width:100%;font-size:12px;">'
      + '<tr><td style="color:#666;">类型</td><td style="text-align:right;font-weight:600;">' + (typeConfig.label || user.type) + '</td></tr>'
      + '<tr><td style="color:#666;">分水量</td><td style="text-align:right;font-weight:600;">' + user.effectiveAllocation.toFixed(0) + 'M m&sup3;</td></tr>'
      + '<tr><td style="color:#666;">健康影响</td><td style="text-align:right;font-weight:600;color:' + (healthImpact >= 0 ? '#16a34a' : '#dc2626') + ';">' + (healthImpact >= 0 ? '+' : '') + healthImpact.toFixed(1) + '</td></tr>'
      + '<tr><td style="color:#666;">健康税</td><td style="text-align:right;font-weight:600;color:' + (user.healthTax > 0 ? '#dc2626' : '#16a34a') + ';">&yen;' + user.healthTax.toFixed(3) + '/m&sup3;</td></tr>'
      + '</table></div>';

    var marker = L.marker([user.lat, user.lng], { icon: icon })
      .bindPopup(popupContent)
      .addTo(map);
    userMarkers.push(marker);
  });
}

function renderTradeFlows(simulationResult) {
  tradeFlowLines.forEach(function (l) { map.removeLayer(l); });
  tradeFlowLines = [];

  var healthUsers = simulationResult.userResults.filter(function (u) { return u.type === 'health'; });
  var otherUsers = simulationResult.userResults.filter(function (u) { return u.type !== 'health'; });

  otherUsers.forEach(function (source) {
    healthUsers.forEach(function (target) {
      var flowAmount = Math.min(source.effectiveAllocation * 0.2, target.effectiveAllocation * 0.3);
      if (flowAmount < 3) return;

      var latlngs = [[source.lat, source.lng], [target.lat, target.lng]];
      var isHighTax = source.healthTax > 0.03;

      var line = L.polyline(latlngs, {
        color: isHighTax ? '#dc2626' : '#64748b',
        weight: Math.max(1.5, flowAmount / 25),
        opacity: isHighTax ? 0.55 : 0.3,
        dashArray: isHighTax ? '6, 5' : '4, 6',
      }).addTo(map);
      tradeFlowLines.push(line);
    });
  });
}

function updateMap(simulationResult) {
  if (!map) initMap();
  renderUserNodes(simulationResult);
  renderTradeFlows(simulationResult);

  var stats = document.getElementById('map-stats');
  stats.innerHTML = ''
    + '<div class="stat-card">'
    + '<div class="stat-value">&yen;' + simulationResult.marketPrice.toFixed(2) + '</div>'
    + '<div class="stat-label">市场价格 /m&sup3;</div></div>'
    + '<div class="stat-card">'
    + '<div class="stat-value">' + Math.round(simulationResult.water.tradable).toLocaleString() + 'M</div>'
    + '<div class="stat-label">可交易水量 (m&sup3;)</div></div>'
    + '<div class="stat-card">'
    + '<div class="stat-value">' + simulationResult.water.climateLabel.split(' ')[0] + '</div>'
    + '<div class="stat-label">气候情景</div></div>'
    + '<div class="stat-card">'
    + '<div class="stat-value" style="color:' + (simulationResult.incentive.compatible ? '#16a34a' : '#dc2626') + ';">' + (simulationResult.incentive.compatible ? '稳定' : '风险') + '</div>'
    + '<div class="stat-label">激励状态</div></div>';
}
