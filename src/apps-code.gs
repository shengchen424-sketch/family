/**
 * 家庭资产与开销 — 服务端（Google Apps Script）
 * 数据存放：一份 Google 表格（第一次运行时自动创建，名称「家庭资产数据」）。
 * 每个集合（accounts、balances、tx …）是一个工作表，三列：id、json、updatedAt。
 * 收据照片：存放在云端硬盘「家庭收据」文件夹。
 * 运行身份：部署者本人（Execute as: Me）。其他人用各自的 Google 账号访问网址即可。
 */

var SHEET_TITLE = '家庭资产数据';
var RECEIPT_FOLDER = '家庭收据';

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('家庭资产记录')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// Used by index.html (template include).
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// Email of the person who opened the page (identity only; used to label who made a change).
function getMe() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  return { name: email, owner: email === Session.getEffectiveUser().getEmail() };
}

// Parity with server.js (the VPS build); the Apps Script build is kept as a fallback host.
function getSeed() { return { accounts: [], rate: null, month: null }; }
function exportAll() {
  return getSnapshot(['accounts', 'balances', 'rates', 'tx', 'recurring', 'categories', 'members', 'reminders', 'snapshots', 'audit', 'goals', 'settings']);
}
function importAll(data) {
  var n = 0;
  Object.keys(data || {}).forEach(function (name) {
    (data[name] || []).forEach(function (r) { if (r && r.id && r.data) { setDoc(name, r.id, r.data); n++; } });
  });
  return { imported: n };
}

function spreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SSID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted or moved: create a new one below */ }
  }
  var ss = SpreadsheetApp.create(SHEET_TITLE);
  props.setProperty('SSID', ss.getId());
  return ss;
}

function sheetFor_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, 3).setValues([['id', 'json', 'updatedAt']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

// Returns { collectionName: [ {id, data}, ... ], ... } for the requested names in one round trip.
function getSnapshot(names) {
  var ss = spreadsheet_();
  var out = {};
  (names || []).forEach(function (name) {
    var sh = sheetFor_(ss, name);
    var last = sh.getLastRow();
    var rows = [];
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
        if (!r[0]) return;
        try { rows.push({ id: String(r[0]), data: JSON.parse(r[1]) }); } catch (e) { /* skip damaged row */ }
      });
    }
    out[name] = rows;
  });
  return out;
}

// Write (create or replace) one document.
function setDoc(name, id, data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = sheetFor_(spreadsheet_(), name);
    var json = JSON.stringify(data);
    var row = findRow_(sh, id);
    if (row > 0) sh.getRange(row, 1, 1, 3).setValues([[String(id), json, new Date()]]);
    else sh.appendRow([String(id), json, new Date()]);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function delDoc(name, id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = sheetFor_(spreadsheet_(), name);
    var row = findRow_(sh, id);
    if (row > 0) sh.deleteRow(row);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// Receipt photo: dataUrl = "data:image/jpeg;base64,...". Returns the Drive file id.
function uploadReceipt(dataUrl, name) {
  var m = String(dataUrl).match(/^data:(image\/[a-z+]+);base64,(.*)$/);
  if (!m) throw new Error('图片格式不正确');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 3 * 1024 * 1024) throw new Error('图片太大');
  var blob = Utilities.newBlob(bytes, m[1], name || ('receipt-' + new Date().getTime() + '.jpg'));
  var folder = folderFor_();
  var file = folder.createFile(blob);
  return { fileId: file.getId() };
}

// Returns the receipt image as a data URL so any signed-in family member can view it.
function getReceipt(fileId) {
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function folderFor_() {
  var it = DriveApp.getFoldersByName(RECEIPT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(RECEIPT_FOLDER);
}
