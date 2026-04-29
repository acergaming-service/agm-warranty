// ============================================================
//  AGM 保修系統 — Firebase Firestore 模組
//  取代：listAllCases / findCase / handleFormSubmit / handleUpdateStatus
//  保留：Apps Script 只負責寄信（sendConfirmEmail / sendShippingEmail）
//  版本：2025-04
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc,
  getDoc, getDocs, addDoc, updateDoc,
  query, where, orderBy, limit,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// ── Firebase 設定 ────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAtyrpyLSrUHhrDdnqwdJjpzmZGK9vbzUQ",
  authDomain:        "agm-warranty.firebaseapp.com",
  projectId:         "agm-warranty",
  storageBucket:     "agm-warranty.firebasestorage.app",
  messagingSenderId: "130595956759",
  appId:             "1:130595956759:web:a8eebcbdd4f4c975729452"
};

const app     = initializeApp(firebaseConfig);
const db      = getFirestore(app);
const storage = getStorage(app);

// Apps Script URL（只用於寄信）
const MAIL_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxOJLo5eTqQRn7oTKMXeiyIooFAWNR2Ab2XcqIZOJ80eH-sBpHeVyJgwkfTODfsxpis/exec";

// ── 保固規則（與 index.html 同步）───────────────────────────
function checkWarranty(brand, purchaseDate, serial, productName) {
  const nameStr = (productName || "").toLowerCase();
  const today   = new Date(); today.setHours(0, 0, 0, 0);

  const expired = (pd, years) => {
    const expiry = new Date(pd);
    expiry.setFullYear(expiry.getFullYear() + years);
    const ok   = today <= expiry;
    const days = Math.ceil((expiry - today) / 86400000);
    return {
      status: ok ? "✅ 在保固內" : "❌ 已過保固",
      expiry,
      note: `保固${years}年，到期：${fmtDate(expiry)}，` +
            (ok ? `剩餘 ${days} 天` : `已過期 ${Math.abs(days)} 天`)
    };
  };

  if (brand === "SteelSeries") {
    if (nameStr.includes("rival 105"))
      return { status: "🔀 轉介新拓企業社", expiry: null, note: "Rival 105 已停產" };
    if (nameStr.includes("mousepad") || nameStr.includes("滑鼠墊"))
      return { status: "🚫 不受理", expiry: null, note: "消耗品不在保固範圍" };
    if (!purchaseDate)
      return { status: "🔍 需人工確認", expiry: null, note: "無購買日期" };
    const pd    = new Date(purchaseDate);
    const years = pd < new Date("2024-03-25") ? 2 : 1;
    return expired(pd, years);
  }

  if (brand === "Razer") {
    if (!purchaseDate)
      return { status: "🔍 需人工確認（發票）", expiry: null, note: "請人工確認發票日期" };
    const isEar = /耳機|hammerhead|kaira|blackshark/i.test(nameStr);
    return expired(new Date(purchaseDate), isEar ? 2 : 1);
  }

  if (brand === "Logitech" || brand === "羅技(Logitech)") {
    if (!purchaseDate) return { status: "🔍 需人工確認", expiry: null, note: "請確認購買日期" };
    const isAcc = /線材|cable|pad|墊|dongle/i.test(nameStr);
    return expired(new Date(purchaseDate), isAcc ? 1 : 2);
  }

  if (brand === "Xbox 手把") {
    if (!purchaseDate) return { status: "🔍 需人工確認", expiry: null, note: "Xbox 手把僅7日DOA" };
    const doaEnd = new Date(purchaseDate);
    doaEnd.setDate(doaEnd.getDate() + 7);
    const inDOA = today <= doaEnd;
    return {
      status: inDOA ? "📦 DOA 7日內" : "🔀 轉介 Xbox 官方",
      expiry: doaEnd,
      note:   inDOA ? `DOA 到期：${fmtDate(doaEnd)}` : "已超過7日，請至官方報修"
    };
  }

  // Acer / Predator / AGM 自有 → 1年
  if (!purchaseDate) return { status: "🔍 需人工確認", expiry: null, note: "請確認購買日期" };
  return expired(new Date(purchaseDate), 1);
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// ── 案件編號生成 ─────────────────────────────────────────────
async function generateCaseId(brand) {
  const prefix = brand === "SteelSeries" ? "AGM-SS-" :
                 brand === "Razer"        ? "AGM-RZ-" : "AGM-Other-";
  const yy = new Date().getFullYear().toString().slice(2);

  // 查當年最大流水號
  const q = query(
    collection(db, "cases"),
    where("caseId", ">=", prefix + yy),
    where("caseId", "<",  prefix + yy + "99"),
    orderBy("caseId", "desc"),
    limit(1)
  );
  const snap = await getDocs(q);
  let maxNum = 0;
  snap.forEach(d => {
    const num = parseInt(d.data().caseId.replace(prefix + yy, "")) || 0;
    if (num > maxNum) maxNum = num;
  });
  return prefix + yy + String(maxNum + 1).padStart(2, "0");
}

// ============================================================
//  客戶前台：提交新案件
// ============================================================
export async function submitCase(formData) {
  const { brand, purchaseDate, serial, product } = formData;

  // 保固判斷
  const warranty = checkWarranty(brand, purchaseDate, serial, product);

  // 案件編號
  const caseId = await generateCaseId(brand);

  // 寫入 Firestore
  await addDoc(collection(db, "cases"), {
    caseId,
    brand,
    status:       "完成填表",
    submitDate:   serverTimestamp(),

    // 客戶資訊
    name:    formData.name,
    phone:   formData.phone,
    email:   formData.email,
    address: formData.address,

    // 產品資訊
    product:      formData.product,
    serial:       formData.serial    || "",
    purchaseDate: formData.purchaseDate || "",
    channel:      formData.channel   || "",
    invoiceUrl:   formData.invoiceUrl || "",
    issue:        formData.issue,
    notes:        formData.notes     || "",

    // Razer 專用
    razerCaseNo:  formData.razerCaseNo  || "",
    channelType:  formData.channelType  || "",
    channelName:  formData.channelName  || "",
    tsCaseNo:     formData.tsCaseNo     || "",

    // 保固
    warranty:     warranty.status,
    warrantyNote: warranty.note || "",
    warrantyExpiry: warranty.expiry ? fmtDate(warranty.expiry) : "",

    // 後台用
    agmPn:      "",
    msrp:       "",
    notified:   false,
    closedDays: null,
    trackingNo: "",
    oiNo:       "",
    ooNo:       "",
  });

  // 寄確認信（呼叫保留的 Apps Script）
  _callMailScript("confirmEmail", {
    email:   formData.email,
    name:    formData.name,
    caseId,
    brand,
    product: formData.product,
  });

  return { success: true, caseId };
}

// ============================================================
//  客戶前台：查詢案件進度
// ============================================================
export async function findCase(caseId) {
  const q    = query(collection(db, "cases"), where("caseId", "==", caseId.trim()));
  const snap = await getDocs(q);
  if (snap.empty) return { found: false };

  const data = snap.docs[0].data();
  return {
    found:        true,
    caseId:       data.caseId,
    brand:        data.brand,
    status:       data.status,
    name:         data.name,
    product:      data.product,
    submitDate:   data.submitDate?.toDate?.() || data.submitDate,
    warranty:     data.warranty,
    warrantyNote: data.warrantyNote,
  };
}

// ============================================================
//  後台：列出案件（支援月份、品牌、狀態篩選）
// ============================================================
export async function listAllCases({ year, month, brand = "ALL", status = "ALL" } = {}) {
  let q = collection(db, "cases");
  const constraints = [orderBy("submitDate", "desc")];

  // 月份篩選
  if (year && month) {
    const start = new Date(year, month - 1, 1);
    const end   = new Date(year, month, 1);
    constraints.push(where("submitDate", ">=", Timestamp.fromDate(start)));
    constraints.push(where("submitDate", "<",  Timestamp.fromDate(end)));
  }

  // 品牌篩選（Firestore 限制：多個 where + orderBy 需要複合索引，建議先用 ALL 再前端過濾）
  const snap = await getDocs(query(q, ...constraints));
  let cases = [];

  snap.forEach(d => {
    const data = d.data();
    cases.push({
      docId:      d.id,
      caseId:     data.caseId,
      brand:      data.brand,
      status:     data.status,
      name:       data.name,
      phone:      data.phone,
      email:      data.email,
      product:    data.product,
      submitDate: data.submitDate?.toDate?.() || null,
      warranty:   data.warranty,
      agmPn:      data.agmPn     || "",
      msrp:       data.msrp      || "",
      notified:   data.notified  || false,
      closedDays: data.closedDays || null,
      oiNo:       data.oiNo      || "",
      ooNo:       data.ooNo      || "",
      trackingNo: data.trackingNo || "",
    });
  });

  // 前端過濾（避免 Firestore 複合索引限制）
  if (brand !== "ALL")  cases = cases.filter(c => c.brand === brand);
  if (status === "WARRANTY") {
    cases = cases.filter(c => c.warranty &&
      (c.warranty.includes("❌") || c.warranty.includes("🚫") || c.warranty.includes("🔀")));
  } else if (status !== "ALL") {
    const DONE = ["手動結案", "結案", "已結案"];
    if (status === "已結案") cases = cases.filter(c => DONE.includes(c.status));
    else cases = cases.filter(c => c.status === status);
  }

  return { success: true, total: cases.length, cases };
}

// ============================================================
//  後台：取得有案件的年月清單
// ============================================================
export async function listAvailableMonths() {
  // 取最新 200 筆，從中提取年月
  const snap = await getDocs(
    query(collection(db, "cases"), orderBy("submitDate", "desc"), limit(200))
  );
  const months = new Set();
  snap.forEach(d => {
    const date = d.data().submitDate?.toDate?.();
    if (date) {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      months.add(key);
    }
  });
  return Array.from(months).sort().reverse();
}

// ============================================================
//  後台：更新案件狀態
// ============================================================
export async function updateCaseStatus({ caseId, docId, status, trackingNo, notes, oiNo, ooNo, engineerName }) {
  // 找文件
  let targetDocId = docId;
  if (!targetDocId) {
    const q    = query(collection(db, "cases"), where("caseId", "==", caseId));
    const snap = await getDocs(q);
    if (snap.empty) return { success: false, error: "找不到案件：" + caseId };
    targetDocId = snap.docs[0].id;
  }

  const docRef  = doc(db, "cases", targetDocId);
  const current = (await getDoc(docRef)).data();

  // 保固防呆
  const ws = current.warranty || "";
  if (ws.includes("🚫 不受理")) return { success: false, error: "此案件判定為不受理" };

  const updates = { status };
  const ts = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const prefix = engineerName ? `[${engineerName}]` : "";

  // 備註附加
  if (notes) {
    const prev = current.notes || "";
    updates.notes = prev ? `${prev}\n[${ts}]${prefix} ${notes}` : `[${ts}]${prefix} ${notes}`;
  }

  // OI / OO 單號
  if (oiNo) updates.oiNo = oiNo;
  if (ooNo) updates.ooNo = ooNo;

  let finalStatus = status;

  // 填入物流單號 → 寄通知信 + 結案
  if (trackingNo && (status === "可換貨" || status === "原件退回")) {
    updates.trackingNo = trackingNo;
    updates.notified   = true;
    updates.closedDays = current.submitDate
      ? Math.ceil((Date.now() - current.submitDate.toMillis()) / 86400000)
      : null;

    finalStatus      = "已結案";
    updates.status   = "已結案";

    const closeNote = `[${ts}]${prefix} 已結案。物流：${trackingNo}。共 ${updates.closedDays || "—"} 天`;
    updates.notes = updates.notes ? `${updates.notes}\n${closeNote}` : closeNote;

    // 寄通知信
    _callMailScript("shippingEmail", {
      email:      current.email,
      name:       current.name,
      caseId:     current.caseId,
      product:    current.product,
      type:       status === "可換貨" ? "換貨" : "原件退回",
      trackingNo,
    });
  }

  await updateDoc(docRef, updates);
  return { success: true, finalStatus, closedDays: updates.closedDays };
}

// ============================================================
//  購買憑證上傳（Firebase Storage）
// ============================================================
export async function uploadInvoice(file) {
  if (!file) return { success: false, error: "無檔案" };
  if (file.size > 10 * 1024 * 1024) return { success: false, error: "檔案超過 10MB" };

  const ext      = file.name.split(".").pop();
  const filename = `invoices/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const storageRef = ref(storage, filename);

  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { success: true, url };
}

// ── 呼叫 Apps Script 寄信（fire-and-forget）──────────────────
function _callMailScript(action, payload) {
  fetch(MAIL_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  }).catch(() => {}); // 寄信失敗不影響主流程
}

// ── 匯出工具函式 ─────────────────────────────────────────────
export { fmtDate, checkWarranty };
