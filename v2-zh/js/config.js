// config.js — 水权交易模拟器的全部数据与情景参数
// ACTION 黑客马拉松 — 主题四：水相关技术与气候健康适应

// ---- 默认参数 ----
const DEFAULT_PARAMS = {
  healthTaxRate: 0.15,        // τ：0 到 0.50
  climateScenario: 'ssp245',  // 'ssp245' | 'ssp585'
  healthFloor: 0.25,          // 预留给健康优先用户的水量占比
  tradingCost: 'medium',      // 'low' | 'medium' | 'high'
};

// ---- 气候情景：水资源供给冲击 ----
const CLIMATE_SCENARIOS = {
  ssp245: {
    label: 'SSP2-4.5（中等排放）',
    waterAvailability: 1.0,      // 基准水平
    droughtFrequency: 0.15,
    floodFrequency: 0.10,
    description: '中等排放路径，2100年升温约2.5°C。',
  },
  ssp585: {
    label: 'SSP5-8.5（高排放）',
    waterAvailability: 0.72,     // 水资源减少28%
    droughtFrequency: 0.35,
    floodFrequency: 0.20,
    description: '化石燃料驱动发展，2100年升温约4.4°C。',
  },
};

// ---- 交易成本系数 ----
const TRADING_COSTS = {
  low:    { label: '低', multiplier: 0.95, description: '高效市场，摩擦最小' },
  medium: { label: '中', multiplier: 0.85, description: '典型交易成本水平' },
  high:   { label: '高', multiplier: 0.70, description: '较高的监管与搜寻成本' },
};

// ---- 示范流域：6个用水户节点（长江中游演示案例） ----
const WATER_USERS = [
  { id: 'muni',   name: '市政供水',        lat: 30.55, lng: 114.30, type: 'health',   allocation: 40, healthWeight: 1.0,  popServed: 3500000 },
  { id: 'agri1',  name: '农业用水（上游）',  lat: 30.70, lng: 114.10, type: 'agri',    allocation: 25, healthWeight: 0.1,  popServed: 0 },
  { id: 'agri2',  name: '农业用水（下游）',  lat: 30.35, lng: 114.50, type: 'agri',    allocation: 20, healthWeight: 0.1,  popServed: 0 },
  { id: 'ind1',   name: '工业用水（化工）',  lat: 30.60, lng: 114.45, type: 'industry', allocation: 10, healthWeight: -0.3, popServed: 0 },
  { id: 'ind2',   name: '工业用水（纺织）',  lat: 30.45, lng: 114.20, type: 'industry', allocation: 5,  healthWeight: -0.15, popServed: 0 },
  { id: 'hydro',  name: '水力发电',         lat: 30.80, lng: 114.15, type: 'energy',   allocation: 0,  healthWeight: 0.0,  popServed: 0 },
];

// ---- 各用水类型的健康损失系数 ----
const HEALTH_LOSS_COEFF = {
  health:    0.0,   // 健康优先用水无健康损失
  agri:      0.25,  // 农业面源污染（氮磷、农药）
  industry:  0.60,  // 工业点源污染（化学物质、重金属）
  energy:    0.05,  // 轻微热污染
};

// ---- 水-健康剂量反应参数 ----
const DOSE_RESPONSE = {
  baselineDALY: 45,       // 每10万人的基准水媒疾病负担（伤残调整寿命年）
  elasticity: 0.8,        // 水质每变动1%，疾病负担变动百分比
  valuePerDALY: 185000,   // 每个DALY的货币化价值（元，WHO成本效益指南）
};

// ---- 流域基本信息（长江中游，演示用） ----
const BASIN_INFO = {
  name: '长江中游流域（演示）',
  totalWater: 5800,           // 年总水资源量（百万m³）
  ecologicalBaseFlow: 1740,   // 30%预留生态基流
  tradableWater: 4060,        // 可交易水量 = 总量 - 生态基流
  population: 8500000,        // 流域人口
  area: 68000,               // 面积（km²）
  annualRainfall: 1200,      // 年降雨量（mm）
};

// ---- 预计算查找表：τ × H_loss × DALY，按用水户分类 ----
function buildLookupTable() {
  const table = {};
  const tauValues = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  WATER_USERS.forEach(user => {
    const hLoss = HEALTH_LOSS_COEFF[user.type] ?? 0.25;
    table[user.id] = tauValues.map(tau => ({
      tau,
      healthTax: Math.round(tau * hLoss * DOSE_RESPONSE.baselineDALY / 100 * 1000) / 1000,
    }));
  });
  return table;
}

// ---- 类型展示配置 ----
const TYPE_CONFIG = {
  health:   { color: '#16a34a', label: '健康优先', icon: '💧' },
  agri:     { color: '#d97706', label: '农业用水', icon: '🌾' },
  industry: { color: '#dc2626', label: '工业用水', icon: '🏭' },
  energy:   { color: '#6366f1', label: '能源用水', icon: '⚡' },
};

// ---- 图表色板 ----
const CHART_COLORS = {
  withMarket:    { bg: '#16a34a', border: '#15803d' },
  withoutMarket: { bg: '#94a3b8', border: '#64748b' },
  healthTax:     { bg: '#2563eb', border: '#1d4ed8' },
  disease:       { bg: '#d97706', border: '#b45309' },
};
