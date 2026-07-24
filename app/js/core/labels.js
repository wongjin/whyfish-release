/**
 * labels.js — UI 显示标签映射表
 * 集中管理所有分类/状态/工具等标签的中文显示文本
 */
(function () {
  window.Labels = {
    severity: { minor: '轻微', major: '一般', critical: '严重' },
    source: {
      'customer-complaint': '客户投诉',
      'incoming-inspection': '来料检验',
      'in-process': '过程监控',
      'final-inspection': '成品检验',
      'internal-audit': '内部审核',
      'external-audit': '外部审核',
      abnormal: '异常事件',
      daily_check: '日常检查',
      preventive: '预防性维护',
      other: '其他'
    },
    status: { pending: '待分析', analyzing: '分析中', completed: '已完成' },
    tool: {
      '5-why': '5-Whys',
      '5why': '5 Whys 分析',
      fishbone: '鱼骨图',
      fta: '故障树',
      assessment: '问题评估（AI评估）'
    },
    depth: {
      surface: '表象',
      intermediate: '过渡',
      root: '根因',
      quick: '快速检查',
      standard: '标准 5 Whys',
      deep: '多工具深度分析'
    },
    // 混合字符串键和数字键，数字键用于数值型评分映射
    urgency: {
      high: '高',
      medium: '中',
      low: '低',
      5: '紧急',
      4: '高',
      3: '中',
      2: '低',
      1: '观察'
    },
    impact: {
      high: '高',
      medium: '中',
      low: '低',
      5: '全局',
      4: '产品线',
      3: '单批次',
      2: '样品',
      1: '潜在'
    },
    confidence: {
      confirmed: '已确认',
      suspected: '疑似',
      rejected: '已排除',
      high: '高',
      medium: '中',
      low: '低'
    }
  };
  Object.freeze(window.Labels);
})();
