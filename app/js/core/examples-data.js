/**
* examples-data.js — 内联示例数据（v5.0）
*
* 职责：存放 6 个内置的分析示例数据，以避免 file:
*
* v5.0 变更：
* - 全面重写示例内容与结构，匹配最新代码（v5.0）和提示词
* - 新增 evidence 字段填充真实证据内容
* - 鱼骨图数据补充 phenomenon / importedContext / theme 字段
* - FTA 数据补充 description / problemTitle 字段
* - 同级兄弟节点 weight 归一化为百分比（父节点 weight 固定 100）
*/
(function (win) {
'use strict';

if (typeof win === 'undefined') return;
win.EXAMPLES_DATA = {

'5why-bp-monitor': {
_format: 'tool-problem-analysis/v1',
menuLabel: '5 Whys: 血压监护仪偏高',
title: '监护仪 NIBP 测量值系统性偏高',
phenomenon:
'多参数监护仪无创血压模块测量值较水银柱血压计系统性偏高 12-18 mmHg（随批次推进偏高幅度呈增大趋势，B2603A 批次偏差最大），涉及 3 个批次共 450 台设备',
severity: 'critical',
time: '2026-03-01T12:00',
discoverySource: 'customer-complaint',
expectedState: '血压测量值与水银柱血压计对比偏差 ≤±5 mmHg（静态）或 ≤±8 mmHg（动态）',
expectedSource: 'regulation',
expectedDetail: 'YY 0667-2008 (自动循环无创血压设备安全专用要求) / ISO 81060-2:2018',
trend: 'gradual',
containment: '已暂停 3 个批次发货，通知已售客户暂停使用 NIBP 功能并安排现场校准',
tree: {
id: 1,
parentId: null,
level: 1,
text: '气囊充放气压力传感器采样值漂移导致 NIBP 测量值系统性偏高',
weight: 100,
isRootCause: false,
evidence: ['B2603A 批次出厂测试记录显示偏差 16-18 mmHg，较 A 批次高 6-8 mmHg'],
children: [
{
id: 2,
parentId: 1,
level: 2,
text: '传感器封装工艺变更后温漂系数超出原设计规格',
weight: 65,
isRootCause: false,
evidence: [
'供应商变更通知单（ECN-2025-038）：B 型封装胶热膨胀系数 180 ppm/°C，原 A 型为 152 ppm/°C',
'来料检验记录：B2603A 批次传感器 40°C 温漂测试值均值 0.32%，规格上限 0.18%'
],
children: [
{
id: 3,
parentId: 2,
level: 3,
text: 'B2603A 批次起供应商将封装胶由 A 型换为 B 型，热膨胀系数相差 18%',
weight: 55,
isRootCause: false,
evidence: [
'供应商出货报告（COA-B2603A）：封装胶型号变更为 B 型，未标注为工程变更',
'内部测试报告 TEMP-2026-021：40°C 条件下 B 型封装应力导致膜片偏移量增加 0.012 mm'
],
children: [
{
id: 4,
parentId: 3,
level: 4,
text: '来料变更未触发工程变更评审（ECR），QC 来料检验规程 IQC-SOP-012 中无温漂复测项',
weight: 100,
isRootCause: true,
evidence: [
'ECR 数据库查询记录：2025 年 8 月至 2026 年 2 月期间无传感器封装相关 ECR',
'IQC-SOP-012 第 4.2 节：来料检验项目仅包括外观、尺寸和静态精度，不包括温漂'
],
children: []
}
]
},
{
id: 5,
parentId: 2,
level: 3,
text: '出厂校准程序在常温（25°C）单点校准，未覆盖 35-40°C 体温范围',
weight: 45,
isRootCause: false,
evidence: [
'校准工位记录：2026 年 2 月全月校准环境温度范围 24.5-26.2°C',
'NIBP 校准台温度传感器数据：整批次校准均温 25.3°C'
],
children: [
{
id: 6,
parentId: 5,
level: 4,
text: 'SOP-NIBP-CAL-03 第 3.1 节温度覆盖范围条款（原要求 15-40°C）自 2024 年 6 月修订版起被删除，删除原因未记录',
weight: 100,
isRootCause: true,
evidence: [
'SOP 变更历史记录：2024-06-15 版本从第 3.1 节删除「温度覆盖范围」段落，变更说明栏为空',
'文件审批记录：2024-06-15 版本审批人签名为质量经理，无附带变更理由文件'
],
children: []
}
]
}
]
},
{
id: 7,
parentId: 1,
level: 2,
text: '整机出厂 NIBP 性能验证抽检比例不足，未覆盖全温度范围',
weight: 35,
isRootCause: false,
evidence: [
'出厂检验报告：B2603A 批次 NIBP 项目抽检 22 台（5%），全部在常温 25°C 测试',
'DVP 文件 DVP-NIBP-2024-01：温度偏差测试标记为「抽检」，抽检比例栏填写「待定」'
],
children: [
{
id: 8,
parentId: 7,
level: 3,
text: '产品验证计划 DVP-NIBP-2024-01 中 NIBP 温度偏差测试列为「抽检」项，抽检比例无文件依据',
weight: 100,
isRootCause: true,
evidence: [
'DVP-NIBP-2024-01 第 7.2 节：温度偏差测试抽检比例栏填写「待定」，无具体比例',
'设计评审会议纪要（2024-03-12）：抽检比例议题讨论结论为「后续补充」，实际未补充'
],
children: []
}
]
}
]
},
nextId: 9
},

'5why-hba1c': {
_format: 'tool-problem-analysis/v1',
menuLabel: '5 Whys: HbA1c 批间差异超标',
title: 'HbA1c 检测系统批间差超标及室间质评不合格',
phenomenon:
'HPLC 法 HbA1c 检测系统室间质评连续 2 轮不合格，批间 CV 达 4.8%（近 6 个月从 2.1% 逐步升高至 4.8%，呈渐进性恶化），超出允许范围（≤3%）',
severity: 'critical',
time: '2026-03-15T09:00',
discoverySource: 'external-audit',
expectedState: '批间 CV ≤3%，室间质评评分 ≥80 分',
expectedSource: 'regulation',
expectedDetail: 'WS/T 403-2012 (临床生物化学检验质量指标) / IFCC HbA1c 标准化方案要求',
trend: 'gradual',
containment: '已暂停 HPLC 法检测，切换至免疫法备用系统出具报告',
tree: {
id: 1,
parentId: null,
level: 1,
text: 'HPLC 色谱柱效能逐批衰减，导致 HbA1c 峰面积重现性下降',
weight: 100,
isRootCause: false,
evidence: [
'色谱柱使用台账：当前色谱柱进样次数已达 4,860 次，厂商推荐上限 3,600 次',
'6 个月趋势图：批间 CV 从 2.1% 逐月递增至 4.8%，与进样次数呈正相关'
],
children: [
{
id: 2,
parentId: 1,
level: 2,
text: '色谱柱使用寿命管理失效：实际进样次数已超出厂商规定上限 35%',
weight: 60,
isRootCause: false,
evidence: [
'LIS 系统色谱柱模块查询记录：进样计数 4,860，未触发任何提醒或拦截',
'厂商技术公告 TB-2024-HbA1c-02：明确建议色谱柱进样上限 3,600 次，超出后分离度下降 ≥15%'
],
children: [
{
id: 3,
parentId: 2,
level: 3,
text: 'LIS 系统中色谱柱进样计数模块仅做累计记录，未与质控预警规则联动，超限不报警',
weight: 55,
isRootCause: true,
evidence: [
'LIS 系统配置截屏（2026-03-10）：质控模块预警规则列表无「色谱柱进样次数」项',
'IT 维护记录：2024 年 LIS 升级时去掉了色谱柱计数器的阈值报警功能，归类为「非关键需求」'
],
children: []
},
{
id: 4,
parentId: 2,
level: 3,
text: '检验科 SOP-HbA1c-04 第 2.3 节中色谱柱更换条件仅写「由工程师判断」，无进样次数或分离度量化标准',
weight: 45,
isRootCause: true,
evidence: [
'SOP-HbA1c-04 现行版（2025-01 修订）：更换条件栏原文为「色谱柱性能不佳时由工程师判断更换」',
'2024 年度内审记录：曾对「工程师判断」缺乏量化标准开出观察项，整改措施为「加强培训」未修改 SOP'
],
children: []
}
]
},
{
id: 5,
parentId: 1,
level: 2,
text: '流动相配制浓度随批次累积漂移，手工配制操作差异大',
weight: 40,
isRootCause: false,
evidence: [
'流动相配制记录（2026-01 ~ 2026-02）：同一配方实际 pH 值范围 5.6-6.2，目标值 5.9',
'试剂空白吸光度监测记录：A280 值波动 CV 8.3%，远高于装机时的 1.2%'
],
children: [
{
id: 6,
parentId: 5,
level: 3,
text: '流动相配制 SOP-HbA1c-05 第 1.2 节使用「加入约 200 mL」「调至约 pH 6.0」等模糊表述，未规定容量瓶精度等级',
weight: 60,
isRootCause: true,
evidence: [
'SOP-HbA1c-05 第 1.2 节：原文「量取约 200 mL 超纯水」，未指定 A 级或 B 级容量瓶',
'配制人员访谈记录（2026-03-12）：3 名操作员对「约」的理解分别为 190 mL / 200 mL / 210 mL'
],
children: []
},
{
id: 7,
parentId: 5,
level: 3,
text: '配制记录表单 HbA1c-REC-03 无独立复核人签字栏，操作者自校后直接放行',
weight: 40,
isRootCause: true,
evidence: [
'空白记录表单 HbA1c-REC-03（2025 版）：仅有「配制人」一栏，无「复核人」栏位',
'2025 年度差错统计：与流动相相关的配制差错 4 起，均无第二人复核记录'
],
children: []
}
]
}
]
},
nextId: 8
},

'fishbone-coagulation': {
_format: 'tool-problem-analysis/v1',
menuLabel: '鱼骨图: 凝血分析仪 PT 偏低',
title: '全自动凝血分析仪 PT 检测值偏低',
phenomenon:
'全自动凝血分析仪 PT 检测值系统性偏低约 1.5-2 秒（在 2 周内从 -1.0 秒扩大到 -2.0 秒），导致 INR 计算偏低，影响抗凝治疗监控准确性',
severity: 'critical',
time: '2026-04-15T08:00',
discoverySource: 'in-process',
expectedState: 'PT 质控值在靶值 ±1 秒范围内，INR 偏差 ≤±0.1',
expectedSource: 'regulation',
expectedDetail: 'WS/T 224-2018 / CLSI H47-A2 凝血试验检测系统验证指南',
trend: 'gradual',
containment:
'已暂停新批次试剂使用，启用上一批次库存试剂出具报告，对偏低期间结果进行回顾性审核',
fishboneData: {
problem: '全自动凝血分析仪 PT 检测值系统性偏低',
phenomenon:
'全自动凝血分析仪 PT 检测值系统性偏低约 1.5-2 秒（在 2 周内从 -1.0 秒扩大到 -2.0 秒），导致 INR 计算偏低',
savedAt: '2026-04-15T10:30:00.000Z',
importedContext:
'问题标题：全自动凝血分析仪 PT 检测值偏低\n' +
'问题现象：全自动凝血分析仪 PT 检测值系统性偏低约 1.5-2 秒\n' +
'严重度：严重\n' +
'发生时间：2026-04-15T08:00\n' +
'发现方式：过程监控\n' +
'期望值：PT 质控值在靶值 ±1 秒范围内\n' +
'趋势：渐变\n' +
'临时措施：已暂停新批次试剂使用，启用上一批次库存试剂出具报告',
theme: 'premium',
categories: {
man: [
{
text: '操作员标本离心时间不足，未严格执行 10 min / 2500g 要求',
subCauses: [
'操作员认为「差不多」即可，未使用计时器',
'早班交接时口头告知而非书面记录离心参数'
]
},
{
text: '试剂从冷藏取出后复温时间不一致（5-45 分钟不等）',
subCauses: [
'SOP-COAG-02 仅规定「室温复温」，未规定具体时间范围',
'不同班次执行差异未被月度审计发现'
]
}
],
machine: [
{
text: '仪器光路系统灵敏度随累计运行时长衰减',
subCauses: [
'光源灯泡累计使用已达 8,000 h，逼近厂商建议更换上限 10,000 h',
'PM 计划 PM-COAG-2025 中无光路灵敏度校验项'
]
},
{
text: '反应杯温控模块温度偏差 ±0.5°C 超出凝血反应敏感阈值（±0.3°C）',
subCauses: [
'温控校准周期为 12 个月，实际已执行 14 个月未校准'
]
}
],
material: [
{
text: '新批次凝血激活试剂（批号 RPT-2026-02）磷脂成分与旧批次配方存在差异',
subCauses: [
'供应商原料来源地由美国变更为德国，未随批次说明书披露',
'实验室无批次间比对 SOP 要求，直接开封使用'
]
},
{
text: '标本采集管抗凝剂（枸橼酸钠）浓度：3.2% 与 3.8% 两种混用',
subCauses: [
'采购未锁定单一供应商，两家供货浓度不同',
'混用对 PT 结果影响未被识别为风险（偏差约 0.6 秒）'
]
}
],
method: [
{
text: 'PT 测定启动时间不一致：标本注入到开始计时的延迟时间波动',
subCauses: [
'仪器自动启动与手工启动模式混用，手工启动滞后 0.5-1 秒',
'操作指引未规定使用同一种启动模式'
]
},
{
text: '质控品检测频率不足：仅每日 1 次晨间高值质控',
subCauses: [
'现行 SOP 要求每日 1 次质控，不符合 CLSI C24 每分析批至少 1 次的要求',
'无法识别日内漂移，当日偏差到下午才被发现'
]
}
],
environment: [
{
text: '实验室温度冬季低至 18°C，低于试剂说明书要求的 20-25°C',
subCauses: [
'空调设定与实际工作区温度存在 3-4°C 差异（传感器位于回风口）',
'温度记录仅覆盖储存区冰箱温度，不覆盖工作台面操作区'
]
}
],
measurement: [
{
text: '室间质评靶值源自参考实验室光学法平台，与本机磁珠法存在方法学偏差',
subCauses: [
'参考实验室使用光学法，本机使用磁珠法，两种方法固有偏差约 0.8-1.2 秒',
'室间质评报告中未注明靶值平台与方法的匹配一致性'
]
},
{
text: '内部质控图使用 2024 年度固定均值靶值，未按 WS/T 641 要求动态更新',
subCauses: [
'质控规则规定每季度重新评估均值，实际自 2024 年起未执行',
'旧靶值已不代表仪器当前状态，偏差累计约 0.5 秒'
]
}
]
}
}
},

'fishbone-infusion-set': {
_format: 'tool-problem-analysis/v1',
menuLabel: '鱼骨图: 输液器滴斗漏液',
title: '一次性输液器滴斗与导管处漏液率超标',
phenomenon:
'一次性使用输液器成品抽检发现滴斗与导管连接处漏液率达 8.5%（从 5.2% 逐批恶化至 10.3%），涉及 2 条产线 4 个批次',
severity: 'critical',
time: '2026-04-10T14:30',
discoverySource: 'final-inspection',
expectedState: '正压 20 kPa 持续 15 秒无泄漏，漏液率 ≤1%',
expectedSource: 'regulation',
expectedDetail: 'GB 8368-2018 一次性使用输液器 / YY/T 0286.1-2017 医用输液器具标准',
trend: 'gradual',
containment: '已隔离 4 个批次全部成品，启动 100% 全检，暂停问题产线生产',
fishboneData: {
problem: '一次性输液器滴斗与导管处漏液率超标',
phenomenon:
'一次性使用输液器成品抽检发现滴斗与导管连接处漏液率达 8.5%，涉及 2 条产线 4 个批次',
savedAt: '2026-04-10T16:00:00.000Z',
importedContext:
'问题标题：一次性输液器滴斗与导管处漏液率超标\n' +
'问题现象：一次性使用输液器成品抽检发现滴斗与导管连接处漏液率达 8.5%\n' +
'严重度：严重\n' +
'发生时间：2026-04-10T14:30\n' +
'发现方式：成品检验\n' +
'期望值：正压 20 kPa 持续 15 秒无泄漏，漏液率 ≤1%\n' +
'趋势：渐变\n' +
'临时措施：已隔离 4 个批次全部成品，启动 100% 全检',
theme: 'premium',
categories: {
man: [
{
text: '超声焊接操作员更换后未进行上岗资质确认',
subCauses: [
'新员工 OJT 仅 3 天，超声焊接参数设定培训记录缺失',
'班组长认为「有经验员工带」即可，无书面技能评估表'
]
},
{
text: '来料检验员对滴斗壁厚测量位置执行不一致',
subCauses: [
'检验规程 IQC-INF-023 图示不清晰，标注测量位置模糊',
'不同班次对同一批次的壁厚测量结果差异最大达 0.08 mm'
]
}
],
machine: [
{
text: '2 号产线超声焊接机振幅传感器漂移，实际输出振幅低于设定值 12%',
subCauses: [
'上次维护记录为 8 个月前，超出半年度校验周期（PM-PLAN-2025 规定每 6 个月）',
'设备台账中振幅校准采用人工读数方式，无自动记录和超差报警'
]
},
{
text: '模具冷却水道局部堵塞导致导管端口成型温度不均匀',
subCauses: [
'冷却水未经软化处理，钙含量 180 ppm 导致结垢（限值 50 ppm）',
'PM 计划中无水路水质监测项'
]
}
],
material: [
{
text: '滴斗 PVC 原料新批次（批号 PVC-2026-01）增塑剂含量变更，熔点升高约 3°C',
subCauses: [
'供应商 PPAP 文件中未声明配方微调（DHEP 含量从 32% 降至 28%）',
'来料检验项目仅包括密度和透光率，无 DSC 熔点复测'
]
},
{
text: '导管与滴斗材质热膨胀系数差异在新原料组合下超出配合设计容差',
subCauses: [
'新 PVC 原料热膨胀系数 195 ppm/°C，原设计容差基于 170 ppm/°C 计算',
'设计变更验证报告未覆盖新原料组合的热配合验证'
]
}
],
method: [
{
text: '超声焊接参数（振幅、压力、焊接时间）未随原料批次变更进行再验证',
subCauses: [
'工艺文件 WI-INF-045 第 4.2 节规定「材料变更须重新验证」但无触发流程',
'物料变更通知未同步抄送工艺工程部门'
]
},
{
text: '成品密封性检验抽样方案未覆盖当前漏液风险水平（AQL=1.5，当下漏液率 8.5%）',
subCauses: [
'抽样方案基于历史漏液率 <1% 制定，未建立抽样方案再评估触发条件'
]
}
],
environment: [
{
text: '车间相对湿度超出规定范围（实测 72%，规定 ≤60%），PVC 吸湿影响焊接强度',
subCauses: [
'除湿机过滤网 6 个月未更换，实测除湿效率较新机下降 40%',
'环境监控记录仅每日一次，未覆盖全天波动'
]
}
],
measurement: [
{
text: '密封性检测台压力表精度 ±2 kPa，无法可靠判断 20 kPa ±1 kPa 临界值',
subCauses: [
'检测设备上次校准为 14 个月前，校准周期规定为 12 个月',
'校准证书已过期 2 个月，未触发设备停用流程'
]
}
]
}
}
},

'fta-ct-tube': {
_format: 'tool-problem-analysis/v1',
menuLabel: 'FTA: CT 球管高压打火',
title: '64排 CT 设备球管高压打火频发',
phenomenon:
'64 排 CT 设备近 30 天内发生 5 次球管高压打火故障（打火频率从最初每月 1 次增加到近期每周 1-2 次），每次导致扫描中断约 45 分钟',
severity: 'critical',
time: '2026-04-20T10:00',
discoverySource: 'in-process',
expectedState: '球管在额定工作范围内无打火现象，设备可用率 ≥98%',
expectedSource: 'regulation',
expectedDetail: 'IEC 60601-2-44:2009 (CT设备安全专用要求) / 厂商维护规格书',
trend: 'gradual',
containment: '已限制最大管电压至 120 kV，高 kV 协议改用其他 CT 设备分流',
ftaData: {
topEvent: {
id: 'FTA-1',
name: 'CT 球管高压打火',
boundary: 'CT 高压发生器 + X 射线球管组件，不含网络侧电源质量问题',
assumptions: '设备已按厂商规程完成上次年度 PM；供电电压波动 ≤±5%',
locked: true
},
rootId: 'FTA-1',
nodes: {
'FTA-1': {
id: 'FTA-1',
name: 'CT 球管高压打火',
description: '球管阴阳极之间发生高压击穿，产生电弧放电，导致扫描中断',
type: 'top',
gateType: 'OR',
gateReason: '高压打火可由绝缘失效或场致发射任一原因独立触发',
confidence: 1.0,
status: 'confirmed',
parentId: null,
children: ['FTA-2', 'FTA-3', 'FTA-4']
},
'FTA-2': {
id: 'FTA-2',
name: '阳极靶面受损导致场致发射增强',
description: '阳极靶面出现微裂纹和凹凸不平，在高电压下产生局部场致电子发射',
type: 'intermediate',
gateType: 'AND',
gateReason: '靶面微裂纹本身不足以打火，需配合高 kV 条件才触发场致发射击穿',
confidence: 0.85,
status: 'confirmed',
parentId: 'FTA-1',
children: ['FTA-5', 'FTA-6']
},
'FTA-3': {
id: 'FTA-3',
name: '球管内真空度下降',
description: '球管内部真空度劣化，残余气体分子在高压下电离导致打火',
type: 'intermediate',
gateType: 'OR',
gateReason: '陶瓷外壳微裂纹或使用寿命末期均可独立导致真空度下降',
confidence: 0.75,
status: 'confirmed',
parentId: 'FTA-1',
children: ['FTA-7', 'FTA-8']
},
'FTA-4': {
id: 'FTA-4',
name: '高压绝缘油老化或含气泡',
description: '绝缘油介电强度下降或油中气泡在高压下发生局部放电',
type: 'intermediate',
gateType: 'OR',
gateReason: '油质劣化或气泡混入均可独立降低绝缘耐受电压',
confidence: 0.7,
status: 'confirmed',
parentId: 'FTA-1',
children: ['FTA-9', 'FTA-10']
},
'FTA-5': {
id: 'FTA-5',
name: '阳极累计负荷超出球管额定热容量（HU）限值',
description: '连续高负荷扫描导致阳极靶面热累积超过设计限值 8 MHU，产生热疲劳微裂纹',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.9,
status: 'confirmed',
parentId: 'FTA-2',
children: []
},
'FTA-6': {
id: 'FTA-6',
name: '使用高 kV（140 kV）大电流（≥300 mA）协议占比超过 60%',
description: '近 3 个月 140 kV / 300 mA 以上协议使用占比 63%，加速了靶面损伤',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.85,
status: 'confirmed',
parentId: 'FTA-2',
children: []
},
'FTA-7': {
id: 'FTA-7',
name: '球管陶瓷外壳出现微裂纹（旋转阳极机械应力疲劳）',
description: '长期高速旋转（10,800 rpm）导致陶瓷外壳连接处出现微米级裂纹',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.7,
status: 'confirmed',
parentId: 'FTA-3',
children: []
},
'FTA-8': {
id: 'FTA-8',
name: '球管累计曝光次数已达 450,000 次，逼近设计寿命上限 500,000 次',
description: '接近寿命末期的球管真空保持能力自然衰退，真空度逐步劣化',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.95,
status: 'confirmed',
parentId: 'FTA-3',
children: []
},
'FTA-9': {
id: 'FTA-9',
name: '绝缘油上次更换已超过 5 年，酸值检测超标',
description: '绝缘油酸值达 0.15 mg KOH/g，超过 0.1 mg KOH/g 的更换阈值',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.8,
status: 'confirmed',
parentId: 'FTA-4',
children: []
},
'FTA-10': {
id: 'FTA-10',
name: '高压电缆接头 O 型密封圈老化导致潮气侵入绝缘油',
description: '密封圈安装已 5 年未更换，弹性下降，需进一步检测确认气密性',
type: 'undeveloped',
gateType: null,
gateReason: '',
confidence: 0.6,
status: 'confirmed',
parentId: 'FTA-4',
children: []
}
},
settings: { maxDepth: 5, maxNodes: 50 },
viewMode: 'graphic',
metadata: {
createdAt: '2026-04-20T11:00:00.000Z',
updatedAt: '2026-04-20T14:00:00.000Z',
nodeCount: 10,
confirmedCount: 10,
aiCallCount: 1,
mode: 'auto',
problemTitle: '64排 CT 设备球管高压打火频发',
problemContext: 'CT 球管高压打火'
}
}
},

'fta-wbc-count': {
_format: 'tool-problem-analysis/v1',
menuLabel: 'FTA: WBC 计数假性升高',
title: '五分类血液分析仪 WBC 计数假性升高',
phenomenon:
'五分类血液分析仪 WBC 计数结果假性升高，约 15% 的标本偏高 >20%（受影响标本比例从最初 5% 逐步升高至 15%，偏高幅度也在增加）',
severity: 'critical',
time: '2026-05-05T08:30',
discoverySource: 'in-process',
expectedState: 'WBC 计数与手工镜检偏差 ≤±15%，符合 WS/T 406-2012 要求',
expectedSource: 'regulation',
expectedDetail: 'WS/T 406-2012 (常规项目分析质量要求) / 制造商 WBC 检测线性与精密度要求',
trend: 'gradual',
containment: '已启用 2 号仪器分担检测，对 1 号仪器 WBC 结果执行手工镜检复核',
ftaData: {
topEvent: {
id: 'FTA-1',
name: 'WBC 计数假性升高 >20%',
boundary: '五分类血液分析仪 1 号机光学检测单元，不含标本采集和运输环节',
assumptions: '仪器已完成当日质控且质控在控；使用 EDTA-K2 抗凝管',
locked: true
},
rootId: 'FTA-1',
nodes: {
'FTA-1': {
id: 'FTA-1',
name: 'WBC 计数假性升高 >20%',
description: '血液分析仪 WBC 通道计数结果显著高于真实值，手工镜检复核确认假性升高',
type: 'top',
gateType: 'OR',
gateReason: '假性升高可源于标本干扰物计入或仪器参数漂移，任一原因独立成立',
confidence: 1.0,
status: 'confirmed',
parentId: null,
children: ['FTA-2', 'FTA-3']
},
'FTA-2': {
id: 'FTA-2',
name: '标本中非 WBC 颗粒被误计入 WBC 通道',
description: '有核红细胞、血小板聚集或脂血颗粒体积落在 WBC 计数窗口内被分类为白细胞',
type: 'intermediate',
gateType: 'OR',
gateReason: '三种干扰物均可独立导致 WBC 计数偏高，相互不依赖',
confidence: 0.85,
status: 'confirmed',
parentId: 'FTA-1',
children: ['FTA-4', 'FTA-5', 'FTA-6']
},
'FTA-3': {
id: 'FTA-3',
name: '仪器光学检测单元参数漂移',
description: '激光光源衰减与分类阈值未联动校正，导致细胞分类边界偏移',
type: 'intermediate',
gateType: 'AND',
gateReason: '单一激光衰减不会导致误判，需阈值未更新同时发生才造成系统偏差',
confidence: 0.75,
status: 'confirmed',
parentId: 'FTA-1',
children: ['FTA-7', 'FTA-8']
},
'FTA-4': {
id: 'FTA-4',
name: '标本含有核红细胞（NRBC）未被 Diff 通道正确扣除',
description: 'NRBC 体积与淋巴细胞重叠，仪器将 NRBC 计入总 WBC 计数',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.8,
status: 'confirmed',
parentId: 'FTA-2',
children: []
},
'FTA-5': {
id: 'FTA-5',
name: '血小板聚集体（体积 7-35 fL）落入 WBC 计数窗口重叠区',
description: 'EDTA 依赖的假性血小板聚集形成 7-35 fL 颗粒，被误分类为 WBC',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.75,
status: 'confirmed',
parentId: 'FTA-2',
children: []
},
'FTA-6': {
id: 'FTA-6',
name: '严重脂血标本（TG >11 mmol/L）脂肪颗粒散射信号超阈值',
description: '乳糜血标本中脂肪颗粒散射光信号强度落入 WBC 分类散点图区域',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.7,
status: 'confirmed',
parentId: 'FTA-2',
children: []
},
'FTA-7': {
id: 'FTA-7',
name: '半导体激光器累计使用 >15,000 小时，输出功率衰减 18%',
description: '激光二极管老化导致激发光强度下降，细胞散射光信号信噪比降低',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.9,
status: 'confirmed',
parentId: 'FTA-3',
children: []
},
'FTA-8': {
id: 'FTA-8',
name: 'WBC 分类散点图阈值设定为出厂固定值，未随激光功率衰减进行自适应校正',
description: '阈值固定导致衰减后的弱信号被错误归入相邻分类区域',
type: 'basic',
gateType: null,
gateReason: '',
confidence: 0.85,
status: 'confirmed',
parentId: 'FTA-3',
children: []
}
},
settings: { maxDepth: 5, maxNodes: 50 },
viewMode: 'graphic',
metadata: {
createdAt: '2026-05-05T09:00:00.000Z',
updatedAt: '2026-05-05T12:00:00.000Z',
nodeCount: 8,
confirmedCount: 8,
aiCallCount: 1,
mode: 'auto',
problemTitle: '五分类血液分析仪 WBC 计数假性升高',
problemContext: 'WBC 计数假性升高'
}
}
}
};
})(typeof window !== 'undefined' ? window : {});
