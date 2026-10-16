/* Malaysia knowledge base: every rule carries country, year of assessment / effective year, who it applies to,
 * the rule, exceptions, an official source and the date we last checked it. Served to the page by build.py.
 * Figures must be updated per year; the UI always shows the year and source next to any number. */
(function (root) {
  'use strict';
  var CHECKED = '2026-10-16';
  var KB = {
    checked: CHECKED,
    country: 'MY',
    // Personal income tax reliefs, Year of Assessment 2025 (filed in 2026). Source: LHDN tax relief summary YA2025.
    taxReliefs: {
      ya: 2025, source: 'LHDN — Tax Relief for Resident Individual YA2025 (hasil.gov.my)', checked: CHECKED,
      items: [
        { key: 'self', name: '个人及受抚养亲属', cap: 9000, auto: true, note: '自动给予' },
        { key: 'spouse', name: '配偶（无收入）/ 赡养费', cap: 4000, note: '配偶没有收入或选择合并报税' },
        { key: 'child', name: '子女（18 岁以下）', cap: 2000, per: '每名', note: '18 岁以上在读大专 RM8,000' },
        { key: 'parentsMedical', name: '父母医疗、特殊需要及照护', cap: 8000, note: '含体检、疫苗、牙科上限见规定' },
        { key: 'medical', name: '自身、配偶、子女的严重疾病医疗', cap: 10000, note: '含体检 RM1,000、疫苗、牙科 RM1,000、心理咨询' },
        { key: 'lifeEpf', name: '人寿保险 + EPF', cap: 7000, note: '受雇者：EPF 最多 RM4,000 + 人寿 RM3,000；自雇可全额用于人寿或自愿 EPF' },
        { key: 'medicalIns', name: '教育及医药保险', cap: 3000 },
        { key: 'prs', name: '私人退休计划 PRS / 延期年金', cap: 3000, note: '至 YA2030' },
        { key: 'sspn', name: 'SSPN 教育储蓄（净存入）', cap: 8000 },
        { key: 'lifestyle', name: '生活方式（书、电脑、手机、网络、课程）', cap: 2500 },
        { key: 'sports', name: '运动器材、场地、比赛费、健身会员', cap: 1000 },
        { key: 'childcare', name: '托儿所 / 幼儿园学费（6 岁以下）', cap: 3000 },
        { key: 'breastfeeding', name: '哺乳器材（2 岁以下）', cap: 1000, note: '每两年一次' },
        { key: 'ev', name: '电动车充电设备 / 订阅', cap: 2500 },
        { key: 'disabled', name: '残障人士本人 / 配偶 / 子女', cap: 7000, note: '本人 RM7,000；残障子女 RM8,000 另加' },
        { key: 'socso', name: 'SOCSO / EIS 供款', cap: 350 },
        { key: 'housingLoanInterest', name: '首套住宅房贷利息（2025 起新规）', cap: 7000, note: '房价 ≤ RM500k 上限 RM7,000；RM500k–750k 上限 RM5,000；连续三年' }
      ]
    },
    // KWSP Retirement Income Adequacy framework (announced 2024, effective 2026): three savings levels at age 60.
    epf: {
      effective: 2026, source: 'KWSP — Retirement Income Adequacy (RIA) Framework', checked: CHECKED,
      tiers: [
        { key: 'basic', name: '基本', amount: 390000, monthly: 1300, note: '覆盖基本生活开销约 20 年' },
        { key: 'adequate', name: '适足', amount: 650000, monthly: 2600, note: '合理生活水平' },
        { key: 'enhanced', name: '充裕', amount: 1300000, monthly: 5200, note: '较高生活品质' }
      ],
      contribution: { employee: 0.11, employerUnder60: 0.13, employerUnder60HighWage: 0.12, note: '月薪 ≤ RM5,000 雇主 13%，> RM5,000 雇主 12%；60 岁以上减半' },
      accounts: [['Akaun Persaraan', 0.75], ['Akaun Sejahtera', 0.15], ['Akaun Fleksibel', 0.10]],
      iSaraan: { incentive: 0.15, cap: 500, note: '自雇 i-Saraan：政府配对 15%，每年最高 RM500（至 2025 年政策），自愿缴可享税务减免' }
    },
    // Belanjawanku (EPF / SWRC) reference monthly budgets, Klang Valley 2024/25 edition (rounded).
    belanjawanku: {
      edition: '2024/25', source: 'KWSP Belanjawanku Expenditure Guide (Klang Valley)', checked: CHECKED,
      households: [
        { key: 'single', name: '单身（租房）', monthly: 2690 },
        { key: 'coupleNoKids', name: '夫妻无孩子', monthly: 4870 },
        { key: 'couple1', name: '夫妻 + 1 孩', monthly: 6090 },
        { key: 'couple2', name: '夫妻 + 2 孩', monthly: 7050 },
        { key: 'seniorCouple', name: '退休夫妻', monthly: 3210 }
      ],
      note: '以巴生谷为准；东马（古晋）生活费一般低 10–20%，仅作参考'
    },
    // Debt rules of thumb used by banks and AKPK.
    debt: {
      source: 'Bank Negara Malaysia Responsible Financing Guidelines; AKPK', checked: CHECKED,
      dsrMax: 0.6, dsrSafe: 0.35, note: '银行按 DSR 审批，常见上限 60%（低收入更严）；AKPK 建议月供不超过收入 35–40%',
      typicalRates: [['信用卡', '15–18% 年利率'], ['个人贷款', '6–10%'], ['车贷（固定利率换算）', '约 5–7% 实际年利率'], ['房贷', '3.8–4.5%'], ['PTPTN', '1% 行政费（Ujrah）']],
      akpk: '免费债务管理与重组：akpk.org.my，03-2616 7766'
    },
    // Protection rules of thumb.
    protection: {
      source: 'LIAM / Bank Negara 消费者教育; 常用经验法则', checked: CHECKED,
      lifeCoverMultiple: 10, criticalIllnessYears: 3, medicalCardNote: '每人一张医药卡，注意年限额、终身限额、等候期和 2025 年起的共付（co-payment）产品选项',
      perkeso: 'SOCSO 受雇者身故/伤残有基本保障；自雇可自愿参加 SKSPS'
    },
    // Investment basics for MY/SG families (education only; no product recommendations).
    investing: {
      source: 'SC Malaysia InvestSmart; 通用资产配置原则', checked: CHECKED,
      principles: [
        '先保障、备用金、清高息债，再投资',
        '长期资金用低费用、分散的工具（指数基金 / ETF），每月定投，每年再平衡',
        '股票比例经验公式：100 − 年龄；单一资产（含自住房）占净资产超过 60% 要注意集中风险',
        '马来西亚个人买卖股票没有资本利得税；新加坡也没有，这是本地优势',
        '保证每月回报 1% 以上的"投资"几乎都是骗局；查 SC 持牌名单和 BNM 警示名单',
        '加密货币等高波动资产不超过可投资资产的 5–10%'
      ],
      lowRisk: ['定存（阶梯）', 'ASB / ASNB 固定价格基金', 'Tabung Haji', '货币市场基金', '新加坡 T-bills / SSB'],
      core: ['全球或美股指数 ETF（经本地或海外券商）', '马股 ETF', '低费用单位信托（总费用 < 1.5%）', '马新 REITs'],
      satellite: ['个股', '加密货币（≤5–10%）', '黄金白银（5–10% 对冲）', 'P2P 融资']
    },
    // Estate planning checklist.
    estate: {
      source: 'Amanah Raya; 马来西亚遗产分配法令; 伊斯兰 Faraid', checked: CHECKED,
      items: ['遗嘱（非穆斯林）或 Wasiat（穆斯林，最多三分之一可自由处置）', 'Hibah（生前赠与）用于房产或保单', 'EPF、保险、PRS 的受益人指定（nomination）', '联名户口的生存者取得条款', '数字资产与密码交接清单', '重要文件库：地契、保单、贷款合同、车卡']
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = KB;
  else root.KB = KB;
})(typeof window !== 'undefined' ? window : globalThis);
