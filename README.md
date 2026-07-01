# 水权交易与健康韧性

一个面向武汉都市圈子流域网络的静态前端原型，用于演示“水权交易 + 健康税 + 健康/生态底线”如何在气候压力下影响用水配置、健康收益和市场结果。

## 当前正式入口

- GitHub Pages 根路径会自动跳转到 `research/`。
- 本地演示入口：`research/index.html`
- 本地服务建议：

```bash
python3 -m http.server 8000
```

打开：

```text
http://127.0.0.1:8000/research/
```

## 保留内容

```text
index.html                 GitHub Pages 轻量跳转入口
research/index.html        研究级中文交互前端
research/css/              页面样式
research/js/               地图、仪表盘、市场求解、交易流和测试
research/data/             已生成的武汉都市圈 66 子流域静态数据
research/vendor/leaflet/   前端地图依赖
research/vendor/glpk.js/   LP 求解依赖的精简本地副本
research/tools/            数据与功能校验脚本、离线 bake 管线
research/docs/             方法说明
```

已删除旧版演示页面、PPT 生成物、过程工单和本地原始数据包。`research/tools/bake/raw/` 不进入仓库；如需重新烘焙数据，按 `research/tools/bake/fetch_data.md` 重新获取来源文件。

## 核心机制

- 普通市场按支付意愿配置水，容易把水推向高支付意愿部门。
- 健康税把工业用水的健康外部性写入有效成本。
- 税率上升时，工业有效用水下降；健康优先用水和生态流量得到保护。
- 工具把以上机制做成可调参数、空间网络和指标仪表盘，便于现场演示和政策讨论。

## 校验

```bash
node research/tools/validate_research_data.js
node research/tools/validate_region_feature.js
node research/js/networkModel.test.js
```

`validate_research_data.js` 默认校验当前 full-bake 数据。若要查看历史 sample 校验逻辑，可显式加 `--sample`，但当前正式数据应使用默认或 `--full-bake`。

## 数据口径

当前 `research/data/` 是已生成的武汉都市圈 1+8 full-bake 静态输出，包含 66 个子流域、河网流向、部门需求、供给估计、健康权重和来源 provenance。方法学边界见 `research/docs/methodology.md` 与 `research/README.md`。
