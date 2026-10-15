/* Seed data taken from the 2026-10 workbook (年初导入：2026-10-01). Used by tests and by the one-time import. */
var SEED_ACCOUNTS = [
  { id: 'epf-chen', name: 'EPF Chen', kind: 'asset', group: 'family', category: '退休金', currency: 'MYR', sort: 1, amount: 55199.66 },
  { id: 'epf-liza', name: 'EPF Liza', kind: 'asset', group: 'family', category: '退休金', currency: 'MYR', sort: 2, amount: 104766.45 },
  { id: 'moomoo-uning', name: 'MooMoo Uning', kind: 'asset', group: 'family', category: '投资', currency: 'MYR', sort: 3, amount: 3382 },
  { id: 'moomoo-sgd', name: 'MooMoo SGD', kind: 'asset', group: 'family', category: '投资', currency: 'SGD', sort: 4, amount: 23705.29 },
  { id: 'gold-silver', name: 'Gold & Silver', kind: 'asset', group: 'family', category: '投资', currency: 'SGD', sort: 5, amount: 1815.55 },
  { id: 'asnb', name: 'ASNB Chen+Liza', kind: 'asset', group: 'family', category: '投资', currency: 'MYR', sort: 6, amount: 4452.43 },
  { id: 'mytheo', name: 'Mytheo', kind: 'asset', group: 'family', category: '投资', currency: 'MYR', sort: 7, amount: 0 },
  { id: 'luno', name: 'Luno Chen', kind: 'asset', group: 'family', category: '投资', currency: 'MYR', sort: 8, amount: 270 },
  { id: 'ocbc-sg', name: 'OCBC Singapore', kind: 'asset', group: 'family', category: '现金与定存', currency: 'SGD', sort: 9, amount: 11953.05 },
  { id: 'pb-fd', name: 'Public Bank 定存', kind: 'asset', group: 'family', category: '现金与定存', currency: 'MYR', sort: 10, amount: 5468.72 },
  { id: 'pb-joint', name: 'Public Bank Chen+Liza', kind: 'asset', group: 'family', category: '现金与定存', currency: 'MYR', sort: 11, amount: 7000 },
  { id: 'hlb-liza', name: 'HLB Liza', kind: 'asset', group: 'family', category: '现金与定存', currency: 'MYR', sort: 12, amount: 16111.71 },
  { id: 'ins-chen-lifelink', name: 'Chen A-LifeLink', kind: 'asset', group: 'family', category: '保险', currency: 'MYR', sort: 13, amount: 5846.14 },
  { id: 'ins-chen-other', name: 'Chen另一保单（待核名）', kind: 'asset', group: 'family', category: '保险', currency: 'MYR', sort: 14, amount: 6845.03 },
  { id: 'ins-liza', name: 'Liza保险（两项合计）', kind: 'asset', group: 'family', category: '保险', currency: 'MYR', sort: 15, amount: 12278.46 },
  { id: 'ins-uning', name: 'Uning保险（未提供）', kind: 'asset', group: 'family', category: '保险', currency: 'MYR', sort: 16, amount: null },
  { id: 'house-uni', name: 'Uni Garden 房产', kind: 'asset', group: 'family', category: '房产', currency: 'MYR', sort: 17, amount: 580000 },
  { id: 'car-mazda', name: 'Mazda CX-5 2.0 2018', kind: 'asset', group: 'family', category: '车辆', currency: 'MYR', sort: 18, amount: 55000 },
  { id: 'car-hilux', name: 'Toyota Hilux E 2025', kind: 'asset', group: 'family', category: '车辆', currency: 'MYR', sort: 19, amount: 95000 },
  { id: 'loan-house', name: 'Uni Garden 房贷', kind: 'liability', group: 'family', category: '房贷', currency: 'MYR', sort: 20, amount: 58971 },
  { id: 'loan-mazda', name: 'Mazda 贷款', kind: 'liability', group: 'family', category: '车贷', currency: 'MYR', sort: 21, amount: 46102.85 },
  { id: 'loan-hilux', name: 'Hilux 贷款', kind: 'liability', group: 'family', category: '车贷', currency: 'MYR', sort: 22, amount: 97923 },
  { id: 'loan-personal', name: 'Personal loan', kind: 'liability', group: 'family', category: '个人贷款', currency: 'MYR', sort: 23, amount: 30000 },
  { id: 'biz-pbb', name: 'Agrijoy PBB', kind: 'asset', group: 'business', category: '企业现金', currency: 'MYR', sort: 24, amount: 44309.09 },
  { id: 'biz-uob', name: 'Agrijoy UOB 透支', kind: 'liability', group: 'business', category: '企业透支', currency: 'MYR', sort: 25, amount: 1489.94 }
];
var SEED_RATE = 3.1953;
var SEED_MONTH = '2026-10';
