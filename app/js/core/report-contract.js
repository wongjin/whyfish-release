/**
 * report-contract.js - shared report envelope helpers.
 * Method-specific analysis sections remain owned by their respective tools.
 */
(function () {
  const REPORT_SCHEMA_VERSION = 2;
  const USAGE_DISCLAIMER =
    'WhyFish 用于辅助问题分析，内容仅作为分析线索，不应直接作为最终根因、质量决定或合规意见。请结合客观证据、适用程序和专业判断进行复核。';

  function buildActionItem(label, dueDate) {
    return `1. **[${label}]** - 责任人：待指定 | 完成时限：${dueDate} | 状态：未开始 | 验证方式：待指定\n`;
  }

  function buildCapaSection({ heading, dueDate, introduction = '' }) {
    let md = `${heading}\n\n`;
    if (introduction) md += `> ${introduction}\n\n`;
    md += `- **纠正（Correction）**：\n  ${buildActionItem('纠正措施描述', dueDate)}`;
    md += `- **纠正措施（Corrective Action）**：\n  ${buildActionItem('纠正措施描述', dueDate)}`;
    md += `- **预防措施（Preventive Action）**：\n  ${buildActionItem('预防措施描述', dueDate)}`;
    return md;
  }

  function buildMetadata({ sourceMode = 'local', model = '', usage = null, elapsedSeconds = null, durationMinutes = null, generatedAt = new Date().toISOString() } = {}) {
    const isAi = sourceMode === 'ai';
    const sourceLabel = isAi
      ? 'AI 智能分析'
      : sourceMode === 'example'
        ? '示例数据（本地结构化分析）'
        : '本地结构化分析（手动）';
    const tokenText = usage
      ? `提示 ${usage.prompt || 0} / 补全 ${usage.completion || 0} / 总计 ${usage.total || 0} tokens`
      : '0 tokens';
    const elapsed = isAi
      ? `~${elapsedSeconds == null ? '?' : elapsedSeconds} 秒`
      : `~${durationMinutes == null ? '?' : durationMinutes} 分钟`;
    const sourceDeclaration = isAi
      ? '本报告包含 AI 生成内容，可能存在遗漏、错误或不合理推断。'
      : sourceMode === 'example'
        ? '本报告基于内置示例数据生成，用于展示分析方法与报告结构，不代表实际调查结论。'
        : '本报告由本地结构化引擎生成，不包含大模型评估。';
    const declaration = `${sourceDeclaration}${USAGE_DISCLAIMER}`;

    return `\n\n---\n\n### 分析元数据\n` +
      `- **生成时间**：${String(generatedAt)}\n` +
      `- **分析类型**：${sourceLabel}\n` +
      `- **使用模型**：${isAi ? model || '未知模型' : '无'}\n` +
      `- **Tokens 消耗**：${isAi ? tokenText : '0 tokens'}\n` +
      `- **分析耗时**：${elapsed}\n` +
      `- **使用声明**：*${declaration}*\n`;
  }

  // Shared, deterministic statistics. Tool-specific metrics remain explicit to avoid false equivalence.
  function buildAnalysisStatistics({ nodeCount = 0, sourceMode = 'local', metrics = [] } = {}) {
    const generationLabel = sourceMode === 'ai'
      ? 'AI 智能生成'
      : sourceMode === 'example'
        ? '示例数据生成'
        : '手动数据生成';
    const rows = [['分析节点数', nodeCount], ...metrics, ['报告生成方式', generationLabel]];
    let md = '## 分析统计（系统计算）\n\n';
    rows.forEach(([label, value]) => {
      md += `- **${label}**：${value == null ? '未计算' : value}\n`;
    });
    return md + '\n';
  }

  function appendAnalysisStatistics(markdown, options) {
    const content = String(markdown || '');
    const statistics = buildAnalysisStatistics(options);
    const marker = '\n\n---\n\n### 分析元数据';
    const index = content.lastIndexOf(marker);
    return index >= 0
      ? content.slice(0, index).replace(/\s*$/, '') + '\n\n' + statistics + content.slice(index)
      : content.replace(/\s*$/, '') + '\n\n' + statistics;
  }

  // Largest-remainder allocation keeps rounded category percentages totaling 100.
  function allocatePercentages(counts) {
    const total = counts.reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
    if (total === 0) return counts.map(() => 0);

    const parts = counts.map((count, index) => {
      const exact = (Math.max(0, Number(count) || 0) / total) * 100;
      return { index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
    let remaining = 100 - parts.reduce((sum, part) => sum + part.value, 0);
    parts
      .slice()
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
      .slice(0, remaining)
      .forEach((part) => { parts[part.index].value += 1; });

    return parts.sort((a, b) => a.index - b.index).map((part) => part.value);
  }

  // AI reports must contain these core Markdown headings, but may add method-specific
  // analysis sections. Local deterministic reports are not required to mirror AI output.
  const AI_REPORT_REQUIREMENTS = {
    '5why': {
      title: '5 Whys 问题分析报告',
      sections: ['问题概述', '因果链概述', '根本原因判定', '纠正与预防措施', '后续行动项']
    },
    fishbone: {
      title: '鱼骨图问题分析报告',
      sections: ['问题概述', '5M1E 原因分布评估', '关键末端原因分析', '纠正与预防措施', '后续行动项']
    },
    fta: {
      title: 'FTA 故障树分析报告',
      sections: [
        '问题概述',
        '顶事件与系统边界',
        '最小割集分析',
        '关键底事件重要性排序',
        '纠正与预防措施',
        '后续行动项'
      ]
    }
  };

  function normalizeHeading(text) {
    return String(text || '')
      .replace(/^\s*\d+(?:\.\d+)*[.、)]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractMarkdownHeadings(markdown) {
    const headings = [];
    const lines = String(markdown || '').split(/\r?\n/);
    let inFence = false;
    lines.forEach((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!match) return;
      headings.push({ level: match[1].length, text: normalizeHeading(match[2]) });
    });
    return headings;
  }

  function headingMatches(actual, required) {
    return actual === required || actual.startsWith(required + ' ') || actual.startsWith(required + '(');
  }

  function validateAiReport(markdown, analysisType) {
    const content = String(markdown || '').trim();
    const requirement = AI_REPORT_REQUIREMENTS[analysisType];
    if (!requirement) return { valid: content.length > 0, missing: [] };

    const headings = extractMarkdownHeadings(content);
    const titleFound = headings.some(
      (heading) => heading.level === 1 && heading.text === requirement.title
    );
    const sectionHeadings = headings.filter((heading) => heading.level >= 2);
    const missing = [];
    if (!titleFound) missing.push('# ' + requirement.title);
    requirement.sections.forEach((required) => {
      if (!sectionHeadings.some((heading) => headingMatches(heading.text, required))) {
        missing.push(required);
      }
    });
    return { valid: content.length > 0 && missing.length === 0, missing };
  }

  window.ReportContract = Object.freeze({
    REPORT_SCHEMA_VERSION,
    USAGE_DISCLAIMER,
    buildActionItem,
    buildCapaSection,
    buildMetadata,
    buildAnalysisStatistics,
    appendAnalysisStatistics,
    allocatePercentages,
    validateAiReport
  });
})();
