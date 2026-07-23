/**
* fishbone-svg.js — 鱼骨图 SVG 生成引擎  v3.0 (融合版)
*
* 布局：v2 三列对称 + 大骨 45° 朝鱼头（标准石川图）
* 视觉：v1 拟物化鱼头/尾 + 文字防穿透垫片 + hover/click 交互
* 配色：去 AI 化低饱和度工业风色板
* 响应：自动检测容器宽度，小屏切换 compact 模式
*
* 依赖：fishbone.js（CATEGORIES, fishboneData）
* 被依赖：fishbone.js
*/
(function () {
'use strict';

/* ═══════════════════════════════════════════════════════════
* 常量 & 配置
* ═══════════════════════════════════════════════════════════ */

/** 6 分类：前 3 上方，后 3 下方 */
const CAT_ABOVE = ['man', 'machine', 'material'];
const CAT_BELOW = ['method', 'environment', 'measurement'];
const ALL_CATS = [...CAT_ABOVE, ...CAT_BELOW];

/** 3 列附着比例（在脊骨上的位置） */
const COL_FRACS = [0.22, 0.52, 0.88];

/** 标准石川图 45° 角 */
const BONE_ANGLE = Math.PI / 4;
const COS_A = Math.cos(BONE_ANGLE);
const SIN_A = Math.sin(BONE_ANGLE);

const PALETTE = {
man: '#c94b4b',
machine: '#3a78c4',
material: '#5b8c6e',
method: '#c98a3b',
environment: '#7a669e',
measurement: '#3b919e'
};

const THEMES = {
premium: {
bg: '#fbfaf7',
spine: '#2d2d2a',
headFill1: '#ffffff',
headFill2: '#f2f0eb',
headStroke: '#3a3a3c',
titleText: '#1c1c1e',
causeText: '#3a3a3c',
subText: '#6e6e73',
textBg: 'rgba(255,255,255,0.96)',
gridAlpha: '0.06',
palette: PALETTE
}
};

/* ═══════════════════════════════════════════════════════════
* 工具函数
* ═══════════════════════════════════════════════════════════ */

const svgEsc = window.esc;
if (typeof svgEsc !== 'function') {
throw new Error('[fishbone-svg.js] window.esc 未加载，请检查 ui-utils.js 加载顺序');
}

/** 根据最大像素宽度自动换行：支持中英文混排，内置孤字避让 */

function wrapTextByWidth(text, maxWidth, fontSize) {
return window.UIUtils.wrapTextByWidth(text, maxWidth, fontSize);
}

/** 读取 CSS 自定义属性 */
function cssVar(name) {
try {
return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
} catch {
return '';
}
}

/* ═══════════════════════════════════════════════════════════
* 分类元数据
* ═══════════════════════════════════════════════════════════ */

/** 5M1E 分类定义（权威数据源） */
const CATEGORIES = [
{ id: 'man', name: '人（Man）', icon: '‍ ', color: PALETTE.man },
{ id: 'machine', name: '机（Machine）', icon: ' ', color: PALETTE.machine },
{ id: 'material', name: '料（Material）', icon: ' ', color: PALETTE.material },
{ id: 'method', name: '法（Method）', icon: ' ', color: PALETTE.method },
{ id: 'environment', name: '环（Environment）', icon: ' ', color: PALETTE.environment },
{ id: 'measurement', name: '测（Measurement）', icon: ' ', color: PALETTE.measurement }
];

const FALLBACK_META = {
man: { label: '人员', engLabel: 'Man', icon: '👤' },
machine: { label: '仪器', engLabel: 'Machine', icon: ' ' },
material: { label: '试剂/耗材', engLabel: 'Material', icon: '📦' },
method: { label: '方法', engLabel: 'Method', icon: '🛠️' },
environment: { label: '环境', engLabel: 'Environment', icon: '🌍' },
measurement: { label: '测量', engLabel: 'Measurement', icon: '📏' }
};

/** 获取完整分类元数据 */
function getCatMeta(catId) {
const found = CATEGORIES.find((c) => c.id === catId);
if (found) return found;
return FALLBACK_META[catId] || { label: catId, engLabel: catId, icon: '📌' };
}

/** 获取分类中文标签 */
function getCatLabel(catId) {
const meta = getCatMeta(catId);
if (meta.name) {

return meta.name.split(/[（(]/)[0].trim();
}
return meta.label || catId;
}

/** 获取分类颜色（优先 CSS 变量 → 浅色色板） */
function getCatColor(catId) {
const v = cssVar('--color-' + catId);
if (v) return v;
return THEMES['premium'].palette[catId] || '#5a6673';
}

/** 获取分类图标 */
function getCatIcon(catId) {
const meta = getCatMeta(catId);
return meta.icon || '';
}

/* ═══════════════════════════════════════════════════════════
* 核心 SVG 生成
* ═══════════════════════════════════════════════════════════ */

/**
* 生成完整鱼骨图 SVG
* @param {object} data     fishboneData
* @param {object} [options]
* @param {boolean} [options.compact]  强制 compact 模式
* @returns {string}
*/
function generateSVG(data, options) {
options = options || {};
const compact = !!options.compact;

const uid = Math.random().toString(36).substring(2, 9);
const spineGradId = 'fbSpineGrad_' + uid;

/* ── 1. 主题 ──────────────────────────────────────────── */
const T = THEMES['premium'];

/* ── 2. 数据预处理 ──────────────────────────────────── */
const rawProblem = (data.problem || '问题原因分析').trim();
const problem =
Array.from(rawProblem).length > 45
? Array.from(rawProblem).slice(0, 42).join('') + '...'
: rawProblem;
const cats = data.categories || {};
function getCauses(catId) {
return (cats[catId] || []).filter((c) => {
return c && c.text && c.text.trim();
});
}
const catCauses = {};
ALL_CATS.forEach((id) => {
catCauses[id] = getCauses(id);
});

/* ── 3. 尺寸计算与自底向上布局引擎 ───────────────────────── */
let W = compact ? 920 : 1500;
const TITLE_H = compact ? 15 : 20;

const layoutData = {};
ALL_CATS.forEach((catId) => {
const causes = catCauses[catId];
const catL = {
causes: [],
maxSubExtraH: 0,
maxLeftOffset: 0,
bigBoneVertH: 0,
bigBoneLen: 0
};

const label = getCatLabel(catId);
const icon = getCatIcon(catId);
const displayLabel = ((icon && icon.trim() ? icon + ' ' : '') + label).trim();
const labelFs = compact ? 12 : 14;
const labelW = window.UIUtils.measureTextWidth(displayLabel, labelFs) + 16;

const causeLayouts = [];
let maxSubExtraH = 0;

causes.forEach((cause, ci) => {

const causeFs = compact ? 11 : 13;
const maxCauseW = compact ? 110 : 140;
const textLines = wrapTextByWidth(cause.text || '', maxCauseW, causeFs);
let maxLineW = 0;
textLines.forEach((l) => {
maxLineW = Math.max(maxLineW, window.UIUtils.measureTextWidth(l, causeFs));
});
const pad = 5;
const boxW = maxLineW + pad * 2;
const boxH = textLines.length * (compact ? 15 : 18) + pad * 2;

const subCauses = (cause.subCauses || []).filter((sc) => {
return sc && sc.trim();
});
const subLayouts = [];
const maxSubW = compact ? 90 : 110;
const subFs = compact ? 12 : 13;
const subLineH = compact ? 15 : 18;

let mbl_sub = 0;
let causeMaxSubExtraH = 0;
let currentLeftOffset = 35;

if (subCauses.length > 0) {
subCauses.forEach((sub) => {
const subLines = wrapTextByWidth(sub, maxSubW, subFs);
let subW = 0;
subLines.forEach((sl) => {
subW = Math.max(subW, window.UIUtils.measureTextWidth(sl, subFs));
});
const subLinesH = subLines.length * subLineH;
const subBoneLen = Math.max(compact ? 35 : 40, subLinesH + 8);

currentLeftOffset += subW;

subLayouts.push({
text: sub,
lines: subLines,
width: subW,
height: subLinesH,
boneLen: subBoneLen,
mountOffset: currentLeftOffset
});

currentLeftOffset += 25;

const subExtra = subBoneLen * SIN_A + subLinesH + 10;
causeMaxSubExtraH = Math.max(causeMaxSubExtraH, subExtra);
});

maxSubExtraH = Math.max(maxSubExtraH, causeMaxSubExtraH);

mbl_sub = currentLeftOffset + 10;
}

const mbl_primary = boxW + 30;
const mbl = Math.max(mbl_primary, mbl_sub);

causeLayouts.push({
text: cause.text,
textLines: textLines,
boxW: boxW,
boxH: boxH,
mbl: mbl,
subCauses: subLayouts,
causeMaxSubExtraH: causeMaxSubExtraH,
t: 0
});
});

catL.causes = causeLayouts;
catL.maxSubExtraH = maxSubExtraH;

const n = causes.length;
let finalH = compact ? 110 : 140;
const spine_padding = compact ? 35 : 45;
const pad_min = compact ? 35 : 50;
const dy_min = compact ? 22 : 30;

let tip_padding = 0;
if (n === 1) {
tip_padding = Math.max(pad_min, causeLayouts[0].causeMaxSubExtraH + 10);
finalH = Math.max(finalH, spine_padding + tip_padding);
causeLayouts[0].t = spine_padding / finalH;
} else if (n > 1) {
const dy = [];
for (let i = 0; i < n - 1; i++) {
const subExtra_i = causeLayouts[i].causeMaxSubExtraH;
const boxH_i = causeLayouts[i].boxH;
const boxH_next = causeLayouts[i + 1].boxH;
const val = Math.max(subExtra_i, boxH_i / 2) + boxH_next / 2 + 10;
dy.push(Math.max(dy_min, val));
}
tip_padding = Math.max(pad_min, causeLayouts[n - 1].causeMaxSubExtraH + 10);

let sum_dy = 0;
dy.forEach((d) => {
sum_dy += d;
});

finalH = Math.max(finalH, spine_padding + sum_dy + tip_padding);

causeLayouts[0].t = spine_padding / finalH;
for (let j = 1; j < n; j++) {
causeLayouts[j].t = causeLayouts[j - 1].t + dy[j - 1] / finalH;
}
}

catL.bigBoneVertH = finalH;
catL.bigBoneLen = finalH / SIN_A;

const bl = catL.bigBoneLen;
const labelOffset = bl * COS_A + labelW / 2 + 15;
let maxLeftOffset = labelOffset;

if (causes.length > 0) {
causeLayouts.forEach((causeL, ci) => {
const t = causeL.t;
const bx_offset = t * bl * COS_A;
const causeOffset = bx_offset + causeL.mbl + causeL.boxW + 10;
maxLeftOffset = Math.max(maxLeftOffset, causeOffset);
});
}

catL.maxLeftOffset = maxLeftOffset;
layoutData[catId] = catL;
});

const colLeftOffsets = [0, 1, 2].map((colIdx) => {
const aboveCat = CAT_ABOVE[colIdx];
const belowCat = CAT_BELOW[colIdx];
return Math.max(layoutData[aboveCat].maxLeftOffset, layoutData[belowCat].maxLeftOffset);
});

const spineX1 = compact ? 45 : 80;
let spineXEnd = W - (compact ? 155 : 210);
let spineLen = spineXEnd - spineX1;

const defaultFracs = COL_FRACS;
let attachXs = defaultFracs.map((f) => {
return Math.round(spineX1 + spineLen * f);
});

const adjustedXs = [0, 0, 0];
adjustedXs[0] = Math.max(attachXs[0], spineX1 + colLeftOffsets[0] + 10);
adjustedXs[1] = Math.max(attachXs[1], adjustedXs[0] + colLeftOffsets[1] + 25);
adjustedXs[2] = Math.max(attachXs[2], adjustedXs[1] + colLeftOffsets[2] + 25);

if (adjustedXs[2] > spineXEnd - 20) {
const neededEnd = adjustedXs[2] + 20;
const diff = neededEnd - spineXEnd;
W += diff;
spineXEnd = neededEnd;
spineLen = spineXEnd - spineX1;

attachXs = defaultFracs.map((f) => {
return Math.round(spineX1 + spineLen * f);
});
adjustedXs[0] = Math.max(attachXs[0], spineX1 + colLeftOffsets[0] + 10);
adjustedXs[1] = Math.max(attachXs[1], adjustedXs[0] + colLeftOffsets[1] + 25);
adjustedXs[2] = Math.max(attachXs[2], adjustedXs[1] + colLeftOffsets[2] + 25);
}
attachXs = adjustedXs;

let maxBigBoneH = 0;
ALL_CATS.forEach((catId) => {
maxBigBoneH = Math.max(maxBigBoneH, layoutData[catId].bigBoneVertH);
});

const HALF_H = Math.max(compact ? 150 : 180, maxBigBoneH + (compact ? 25 : 35));
const H = TITLE_H + HALF_H * 2;
const spineY = TITLE_H + HALF_H;

/* ═══════════════════════════════════════════════════════
* 4. SVG 拼接
* ═══════════════════════════════════════════════════════ */
let s = '';

s +=
'<svg xmlns="http://www.w3.org/2000/svg" ' +
'viewBox="0 0 ' +
W +
' ' +
H +
'" preserveAspectRatio="xMidYMid meet" ' +
'width="100%" height="100%" ' +
"font-family=\"Inter,'Noto Sans SC','Segoe UI',sans-serif\" " +
'style="background-color:' +
T.bg +
';transition:background-color 0.3s">';

s += '<defs>';

s +=
'<linearGradient id="' +
spineGradId +
'" x1="0%" y1="0%" x2="100%" y2="0%">' +
'<stop offset="0%" stop-color="' +
T.spine +
'" stop-opacity="0.6"/>' +
'<stop offset="10%" stop-color="' +
T.spine +
'" stop-opacity="1"/>' +
'<stop offset="90%" stop-color="' +
T.spine +
'" stop-opacity="1"/>' +
'<stop offset="100%" stop-color="' +
T.spine +
'" stop-opacity="0.7"/>' +
'</linearGradient>';

s += '</defs>';

s += '<rect width="' + W + '" height="' + H + '" fill="' + T.bg + '" rx="16"/>';

const gridStep = compact ? 60 : 80;
for (let gx = spineX1; gx < spineXEnd; gx += gridStep) {
s +=
'<line x1="' +
gx +
'" y1="' +
TITLE_H +
'" x2="' +
gx +
'" y2="' +
(H - TITLE_H) +
'" ' +
'stroke="' +
T.spine +
'" stroke-width="0.5" opacity="' +
T.gridAlpha +
'"/>';
}

/* ═══════════════════════════════════════════════════════
* 5. 绘制 6 个分类（大骨 + 中骨 + 小骨）
* ═══════════════════════════════════════════════════════ */
const catLayout = [
['man', 0, true],
['machine', 1, true],
['material', 2, true],
['method', 0, false],
['environment', 1, false],
['measurement', 2, false]
];

catLayout.forEach((entry) => {
const catId = entry[0];
const colIdx = entry[1];
const isAbove = entry[2];

const color = getCatColor(catId);
const label = getCatLabel(catId);
const icon = getCatIcon(catId);
const sign = isAbove ? -1 : 1;

const catL = layoutData[catId];
const causes = catL.causes;

const ax = attachXs[colIdx];
const ay = spineY;
const tx = Math.round(ax - catL.bigBoneLen * COS_A);
const ty = Math.round(spineY + sign * catL.bigBoneVertH);

s +=
'<g class="fishbone-cat-group" id="svg-group-' +
catId +
'" ' +
'data-action="focus-svg-group" data-cat="' +
catId +
'">';

s +=
'<circle cx="' +
ax +
'" cy="' +
ay +
'" r="4.5" ' +
'fill="' +
T.bg +
'" stroke="' +
color +
'" stroke-width="2.5"/>';

s +=
'<line x1="' +
ax +
'" y1="' +
ay +
'" x2="' +
tx +
'" y2="' +
ty +
'" ' +
'stroke="' +
color +
'" stroke-width="3.2" stroke-linecap="round" opacity="0.85" ' +
'class="fishbone-big-bone"/>';

s +=
'<circle cx="' +
tx +
'" cy="' +
ty +
'" r="3.5" ' +
'fill="' +
color +
'" stroke="' +
T.bg +
'" stroke-width="1.5"/>';

const labelFs = compact ? 12 : 14;
const displayLabel = ((icon && icon.trim() ? icon + ' ' : '') + label).trim();
const labelW = window.UIUtils.measureTextWidth(displayLabel, labelFs) + 16;
const labelH = labelFs + 12;
const labelGap = compact ? 12 : 16;
const labelCY = ty + sign * labelGap;
const labelX = tx - labelW / 2;
const labelY = labelCY - labelH / 2;

const pillRx = compact ? 6 : 10;
s +=
'<rect x="' +
labelX +
'" y="' +
labelY +
'" width="' +
labelW +
'" height="' +
labelH +
'" ' +
'rx="' +
pillRx +
'" fill="' +
color +
'" opacity="0.1" ' +
'stroke="' +
color +
'" stroke-width="1.2" class="fishbone-label-bg"/>';
s +=
'<text x="' +
tx +
'" y="' +
labelCY +
'" text-anchor="middle" ' +
'font-size="' +
labelFs +
'" font-weight="700" fill="' +
color +
'" ' +
'dominant-baseline="middle" class="fishbone-label-text">' +
svgEsc(displayLabel) +
'</text>';

if (causes.length > 0) {
causes.forEach((causeL, ci) => {
const t = causeL.t;

const bx = Math.round(ax + (tx - ax) * t);
const by = Math.round(ay + (ty - ay) * t);

const mbl = causeL.mbl;
const mx = bx - mbl;
const my = by;

s +=
'<circle cx="' + bx + '" cy="' + by + '" r="2.5" fill="' + color + '" opacity="0.7"/>';

s +=
'<line x1="' +
bx +
'" y1="' +
by +
'" x2="' +
mx +
'" y2="' +
my +
'" ' +
'stroke="' +
color +
'" stroke-width="1.8" stroke-linecap="round" opacity="0.72"/>';

s += '<circle cx="' + mx + '" cy="' + my + '" r="2" fill="' + color + '" opacity="0.5"/>';

const boxW = causeL.boxW;
const boxH = causeL.boxH;
const boxX = mx - boxW - 6;
const boxY = my - boxH / 2;

s +=
'<rect x="' +
boxX +
'" y="' +
boxY +
'" width="' +
boxW +
'" height="' +
boxH +
'" ' +
'rx="6" fill="' +
T.textBg +
'" stroke="' +
color +
'" stroke-width="0.5" opacity="0.95"/>';

const causeFs = compact ? 11 : 13;
const lineH = compact ? 15 : 18;
const causeTextX = boxX + 5;
causeL.textLines.forEach((ln, li) => {
const textY = my + (li - (causeL.textLines.length - 1) / 2) * lineH;
s +=
'<text x="' +
causeTextX +
'" y="' +
textY +
'" text-anchor="start" ' +
'font-size="' +
causeFs +
'" font-weight="500" fill="' +
T.causeText +
'" ' +
'dominant-baseline="middle">' +
svgEsc(ln) +
'</text>';
});

if (causeL.subCauses.length > 0) {
causeL.subCauses.forEach((subL, si) => {
const sx = Math.round(bx - subL.mountOffset);
const sy = my;

const sx2 = Math.round(sx - subL.boneLen * COS_A);
const sy2 = Math.round(sy + sign * subL.boneLen * SIN_A);

s +=
'<line x1="' +
sx +
'" y1="' +
sy +
'" x2="' +
sx2 +
'" y2="' +
sy2 +
'" ' +
'stroke="' +
color +
'" stroke-width="1.2" stroke-linecap="round" ' +
'stroke-dasharray="3,2" opacity="0.5"/>';

s +=
'<circle cx="' +
sx2 +
'" cy="' +
sy2 +
'" r="1.5" fill="' +
color +
'" opacity="0.35"/>';

const subFs = compact ? 12 : 13;
const subLineH = compact ? 15 : 18;

subL.lines.forEach((sln, sli) => {
const subY = sy2 + (sli - (subL.lines.length - 1) / 2) * subLineH;
s +=
'<text x="' +
(sx2 + 8) +
'" y="' +
subY +
'" text-anchor="start" ' +
'font-size="' +
subFs +
'" fill="' +
T.subText +
'" ' +
'dominant-baseline="middle">' +
svgEsc(sln) +
'</text>';
});
});
}
});
}

s += '</g>';
});

s +=
'<line x1="' +
spineX1 +
'" y1="' +
spineY +
'" x2="' +
spineXEnd +
'" y2="' +
spineY +
'" ' +
'stroke="' +
T.spine +
'" stroke-width="4" stroke-linecap="round"/>';

attachXs.forEach((ax) => {
s +=
'<circle cx="' +
ax +
'" cy="' +
spineY +
'" r="4.5" ' +
'fill="' +
T.bg +
'" stroke="' +
T.spine +
'" stroke-width="2.5" opacity="0.6"/>';
});

const tailX = spineX1;
if (!compact) {
s +=
'<path d="M ' +
tailX +
' ' +
spineY +
' L ' +
(tailX - 55) +
' ' +
(spineY - 60) +
' L ' +
(tailX - 35) +
' ' +
spineY +
' L ' +
(tailX - 55) +
' ' +
(spineY + 60) +
' Z" fill="none" stroke="' +
T.spine +
'" stroke-width="4" stroke-linejoin="round"/>';
} else {

s +=
'<path d="M ' +
tailX +
' ' +
spineY +
' L ' +
(tailX - 28) +
' ' +
(spineY - 20) +
' L ' +
(tailX - 28) +
' ' +
(spineY + 20) +
' Z" fill="none" stroke="' +
T.spine +
'" stroke-width="4" stroke-linejoin="round"/>';
}

s += '<circle cx="' + tailX + '" cy="' + spineY + '" r="5" fill="' + T.spine + '"/>';
s += '<circle cx="' + tailX + '" cy="' + spineY + '" r="2" fill="' + T.bg + '"/>';

const headX = spineXEnd + (compact ? 8 : 15);
const headW = compact ? 130 : 170;
const headH = compact ? 80 : 100;
const headCX = headX + headW / 2;
const headCY = spineY;
const headY = headCY - headH / 2;

s +=
'<polygon points="' +
spineXEnd +
',' +
(spineY - 10) +
' ' +
spineXEnd +
',' +
(spineY + 10) +
' ' +
(spineXEnd + 14) +
',' +
spineY +
'" ' +
'fill="' +
T.headStroke +
'"/>';

s += '<g transform="translate(' + headX + ',' + headY + ')">';
const headRx = compact ? 16 : 24;
s +=
'<rect x="0" y="0" width="' +
headW +
'" height="' +
headH +
'" rx="' +
headRx +
'" fill="' +
T.headFill1 +
'" stroke="' +
T.headStroke +
'" stroke-width="2.5"/>';

const gillX = compact ? 16 : 20;
const gillTop = compact ? 18 : 24;
const gillBot = headH - (compact ? 18 : 24);
const gillMid = headH / 2;
s +=
'<path d="M ' +
gillX +
' ' +
gillTop +
' Q ' +
(gillX + 16) +
' ' +
gillMid +
' ' +
gillX +
' ' +
gillBot +
'" ' +
'stroke="' +
T.headStroke +
'" stroke-width="2" fill="none" opacity="0.2" stroke-linecap="round"/>';

const eyeX = headW - (compact ? 28 : 36);
const eyeY = compact ? 22 : 30;
const eyeR = compact ? 7 : 8;
s +=
'<circle cx="' +
eyeX +
'" cy="' +
eyeY +
'" r="' +
eyeR +
'" fill="' +
T.headStroke +
'" opacity="0.1"/>';
s +=
'<circle cx="' +
eyeX +
'" cy="' +
eyeY +
'" r="' +
eyeR / 2 +
'" fill="' +
T.headStroke +
'"/>';

s += '</g>';

const headMaxW = compact ? 80 : 115;
const headFontSize = compact ? 11 : 13;
const headLines = wrapTextByWidth(problem, headMaxW, headFontSize);
const headLineH = compact ? 16 : 19;
headLines.forEach((ln, i) => {
const ly = headCY + (i - (headLines.length - 1) / 2) * headLineH;
s +=
'<text x="' +
headCX +
'" y="' +
ly +
'" text-anchor="middle" ' +
'font-size="' +
headFontSize +
'" font-weight="700" fill="' +
T.titleText +
'" ' +
'dominant-baseline="middle">' +
svgEsc(ln) +
'</text>';
});

s += '</svg>';
return s;
}

/* ═══════════════════════════════════════════════════════════
* 公开 API
* ═══════════════════════════════════════════════════════════ */

/** 渲染鱼骨图到 #fishboneSvgWrapper，自动检测 compact 模式 */
function render(data, container) {
const wrapper = container || document.getElementById('fishboneSvgWrapper');
if (!wrapper) {
console.warn('[FishboneSVG] container not found');
return;
}

const compact = wrapper.clientWidth > 0 && wrapper.clientWidth < 1024;
wrapper.innerHTML = generateSVG(data, { compact: compact });

if (!wrapper.dataset.svgDelegation) {
wrapper.dataset.svgDelegation = '1';
wrapper.addEventListener('click', (e) => {
const el = e.target.closest('[data-action="focus-svg-group"]');
if (el) focusSvgGroup(el.dataset.cat);
});
}
}

/** 联动交互：点击 SVG 大骨 → 聚焦主表单对应录入卡片 */
function focusSvgGroup(catId) {
const card = document.querySelector(`.fishbone-category[data-cat="${catId}"]`);
if (!card) return;

const catCards = document.querySelectorAll('.fishbone-category');
catCards.forEach((el) => {
el.classList.remove('fishbone-highlight');

el.style.removeProperty('box-shadow');
el.style.removeProperty('border-color');
});

card.classList.add('fishbone-highlight');
card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

if (window.showToast) {
window.showToast('已聚焦：' + getCatLabel(catId), 'info');
}
}

/** 导出 SVG 文件 */
function exportSVG() {
const svgEl = document.querySelector('#fishboneSvgWrapper svg');
if (!svgEl) {
if (window.showToast) window.showToast('请先生成鱼骨图', 'error');
return;
}
const svgStr = new XMLSerializer().serializeToString(svgEl);
const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
window.UIUtils.saveExportBlob(
blob,
'鱼骨根因分析图_' + new Date().toISOString().slice(0, 10) + '.svg',
{
filterName: 'SVG 图片',
extensions: ['svg'],
successMessage: 'SVG 已导出'
}
);
}

/** 复制 SVG 源码到剪贴板 */
/* ═══════════════════════════════════════════════════════════
* 注册全局 API
* ═══════════════════════════════════════════════════════════ */
window.FishboneSVG = {
CATEGORIES: CATEGORIES,
render: render,
generateSVG: generateSVG,
exportSVG: exportSVG,
focusSvgGroup: focusSvgGroup
};
})();
