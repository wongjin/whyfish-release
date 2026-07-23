/**
* WhyFish 方法知识库
*
* 只收录与当前产品工作流直接相关的方法：问题定义、原因发散、
* 因果分析和证据验证。纯静态数据，无运行时写入。
*/

(function () {
'use strict';

const TOOL_CATEGORIES = {
define: {
name: '定义问题',
description: '先把事实、范围和影响说清楚，再开始原因分析'
},
explore: {
name: '发散原因',
description: '系统寻找值得调查的潜在原因，避免过早锁定答案'
},
analyze: {
name: '建立因果逻辑',
description: '沿因果链或逻辑组合逐层分析失效如何发生'
},
verify: {
name: '验证与收敛',
description: '用事实和试验排除猜想，确认结论的证据强度'
}
};

const QUALITY_TOOLS = {
'5w2h': {
id: '5w2h',
name: '5W2H 问题定义',
category: 'define',
tags: ['分析前置', '事实整理', '范围界定'],
description:
'从何事、何地、何时、何人、为何重要、如何发现和影响多大七个方面整理已知事实，形成可调查的问题陈述。',
source: '参考：ASQ 问题解决资源中的 5W2H 方法',
whenToUse: [
'问题描述只有“异常、失败、效果不好”等模糊表述时',
'客户投诉、偏差或现场事件需要交接给调查团队时',
'准备启动 5 Whys、鱼骨图或 FTA，但分析边界尚不清楚时'
],
notFor: [
'不能单独用于确定根本原因',
'不能代替风险分级、紧急处置或遏制措施',
'不能用尚未验证的“为什么”填补未知信息'
],
keyPoints: [
'何事（What）：写清实际结果与要求、标准或预期之间的差异',
'何地（Where）：记录发生位置，也记录未发生的位置，帮助后续分层比较',
'何时（When）：记录首次发现、发生频率、时间趋势和相关班次或批次',
'何人（Who）：记录发现者、受影响对象和相关岗位，不把人员姓名当作原因',
'为何重要（Why）：说明安全、质量、交付、成本或合规影响，不在此阶段猜根因',
'如何发现（How）：记录检测方法、报警、审核或客户反馈渠道',
'影响多大（How many／How much）：尽量量化数量、比例、批次、时间或成本',
'对未知信息明确标记“待确认”，不要用推测补齐表格'
],
pitfalls: [
'把解决方案或原因写进问题陈述，使后续调查带有预设结论',
'只描述单个不良品，不说明总体数量、批次和影响范围',
'把“操作员未按要求执行”当作事实，却没有记录或现场证据'
],
relationships: [
{ tool: 'fishbone', label: '后续发散', description: '原因范围未知时，用鱼骨图建立调查清单' },
{ tool: '5-why', label: '后续深挖', description: '已知具体失效路径时，用 5 Whys 逐层追问' },
{ tool: 'fta', label: '后续建模', description: '顶事件涉及多条件组合时，用 FTA 建立逻辑结构' }
]
},

fishbone: {
id: 'fishbone',
name: '鱼骨图（因果图）',
category: 'explore',
toolPage: 'page-analysis',
toolPanel: 'tool-fishbone',
tags: ['原因发散', '跨职能', '调查清单'],
description:
'围绕明确的问题现象，按人员、设备、材料、方法、环境、测量等维度系统提出潜在原因，用于拓宽调查范围。',
source: '参考：ASQ Cause-and-Effect Diagram／Fishbone Diagram',
whenToUse: [
'原因范围未知，团队容易只盯住第一个解释时',
'问题可能同时受到人员、设备、材料、方法、环境或测量影响时',
'需要跨职能团队共同形成现场调查清单时'
],
notFor: [
'鱼骨图列出的是待验证假设，不是已经确认的原因',
'不能通过投票或出现次数直接认定根本原因',
'复杂的条件组合和防线失效更适合使用 FTA'
],
keyPoints: [
'先使用 5W2H 明确鱼头所代表的问题现象和分析边界',
'5M1E 只是提示框架；可根据业务过程调整分类，不必为了填满而凑原因',
'原因描述应具体到可观察、可测量或可查证的状态',
'把事实、推测和待确认信息明确区分',
'为重点原因补充验证方法、所需证据和判定标准',
'验证后标记为“支持、排除或证据不足”，而不是删除不同意见'
],
pitfalls: [
'写“人员粗心、管理不到位、培训不足”等无法直接验证的概括词',
'把同一原因换几个说法放进不同分类，造成虚假的原因数量',
'完成图形后立即制定措施，没有经过数据、记录、现场或试验验证'
],
relationships: [
{ tool: '5w2h', label: '前置定义', description: '先确认问题边界，避免分析对象在讨论中变化' },
{ tool: '5-why', label: '选择后深挖', description: '对有证据支持的关键分支继续追问因果链' },
{ tool: 'cause-verification', label: '验证收敛', description: '把候选原因转成可验证假设并记录结论' }
]
},

'5-why': {
id: '5-why',
name: '5 Whys（五问法）',
category: 'analyze',
toolPage: 'page-analysis',
toolPanel: 'tool-5why',
tags: ['因果链', '逐层追问', '根因分析'],
description:
'围绕一个具体问题反复追问“为什么”，把表面现象连接到可验证、可控制的物理、过程或系统原因；追问次数不要求恰好为五次。',
source: '参考：ASQ Five Whys and Five Hows',
whenToUse: [
'问题现象具体，且可能沿一条或少数几条因果路径解释时',
'现场、记录或数据能够支持逐层核对因果关系时',
'需要从直接原因继续追查发生原因和未被发现的原因时'
],
notFor: [
'原因范围完全未知时，应先用鱼骨图发散',
'多个条件通过与门、或门组合导致顶事件时，应优先考虑 FTA',
'仅凭时间先后或个人经验不能证明因果关系'
],
keyPoints: [
'每一层回答都写成可以核查的事实性陈述，并附上证据或待验证标记',
'当一个结果存在多个独立贡献原因时允许分支，不强行压成单链',
'用“因为 A，所以 B”正向检查，再用“如果没有 A，B 是否仍会发生”检验必要性',
'“人为失误”通常是继续调查任务设计、能力、环境、防错和监督条件的起点',
'同时考虑问题为什么发生，以及为什么现有控制没有及时发现或阻止',
'当原因已可验证、可采取控制措施，或证据不足无法继续时停止，不为凑满五层而追问'
],
pitfalls: [
'把同义改写当成更深一层原因',
'从结果直接跳到“管理不到位”，省略中间物理或流程机制',
'只保留支持既有判断的证据，忽略反例和替代解释',
'把纠正措施反推成原因，例如因为“需要培训”就认定根因是“培训不足”'
],
relationships: [
{ tool: '5w2h', label: '前置定义', description: '先确认问题陈述、范围和影响' },
{ tool: 'fishbone', label: '先发散后深挖', description: '原因未知时先建立候选原因清单' },
{ tool: 'cause-verification', label: '逐层验证', description: '为每个关键因果连接记录证据和反证' }
]
},

fta: {
id: 'fta',
name: 'FTA（故障树分析）',
category: 'analyze',
toolPage: 'page-analysis',
toolPanel: 'tool-fta',
tags: ['顶事件', '逻辑门', '系统失效'],
description:
'从一个定义清楚的顶事件出发，使用与门和或门逐层分解可能导致该事件的条件组合，形成可审查的故障逻辑。',
source: '主要依据：IEC 61025:2006 Fault Tree Analysis（现行稳定日期至 2029）',
whenToUse: [
'系统失效可能由多个条件组合、冗余失效或多道防线失效造成时',
'安全、可靠性或复杂设备问题需要明确单点故障和失效路径时',
'需要用统一逻辑说明顶事件如何由下层事件导致时'
],
notFor: [
'顶事件尚未定义清楚时，不应直接开始建树',
'只需开放式收集潜在原因时，鱼骨图成本更低',
'缺少失效率数据时仍可做定性分析，但不能给出未经支持的概率结论'
],
keyPoints: [
'顶事件应包含对象、失效状态、条件和边界，避免“系统异常”等宽泛表述',
'或门表示任一输入事件发生即可导致输出；与门表示全部输入事件共同发生才导致输出',
'每个逻辑门都记录选择依据，不能为了图形对称随意使用与门或或门',
'基本事件表示在本次分析范围内不再展开，不等于客观上不可继续分解',
'信息不足的分支标为“未展开事件”，不要把未知包装成已确认原因',
'检查重复事件、共同原因失效和系统边界外的依赖关系',
'定量分析前确认事件概率、独立性假设和数据适用性'
],
pitfalls: [
'把鱼骨图的分类枝条直接改画成故障树，却没有定义逻辑门',
'混淆与门和或门，使顶事件路径被严重夸大或遗漏',
'把所有叶节点都称为根本原因，未经过现场或数据验证',
'忽略共同原因，使表面独立的冗余防线被错误地当成真正独立'
],
relationships: [
{ tool: '5w2h', label: '前置定义', description: '用事实明确顶事件及系统边界' },
{ tool: '5-why', label: '末端深挖', description: '对需要继续调查的基本事件追问具体机制' },
{ tool: 'cause-verification', label: '事件验证', description: '验证关键事件、逻辑关系和共同原因假设' }
]
},

'cause-verification': {
id: 'cause-verification',
name: '原因验证与证据判定',
category: 'verify',
tags: ['证据', '反证', '结论收敛'],
description:
'把 5 Whys、鱼骨图或 FTA 中的候选原因转化为可检验假设，记录支持证据、反证和判定结果，避免把推测直接写成根本原因。',
source: 'WhyFish 综合实践条目；参考 ASQ 问题解决与根本原因分析原则',
whenToUse: [
'任何候选原因准备标记为根本原因之前',
'团队对原因存在分歧，需要用同一判定标准收敛时',
'纠正措施实施前，需要确认措施确实针对已证实原因时'
],
notFor: [
'不是新的头脑风暴工具，不能继续无限增加候选原因',
'相关性、单次巧合或权威意见不能单独作为因果证明',
'不能用“实施措施后问题没再发生”代替充分的效果验证'
],
keyPoints: [
'把原因写成可证伪假设：在明确条件下，原因存在时应观察到什么，原因不存在时又应看到什么',
'优先使用现场观察、原始记录、测量数据、复现实验或受控对比等直接证据',
'同时寻找反证和替代解释，避免只收集支持原判断的信息',
'记录证据来源、时间、样本范围、测量方法和适用边界',
'使用“支持、排除、证据不足、暂无法验证”四种状态，避免非黑即白',
'区分发生原因、流出原因以及使问题重复发生的系统条件',
'验证纠正措施时比较实施前后结果，并确认没有引入新的风险'
],
pitfalls: [
'证据只是“大家都这么认为”或“以前也发生过”',
'只验证原因存在，没有验证它与问题结果之间的联系',
'样本、时间范围或测量系统不足，却给出确定性结论',
'原因尚未证实就直接进入培训、修订文件或更换设备等措施'
],
relationships: [
{ tool: 'fishbone', label: '验证候选原因', description: '逐项收敛鱼骨图中的重点调查分支' },
{ tool: '5-why', label: '验证因果链', description: '检查每层回答及相邻节点之间的因果联系' },
{ tool: 'fta', label: '验证故障逻辑', description: '核对底事件、逻辑门和共同原因假设' }
]
}
};

const allTools = Object.values(QUALITY_TOOLS);
const toolsByCategory = {};
allTools.forEach((tool) => {
if (!toolsByCategory[tool.category]) toolsByCategory[tool.category] = [];
toolsByCategory[tool.category].push(tool);
});

function getToolById(toolId) {
return QUALITY_TOOLS[toolId] || null;
}

function getAllTools() {
return allTools;
}

function getToolsByCategory(category) {
return toolsByCategory[category] || [];
}

function validateKnowledgeBase(customTools) {
const targetTools = customTools || QUALITY_TOOLS;
const errors = [];
const warnings = [];
const toolIds = new Set(Object.keys(targetTools));
const validCategories = new Set(Object.keys(TOOL_CATEGORIES));
const requiredStringFields = ['id', 'name', 'category', 'description', 'source'];
const requiredArrayFields = ['tags', 'whenToUse', 'notFor', 'keyPoints', 'pitfalls', 'relationships'];

Object.entries(targetTools).forEach(([toolId, tool]) => {
if (!tool || typeof tool !== 'object') {
errors.push('[' + toolId + '] 工具数据必须是对象');
return;
}
if (tool.id !== toolId) errors.push('[' + toolId + '] id 与对象键不一致');
if (!validCategories.has(tool.category)) {
errors.push('[' + toolId + '] 无效 category: "' + tool.category + '"');
}
requiredStringFields.forEach((field) => {
if (typeof tool[field] !== 'string' || !tool[field].trim()) {
errors.push('[' + toolId + '] 缺少有效字符串字段: ' + field);
}
});
requiredArrayFields.forEach((field) => {
if (!Array.isArray(tool[field]) || tool[field].length === 0) {
errors.push('[' + toolId + '] 缺少非空数组字段: ' + field);
}
});
if ((tool.toolPage && !tool.toolPanel) || (!tool.toolPage && tool.toolPanel)) {
errors.push('[' + toolId + '] toolPage 与 toolPanel 必须同时提供');
}
(tool.relationships || []).forEach((relationship) => {
if (!toolIds.has(relationship.tool)) {
warnings.push('[' + toolId + '] 悬空引用: "' + relationship.tool + '"');
}
if (!relationship.label || !relationship.description) {
errors.push('[' + toolId + '] 工具关系必须包含 label 和 description');
}
});
});

if (errors.length) {
console.error('[QualityKnowledge] 校验发现 ' + errors.length + ' 个错误:');
errors.forEach((error) => console.error('  ❌ ' + error));
}
if (warnings.length) {
console.warn('[QualityKnowledge] 校验发现 ' + warnings.length + ' 个警告:');
warnings.forEach((warning) => console.warn('  ⚠️ ' + warning));
}
if (!errors.length && !warnings.length) {
console.debug('[QualityKnowledge] ✅ 知识库校验通过 (' + Object.keys(targetTools).length + ' 工具)');
}
return { errors: errors, warnings: warnings };
}

window.QualityToolKB = {
QUALITY_TOOLS: QUALITY_TOOLS,
TOOL_CATEGORIES: TOOL_CATEGORIES,
TOOLS: QUALITY_TOOLS,
CATEGORIES: TOOL_CATEGORIES,
getToolById: getToolById,
getAllTools: getAllTools,
getToolsByCategory: getToolsByCategory,
validate: validateKnowledgeBase
};
})();
