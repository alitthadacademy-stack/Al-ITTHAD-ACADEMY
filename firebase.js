import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAnalytics, isSupported as isAnalyticsSupported } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-analytics.js";
import {
  createUserWithEmailAndPassword,
  connectAuthEmulator,
  deleteUser,
  getAuth,
  onIdTokenChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app-check.js";
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
const firebaseConfig = {
  apiKey: "AIzaSyC9aS9Syk-aeAkRxdfVozcgn_ntufrDU7U",
  authDomain: "al-attihad-academy-68905.firebaseapp.com",
  projectId: "al-attihad-academy-68905",
  messagingSenderId: "6173840281",
  appId: "1:6173840281:web:a02c45aeafef1a455ff908",
  measurementId: "G-T993GGK10Z"
};
const COACH_EMAIL = "al.itthad.academy@gmail.com";
const FIREBASE_APPCHECK_SITE_KEY = "6LdKV_stAAAAAISGKewc6xy9x-bY1CILrl9yECS-";

const useFirebaseEmulators = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get("emulator") === "1";
const app = initializeApp(useFirebaseEmulators
  ? { ...firebaseConfig, projectId: "demo-alittihad-academy" }
  : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
if (!useFirebaseEmulators && FIREBASE_APPCHECK_SITE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(FIREBASE_APPCHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
}
if (useFirebaseEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
let activeSessionUnsubscribers = [];

function requireAppCheckConfiguration() {
  if (!useFirebaseEmulators && !FIREBASE_APPCHECK_SITE_KEY) {
    throw new Error("يلزم إعداد مفتاح Firebase App Check للموقع قبل تسجيل الدخول. أضف مفتاح reCAPTCHA v3 في firebase.js ثم أعد النشر.");
  }
}

async function closeActiveDeviceSession() {
  const user = auth.currentUser;
  if (!user) return;
  const { claims } = await user.getIdTokenResult();
  if (!user.isAnonymous && claims.playerSession !== true) return;

  const sessionRef = doc(db, "playerSessions", user.uid);
  await runTransaction(db, async transaction => {
    const sessionSnapshot = await transaction.get(sessionRef);
    if (!sessionSnapshot.exists() || sessionSnapshot.data().active !== true) return;

    const session = sessionSnapshot.data();
    const playerRef = doc(db, "players", session.playerCode);
    const playerSnapshot = await transaction.get(playerRef);
    if (playerSnapshot.exists() && playerSnapshot.data().activePlayerSessionUid === user.uid) {
      transaction.update(playerRef, { activePlayerSessionUid: deleteField() });
    }
    transaction.update(sessionRef, {
      active: false,
      revokedAt: serverTimestamp()
    });
  });
}

async function paymentReferenceClaimId(reference) {
  const normalizedReference = reference.normalize("NFKC").trim()
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .toLocaleUpperCase();
  const bytes = new TextEncoder().encode(normalizedReference);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_DAY_PRICES = { 1: 400, 2: 760, 3: 1020, 4: 1200, 5: 1400, 6: 1600, 7: 1800 };
const WEEK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];

function cairoDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function playerDayCount(player) {
  const days = Array.isArray(player.weeklyDays)
    ? [...new Set(player.weeklyDays.filter(day => WEEK_DAYS.includes(day)))]
    : [];
  return days.length || Number(player.weeklyDaysCount) || 0;
}

function playerPaymentQuote(context, duration) {
  const dayCount = playerDayCount(context.player);
  const monthlyPrice = Number(context.settings.pricesByDays?.[dayCount] ?? DEFAULT_DAY_PRICES[dayCount]);
  if (!Number.isFinite(monthlyPrice) || monthlyPrice < 0) {
    throw new Error("سعر الباقة غير صالح. تواصل مع المشرف.");
  }
  const walletCreditReserved = Math.max(0, Math.floor(Number(context.player.walletBalance) || 0));
  const subscriptionPrice = duration === "half" ? monthlyPrice / 2 : monthlyPrice;
  const siblingDiscount = 0;
  return {
    playerId: context.player.id,
    playerCode: context.player.playerCode,
    playerName: context.player.name,
    planId: dayCount,
    planName: `${dayCount} ${dayCount === 1 ? "يوم" : "أيام"} أسبوعيًا`,
    monthlyPrice,
    walletCreditReserved,
    siblingDiscount,
    subscriptionPrice,
    amount: Math.max(0, subscriptionPrice - walletCreditReserved - siblingDiscount)
  };
}

function playerSessionDays(session) {
  return (Array.isArray(session.days) ? session.days : [session.day])
    .filter(day => WEEK_DAYS.includes(day));
}

async function readPlayerPaymentContext(transaction, uid) {
  const sessionRef = doc(db, "playerSessions", uid);
  const sessionSnapshot = await transaction.get(sessionRef);
  const session = sessionSnapshot.data();
  if (!sessionSnapshot.exists() || session.active !== true
    || typeof session.playerCode !== "string" || !/^\d{6}$/.test(session.playerCode)) {
    throw new Error("جلسة اللاعب غير صالحة. سجّل الدخول بكود اللاعب مجددًا.");
  }

  const playerRef = doc(db, "players", session.playerCode);
  const playerSnapshot = await transaction.get(playerRef);
  if (!playerSnapshot.exists()) throw new Error("لم يتم العثور على ملف اللاعب.");
  const player = { ...playerSnapshot.data(), playerCode: playerSnapshot.id };
  if (player.activePlayerSessionUid !== uid || player.id !== session.playerId) {
    throw new Error("انتهت جلسة اللاعب بسبب تسجيل الدخول من جهاز آخر.");
  }
  if (typeof player.id !== "string" || !player.id || !player.guardianId) {
    throw new Error("ملف اللاعب غير مكتمل. تواصل مع المشرف.");
  }

  const selectedIds = Array.isArray(player.selectedSessionIds)
    ? [...new Set(player.selectedSessionIds.filter(id => typeof id === "string" && id && !id.includes("/")))]
    : [];
  if (!selectedIds.length || selectedIds.length > 30) {
    throw new Error("اختر موعد تدريب صالحًا من صفحة جدول التدريبات أولًا.");
  }
  const playerDays = Array.isArray(player.weeklyDays)
    ? [...new Set(player.weeklyDays.filter(day => WEEK_DAYS.includes(day)))]
    : [];
  if (!playerDays.length || playerDays.length > 7) {
    throw new Error("حدد أيام تدريب اللاعب أولًا من جدول التدريبات.");
  }

  const settingsRef = doc(db, "settings", "academy");
  const paymentsQuery = query(collection(db, "payments"), where("playerId", "==", player.id));
  const sessionsQuery = query(collection(db, "sessions"), where(documentId(), "in", selectedIds));
  const lockRef = doc(db, "playerPaymentLocks", player.id);
  const [settingsSnapshot, paymentsSnapshot, sessionsSnapshot, lockSnapshot] = await Promise.all([
    transaction.get(settingsRef),
    transaction.get(paymentsQuery),
    transaction.get(sessionsQuery),
    transaction.get(lockRef)
  ]);
  const sessions = sessionsSnapshot.docs
    .map(item => ({ ...item.data(), id: item.id }))
    .filter(item => sessionAllowsPlayer(item, player)
      && playerSessionDays(item).some(day => playerDays.includes(day)));
  if (!sessions.length) throw new Error("لا يوجد موعد تدريب مختار يناسب بيانات اللاعب.");

  const payments = paymentsSnapshot.docs.map(item => item.data());
  if (lockSnapshot.exists() || payments.some(payment => payment.status === "بانتظار المراجعة")) {
    throw new Error("لدى هذا اللاعب طلب دفع قيد المراجعة بالفعل.");
  }
  if (payments.some(payment => payment.status === "دفع جزئي نقدًا")) {
    throw new Error("أكمل المبلغ النقدي المتبقي لدى الأكاديمية قبل إرسال طلب InstaPay.");
  }

  const endDate = player.endDate || player.subscriptionEnd;
  const sessionsLeft = Number(player.sessionsLeft ?? playerDays.length * 4);
  if (endDate && (!validIsoDate(endDate) || (endDate >= cairoDateString() && sessionsLeft > 1))) {
    throw new Error(`يمكن تجديد اشتراك ${player.name} عند تبقي تمرين واحد أو انتهاء الاشتراك.`);
  }
  return {
    player,
    settings: settingsSnapshot.exists() ? settingsSnapshot.data() : {},
    sessions,
    dayCount: playerDays.length,
    lockRef
  };
}

function validatePlayerPaymentStartDate(value, sessions) {
  if (!validIsoDate(value)) throw new Error("تاريخ بداية الاشتراك غير صالح.");
  const today = cairoDateString();
  const start = new Date(`${value}T12:00:00.000Z`);
  const todayDate = new Date(`${today}T12:00:00.000Z`);
  const daysAway = Math.round((start.getTime() - todayDate.getTime()) / 86400000);
  if (daysAway < 0 || daysAway > 60) throw new Error("تاريخ بداية الاشتراك خارج المدة المتاحة.");
  const weekdays = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  if (!sessions.some(session => playerSessionDays(session).includes(weekdays[start.getUTCDay()]))) {
    throw new Error("تاريخ بداية الاشتراك لا يوافق أحد مواعيد اللاعب المختارة.");
  }
}

async function migratePaymentReferenceClaims(payments, profile) {
  if (profile?.role !== "coach" || auth.currentUser?.uid !== profile.id) {
    throw new Error("ترحيل أرقام التحويل السابقة متاح للمشرف فقط.");
  }
  const migrationRef = doc(db, "settings", "paymentReferenceClaimsMigration");
  const migration = await getDoc(migrationRef);
  if (migration.exists() && migration.data().completed === true) return;

  const references = [...new Set((Array.isArray(payments) ? payments : [])
    .filter(payment => payment.method !== "cash" && Number(payment.amount) > 0)
    .map(payment => String(payment.reference || "").normalize("NFKC").trim())
    .filter(reference => reference.length >= 4 && reference.length <= 120
      && !["رصيد محفظة اللاعب", "دفع نقدي في الأكاديمية", "تحصيل مديونية نقدية في الأكاديمية"].includes(reference)))];
  for (let offset = 0; offset < references.length; offset += 200) {
    const claims = await Promise.all(references.slice(offset, offset + 200).map(async reference => ({
      reference,
      claim: doc(db, "paymentReferenceClaims", await paymentReferenceClaimId(reference))
    })));
    await runTransaction(db, async transaction => {
      const snapshots = await Promise.all(claims.map(item => transaction.get(item.claim)));
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists()) {
          transaction.set(claims[index].claim, {
            ownerUid: profile.id,
            createdAt: serverTimestamp()
          });
        }
      });
    });
  }
  await setDoc(migrationRef, { completed: true, updatedAt: serverTimestamp() });
}

function withoutPassword(record) {
  const { password, __docId, createdAt, updatedAt, ...safeRecord } = record;
  return safeRecord;
}

function playerForFirestore(player) {
  const { guardian, guardianPhone, whatsappPhone, password, __docId, createdAt, updatedAt, ...safePlayer } = player;
  return safePlayer;
}

function normalizeAgeCategory(category) {
  return category === "أطفال حتى ٦ سنوات" ? "أطفال حتى ٧ سنوات" : category;
}

function sessionAllowsPlayer(session, player) {
  const categories = Array.isArray(session.categories) && session.categories.length
    ? session.categories.map(normalizeAgeCategory)
    : [normalizeAgeCategory(session.category)];
  const playerCategory = normalizeAgeCategory(player.category);
  const categoryMatches = categories.includes("جميع الفئات العمرية")
    || categories.includes(playerCategory)
    || !playerCategory
    || playerCategory === "جميع الفئات العمرية";
  const genderMatches = !["male", "female"].includes(session.gender)
    || !["male", "female"].includes(player.gender)
    || session.gender === player.gender;
  return categoryMatches && genderMatches;
}

function baselineValue(name, record) {
  if (name === "settings") {
    return JSON.stringify({
      workDays: record.workDays || [],
      pricesByDays: record.pricesByDays || {},
      instaPayAddress: record.instaPayAddress || "",
      paymentDestinationType: record.paymentDestinationType || "instapay",
      workDaysVersion: record.workDaysVersion || 1
    });
  }
  const cleanRecord = name === "players" ? playerForFirestore(record) : withoutPassword(record);
  return JSON.stringify(cleanRecord);
}

function playerCodeRef(code) {
  return doc(db, "playerCodes", code);
}

async function getProfile(user) {
  const profileSnapshot = await getDoc(doc(db, "users", user.uid));
  if (profileSnapshot.exists()) return { ...profileSnapshot.data(), id: user.uid };
  if (!user.email) return null;

  const invitationRef = doc(db, "trainerInvites", user.email.toLowerCase());
  const invitation = await getDoc(invitationRef);
  if (!invitation.exists()) return null;
  const invitationData = invitation.data();
  const profile = {
    id: user.uid,
    role: "trainer",
    name: invitationData.name,
    email: user.email,
    joinedAt: new Date().toISOString()
  };
  await runTransaction(db, async transaction => {
    const currentProfile = await transaction.get(doc(db, "users", user.uid));
    const currentInvite = await transaction.get(invitationRef);
    if (currentProfile.exists()) return;
    if (!currentInvite.exists()) throw new Error("انتهت صلاحية دعوة المدرب. تواصل مع مشرف الأكاديمية.");
    transaction.set(doc(db, "users", user.uid), { ...profile, createdAt: serverTimestamp() });
    transaction.delete(invitationRef);
  });
  return profile;
}

function queryForRole(name, profile) {
  const all = collection(db, name);
  if (name === "settings") return doc(db, "settings", "academy");
  if (profile.role === "coach") return all;
  if (name === "sessions") return all;
  if (name === "users") return doc(db, "users", profile.id);
  if (name === "players") {
    if (profile.role === "member") return doc(db, "players", profile.playerCode);
    if (profile.role === "trainer") return query(all, where("assignedTrainerIds", "array-contains", profile.id));
    return query(all, where("guardianId", "==", profile.id));
  }
  if (name === "attendance" && profile.role === "trainer") return query(all, where("trainerId", "==", profile.id));
  if (name === "payments" || name === "attendance" || name === "attendanceExceptions") {
    if (profile.role === "guardian") return query(all, where("guardianId", "==", profile.id));
    if (profile.role === "member") return query(all, where("playerId", "==", profile.id));
    return query(all, where("trainerId", "==", profile.id));
  }
  if (name === "trainerAttendance") return query(all, where("trainerId", "==", profile.id));
  return all;
}

function documentsFromSnapshot(snapshot, single) {
  if (single) return snapshot.exists() ? [{ ...snapshot.data(), id: snapshot.data().id || snapshot.id, __docId: snapshot.id }] : [];
  return snapshot.docs.map(item => ({ ...item.data(), id: item.data().id || item.id, __docId: item.id }));
}

function collectionsForRole(profile) {
  const names = ["players", "sessions", "announcements"];
  if (profile.role !== "member") names.unshift("users");
  names.push("attendance");
  if (profile.role !== "trainer") names.push("payments", "attendanceExceptions");
  if (profile.role === "coach") names.push("trainerAttendance");
  if (profile.role === "coach") names.push("administrativeAbsences");
  if (profile.role === "coach") names.push("expenses", "revenues");
  names.push("settings");
  return names;
}

function applyRecords(state, name, records, profile) {
  if (name === "settings") {
    const settings = records[0];
    if (settings) {
      state.instaPayAddress = settings.instaPayAddress || "";
      state.paymentDestinationType = settings.paymentDestinationType || "instapay";
      state.workDays = Array.isArray(settings.workDays) ? [...settings.workDays] : [];
      if ((settings.workDaysVersion || 1) < 2 && !state.workDays.includes("الجمعة")) state.workDays.push("الجمعة");
      state.pricesByDays = settings.pricesByDays || {};
    }
    return;
  }
  const allowedRoles = {
    users: ["coach", "guardian", "trainer"],
    players: ["coach", "guardian", "trainer", "member"],
    sessions: ["coach", "guardian", "trainer", "member"],
    payments: ["coach", "guardian", "member"],
    attendance: ["coach", "guardian", "member", "trainer"],
    attendanceExceptions: ["coach", "guardian", "member"],
    trainerAttendance: ["coach", "trainer"],
    administrativeAbsences: ["coach"],
    expenses: ["coach"],
    revenues: ["coach"],
    announcements: ["coach", "trainer", "guardian", "member"]
  };
  if (!allowedRoles[name]?.includes(profile.role)) return;

  const recordId = record => name === "players" ? record.playerCode : record.id;
  const ids = new Set(records.map(recordId));
  const field = name === "players" || name === "users" ? "users" : name;
  state[field] = state[field].filter(item => {
    if (name === "players") return item.role !== "member" || !ids.has(recordId(item));
    if (name === "users") return item.role === "member" || !ids.has(recordId(item));
    return !ids.has(recordId(item));
  });
  state[field].push(...records.map(record => {
    const { __docId, ...appRecord } = record;
    if (name === "players") {
      appRecord.category = normalizeAgeCategory(appRecord.category);
      appRecord.expectedStartDate ||= appRecord.subscriptionStart || null;
      appRecord.actualStartDate ||= appRecord.subscriptionStart || null;
      appRecord.endDate ||= appRecord.subscriptionEnd || null;
      appRecord.subscriptionEnd ||= appRecord.endDate || null;
      appRecord.attendanceLogs = Array.isArray(appRecord.attendanceLogs) ? appRecord.attendanceLogs : [];
      const guardian = state.users.find(user => user.id === appRecord.guardianId && user.role === "guardian");
      appRecord.guardian = guardian?.name || "";
      appRecord.guardianPhone ||= guardian?.guardianPhone || "";
      appRecord.whatsappPhone ||= guardian?.whatsappPhone || appRecord.guardianPhone;
    } else if (name === "sessions") {
      const categories = Array.isArray(appRecord.categories)
        ? appRecord.categories.map(normalizeAgeCategory)
        : [];
      appRecord.categories = categories;
      appRecord.category = normalizeAgeCategory(appRecord.category);
    }
    return appRecord;
  }));
}

function removeRecordsByDocumentId(state, name, documentIds) {
  if (!documentIds.length) return;
  const ids = new Set(documentIds);
  const field = name === "players" || name === "users" ? "users" : name;
  state[field] = state[field].filter(record => {
    if (name === "players") return record.role !== "member" || !ids.has(record.playerCode);
    if (name === "users") return record.role === "member" || !ids.has(record.id);
    return !ids.has(record.id);
  });
}

function validateWriteRole(profile, collectionName, record) {
  if (profile.role === "coach") return true;
  if (collectionName === "players" && profile.role === "guardian") return record.guardianId === profile.id;
  if (collectionName === "players" && profile.role === "member") return record.id === profile.id;
  if (collectionName === "players" && profile.role === "trainer") return Boolean(record.lastAttendanceId);
  if (collectionName === "users" && profile.role === "guardian") return record.id === profile.id;
  if (["payments", "attendance", "attendanceExceptions"].includes(collectionName) && profile.role === "guardian") return record.guardianId === profile.id;
  if (["attendance", "attendanceExceptions"].includes(collectionName) && profile.role === "trainer") return record.trainerId === profile.id;
  if (collectionName === "trainerAttendance" && profile.role === "trainer") return record.trainerId === profile.id;
  return false;
}

function academyServices() {
  const baseline = new Map();
  let activeUnsubscribers = [];
  let activeProfile = null;

  function stopWatching() {
    activeUnsubscribers.forEach(unsubscribe => unsubscribe());
    activeUnsubscribers = [];
    activeProfile = null;
    baseline.clear();
  }

  return {
    auth,
    observeAuth(callback) {
      return onIdTokenChanged(auth, async user => {
        activeSessionUnsubscribers.forEach(unsubscribe => unsubscribe());
        activeSessionUnsubscribers = [];
        if (user) {
          try {
            const { claims } = await user.getIdTokenResult();
            if (user.isAnonymous || claims.playerSession === true) {
              const sessionRef = doc(db, "playerSessions", user.uid);
              let watchedPlayerCode = "";
              activeSessionUnsubscribers.push(onSnapshot(sessionRef, snapshot => {
                if (!snapshot.exists()) return;
                const session = snapshot.data();
                if (session.active !== true || typeof session.playerCode !== "string") {
                  if (auth.currentUser?.uid === user.uid) {
                    signOut(auth).catch(error => console.error("تعذر إنهاء جلسة لاعب غير صالحة.", error));
                  }
                  return;
                }
                if (watchedPlayerCode === session.playerCode) return;
                watchedPlayerCode = session.playerCode;
                activeSessionUnsubscribers.push(onSnapshot(doc(db, "players", session.playerCode), playerSnapshot => {
                  if (!playerSnapshot.exists() || playerSnapshot.data().activePlayerSessionUid !== user.uid) {
                    if (auth.currentUser?.uid === user.uid) {
                      signOut(auth).catch(error => console.error("تعذر إنهاء جلسة لاعب تم استبدالها.", error));
                    }
                  }
                }, error => {
                  console.error("تعذر التحقق من صلاحية جلسة هذا الجهاز.", error);
                  if (auth.currentUser?.uid === user.uid) {
                    signOut(auth).catch(signOutError => console.error("تعذر إنهاء جلسة جهاز غير صالحة.", signOutError));
                  }
                }));
              }, error => {
                console.error("تعذر التحقق من صلاحية جلسة هذا الجهاز.", error);
                if (auth.currentUser?.uid === user.uid) {
                  signOut(auth).catch(signOutError => console.error("تعذر إنهاء جلسة جهاز غير صالحة.", signOutError));
                }
              }));
            }
          } catch (error) {
            console.error("تعذر تحميل بيانات جلسة الجهاز.", error);
          }
        }
        callback(user);
      });
    },
    async registerGuardian(guardian, players) {
      requireAppCheckConfiguration();
      const credential = await createUserWithEmailAndPassword(auth, guardian.email.trim(), guardian.password);
      try {
        await updateProfile(credential.user, { displayName: guardian.name });
        const guardianProfile = {
          id: credential.user.uid,
          role: "guardian",
          name: guardian.name.trim(),
          guardianPhone: guardian.guardianPhone,
          whatsappPhone: guardian.whatsappPhone,
          email: credential.user.email,
          joinedAt: guardian.joinedAt || new Date().toISOString()
        };
        const sessionSnapshot = await getDocs(collection(db, "sessions"));
        const registeredPlayers = players.map(player => ({
          id: player.id || crypto.randomUUID(),
          role: "member",
          guardianId: credential.user.uid,
          name: player.name.trim(),
          birthDate: player.birthDate,
          gender: player.gender,
          category: player.category,
          weeklyDays: [],
          weeklyDaysCount: 0,
          plan: 0,
          walletBalance: 0,
          sessionsLeft: 0,
          sessionsUsed: 0,
          expectedStartDate: null,
          actualStartDate: null,
          subscriptionStart: null,
          subscriptionEnd: null,
          endDate: null,
          attendanceLogs: [],
          assignedTrainerIds: [...new Set(sessionSnapshot.docs
            .map(snapshot => snapshot.data())
            .filter(session => sessionAllowsPlayer(session, player))
            .map(session => session.coachId)
            .filter(id => typeof id === "string" && id))].slice(0, 3),
          joinedAt: player.joinedAt || new Date().toISOString()
        }));
        const profileRef = doc(db, "users", credential.user.uid);
        if ((await getDoc(profileRef)).exists()) {
          throw new Error("حساب ولي الأمر مسجل بالفعل. سجّل الدخول بدلًا من إنشاء حساب جديد.");
        }
        const savedPlayers = [];
        for (let offset = 0; offset < registeredPlayers.length; offset += 3) {
          const playerGroup = registeredPlayers.slice(offset, offset + 3);
          let saved = false;
          for (let attempt = 0; attempt < 10 && !saved; attempt += 1) {
            const codes = new Set();
            while (codes.size < playerGroup.length) {
              const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
              codes.add(String(value).padStart(6, "0"));
            }
            const playerCodes = [...codes];
            const playersWithCodes = playerGroup.map((player, index) => ({
              ...player,
              playerCode: playerCodes[index]
            }));
            const batch = writeBatch(db);
            if (offset === 0) batch.set(profileRef, { ...guardianProfile, createdAt: serverTimestamp() });
            playersWithCodes.forEach(player => {
              batch.set(doc(db, "players", player.playerCode), {
                ...player,
                createdAt: serverTimestamp()
              });
              batch.set(doc(db, "playerCodes", player.playerCode), {
                playerId: player.id,
                playerCode: player.playerCode
              });
            });
            try {
              await batch.commit();
              savedPlayers.push(...playersWithCodes);
              saved = true;
            } catch (error) {
              if (error?.code !== "permission-denied" || attempt === 9) {
                throw error;
              }
            }
          }
        }
        registeredPlayers.splice(0, registeredPlayers.length, ...savedPlayers);
        baseline.set(`users/${guardianProfile.id}`, baselineValue("users", guardianProfile));
        registeredPlayers.forEach(player => {
          baseline.set(`players/${player.playerCode}`, baselineValue("players", player));
        });
        return { profile: guardianProfile, players: registeredPlayers };
      } catch (error) {
        const profileSnapshot = await getDoc(doc(db, "users", credential.user.uid)).catch(() => null);
        if (!profileSnapshot?.exists()) {
          try {
            await deleteUser(credential.user);
          } catch (cleanupError) {
            console.error("تعذر تنظيف حساب Authentication بعد فشل التسجيل.", cleanupError);
          }
          if (error?.code === "permission-denied") {
            throw new Error("تعذر حفظ حساب ولي الأمر والأبناء في Firestore. انشر قواعد Firestore المحدّثة ثم أعد المحاولة.");
          }
        } else {
          await signOut(auth);
          if (error?.code === "permission-denied") {
            throw new Error("تم إنشاء حساب ولي الأمر وبعض بيانات الأبناء، لكن تعذر حفظ الباقي. سجّل الدخول ثم أضف اللاعبين غير المسجلين.");
          }
        }
        throw error;
      }
    },
    async signIn(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const profile = await getProfile(credential.user);
      if (!profile) {
        await signOut(auth);
        throw new Error("هذا البريد لم تتم إضافته إلى الأكاديمية. تواصل مع المشرف.");
      }
      return profile;
    },
    async signInCoach(password) {
      let credential;
      try {
        credential = await signInWithEmailAndPassword(auth, COACH_EMAIL, password);
        const profile = await getProfile(credential.user);
        if (!profile || profile.role !== "coach") {
          throw new Error("تعذر التحقق من حساب المشرف. راجع إعداد حساب الأكاديمية.");
        }
        return profile;
      } catch (error) {
        if (auth.currentUser) await signOut(auth);
        if (error?.code === "auth/configuration-not-found") {
          throw new Error("خدمة تسجيل الدخول في Firebase غير مهيأة لهذا المشروع. فعّل Authentication وطريقة Email/Password في مشروع al-attihad-academy-68905.");
        }
        if (error?.code === "auth/invalid-credential" || error?.code === "auth/wrong-password" || error?.code === "auth/user-not-found") {
          throw new Error(`رفض Firebase بيانات حساب المشرف. تحقق من وجود ${COACH_EMAIL} في Authentication وأن كلمة المرور مضبوطة لهذا الحساب.`);
        }
        throw error;
      }
    },
    async signInWithPlayerCode(code) {
      try {
        requireAppCheckConfiguration();
        if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
          throw new Error("كود اللاعب غير صحيح.");
        }
        if (auth.currentUser) {
          try {
            await closeActiveDeviceSession();
          } catch (closeError) {
            console.error("تعذر تحرير الجلسة السابقة قبل دخول اللاعب.", closeError);
          }
          await signOut(auth);
        }
        const credential = await signInAnonymously(auth);
        const codeSnapshot = await getDoc(doc(db, "playerCodes", code));
        if (!codeSnapshot.exists()) throw new Error("كود اللاعب غير صحيح.");
        const player = await runTransaction(db, async transaction => {
          const codeRef = doc(db, "playerCodes", code);
          const playerRef = doc(db, "players", code);
          const [codeSnapshot, playerSnapshot] = await Promise.all([
            transaction.get(codeRef),
            transaction.get(playerRef)
          ]);
          if (!codeSnapshot.exists() || !playerSnapshot.exists()) {
            throw new Error("كود اللاعب غير صحيح.");
          }
          const playerData = playerSnapshot.data();
          if (codeSnapshot.data().playerId !== playerData.id || playerData.playerCode !== code) {
            throw new Error("تعذر التحقق من ملف اللاعب. تواصل مع المشرف.");
          }

          const sessionRef = doc(db, "playerSessions", credential.user.uid);
          transaction.set(sessionRef, {
            playerCode: code,
            playerId: playerData.id,
            active: true,
            createdAt: serverTimestamp()
          });
          transaction.update(playerRef, { activePlayerSessionUid: credential.user.uid });
          return playerData;
        });
        return { ...player, id: player.id || code, role: "member", authUid: credential.user.uid };
      } catch (error) {
        if (auth.currentUser) {
          await signOut(auth);
        }
        if (error?.code === "auth/configuration-not-found" || error?.code === "auth/operation-not-allowed") {
          throw new Error("دخول اللاعبين يحتاج إلى تفعيل Firebase Authentication → Sign-in method → Anonymous في مشروع الأكاديمية.");
        }
        if (error?.code === "permission-denied") {
          throw new Error("تعذر التحقق من جلسة اللاعب. تأكد من نشر قواعد Firestore المحدّثة.");
        }
        throw error;
      }
    },
    async createPlayer(player) {
      requireAppCheckConfiguration();
      if (activeProfile?.role !== "guardian" || activeProfile.id !== auth.currentUser?.uid) {
        throw new Error("إضافة لاعب متاحة لحساب ولي الأمر المسجل فقط.");
      }
      const sessionSnapshot = await getDocs(collection(db, "sessions"));
      const weeklyDays = [...new Set(player.weeklyDays || [])];
      const savedPlayer = {
        id: player.id || crypto.randomUUID(),
        role: "member",
        guardianId: activeProfile.id,
        name: player.name.trim(),
        birthDate: player.birthDate,
        gender: player.gender,
        category: player.category,
        weeklyDays,
        weeklyDaysCount: weeklyDays.length,
        plan: weeklyDays.length,
        walletBalance: 0,
        sessionsLeft: 0,
        sessionsUsed: 0,
        expectedStartDate: null,
        actualStartDate: null,
        subscriptionStart: null,
        subscriptionEnd: null,
        endDate: null,
        attendanceLogs: [],
        joinedAt: player.joinedAt || new Date().toISOString(),
        assignedTrainerIds: [...new Set(sessionSnapshot.docs
          .map(snapshot => snapshot.data())
          .filter(session => sessionAllowsPlayer(session, player))
          .map(session => session.coachId)
          .filter(id => typeof id === "string" && id))].slice(0, 3)
      };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
        const playerCode = String(value).padStart(6, "0");
        const batch = writeBatch(db);
        batch.set(doc(db, "players", playerCode), {
          ...playerForFirestore(savedPlayer),
          playerCode,
          createdAt: serverTimestamp()
        });
        batch.set(doc(db, "playerCodes", playerCode), {
          playerId: savedPlayer.id,
          playerCode
        });
        try {
          await batch.commit();
          const createdPlayer = { ...savedPlayer, playerCode };
          baseline.set(`players/${playerCode}`, baselineValue("players", createdPlayer));
          return createdPlayer;
        } catch (error) {
          if (error?.code !== "permission-denied" || attempt === 9) throw error;
        }
      }
      throw new Error("تعذر إنشاء كود فريد للاعب. حاول مرة أخرى.");
    },
    async updatePlayer(player) {
      const playerRef = doc(db, "players", player.playerCode);
      const safePlayer = playerForFirestore(player);
      await setDoc(playerRef, { ...safePlayer, updatedAt: serverTimestamp() }, { merge: true });
      baseline.set(`players/${player.playerCode}`, baselineValue("players", {
        ...safePlayer,
        assignedTrainerIds: (await getDoc(playerRef)).data()?.assignedTrainerIds || []
      }));
      return player;
    },
    async saveAdministrativeSubscriptionAdjustment(player, payment, profile) {
      if (!activeProfile || activeProfile.role !== "coach"
        || activeProfile.id !== auth.currentUser?.uid
        || !profile || profile.role !== "coach" || profile.id !== activeProfile.id
        || payment.playerId !== player.id || payment.guardianId !== player.guardianId) {
        throw new Error("تسجيل تعديل الاشتراك وإيراده متاح للمشرف المسجل فقط.");
      }
      const safePlayer = playerForFirestore(player);
      const safePayment = { ...withoutPassword(payment), createdAt: payment.createdAt };
      const playerRef = doc(db, "players", player.playerCode);
      const paymentRef = doc(db, "payments", payment.id);
      const batch = writeBatch(db);
      batch.set(playerRef, { ...safePlayer, updatedAt: serverTimestamp() }, { merge: true });
      batch.set(paymentRef, { ...safePayment, updatedAt: serverTimestamp() }, { merge: true });
      await batch.commit();
      baseline.set(`players/${player.playerCode}`, baselineValue("players", safePlayer));
      baseline.set(`payments/${payment.id}`, baselineValue("payments", safePayment));
    },
    async saveTrainerAttendance(records, profile) {
      if (!activeProfile || activeProfile.role !== "coach"
        || activeProfile.id !== auth.currentUser?.uid
        || !profile || profile.role !== "coach" || profile.id !== activeProfile.id
        || !Array.isArray(records) || !records.length) {
        throw new Error("حفظ حضور المدربين متاح للمشرف المسجل فقط.");
      }
      const batch = writeBatch(db);
      records.forEach(record => {
        if (!record.id || !record.trainerId || !record.sessionId || !/^\d{4}-\d{2}-\d{2}$/.test(record.isoDate)) {
          throw new Error("بيانات سجل حضور التمرين غير مكتملة.");
        }
        batch.set(doc(db, "trainerAttendance", record.id), {
          ...withoutPassword(record),
          updatedAt: serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
      records.forEach(record => baseline.set(`trainerAttendance/${record.id}`, baselineValue("trainerAttendance", record)));
    },
    async currentProfile(user) {
      const { claims } = await user.getIdTokenResult();
      if (user.isAnonymous || claims.playerSession === true) {
        let session;
        try {
          session = await getDoc(doc(db, "playerSessions", user.uid));
        } catch (error) {
          if (error?.code === "permission-denied") return null;
          throw error;
        }
        if (!session.exists() || session.data().active !== true) return null;
        const code = session.data().playerCode;
        const player = await getDoc(doc(db, "players", code));
        if (!player.exists() || player.data().activePlayerSessionUid !== user.uid) return null;
        return { ...player.data(), id: player.data().id || player.id, role: "member", authUid: user.uid };
      }
      const profile = await getProfile(user);
      return profile;
    },
    async signOut() {
      stopWatching();
      try {
        await closeActiveDeviceSession();
      } catch (error) {
        console.error("تعذر إبطال جلسة الجهاز قبل تسجيل الخروج؛ ستنتهي صلاحيتها عند استبدالها.", error);
      }
      await signOut(auth);
    },
    async getGuardianReport(guardianId) {
      const user = auth.currentUser;
      if (!user || user.isAnonymous) throw new Error("سجّل الدخول بحساب المشرف لعرض تقرير ولي الأمر.");
      const supervisor = await getProfile(user);
      if (supervisor?.role !== "coach") throw new Error("تقرير ولي الأمر متاح للمشرف فقط.");
      if (typeof guardianId !== "string" || !guardianId) throw new Error("معرّف ولي الأمر غير صالح.");

      const guardianSnapshot = await getDoc(doc(db, "users", guardianId));
      if (!guardianSnapshot.exists() || guardianSnapshot.data().role !== "guardian") {
        throw new Error("لم يتم العثور على حساب ولي الأمر.");
      }
      const playerSnapshot = await getDocs(query(collection(db, "players"), where("guardianId", "==", guardianId)));
      const players = documentsFromSnapshot(playerSnapshot, false);
      const playerIds = players.map(player => player.id).filter(Boolean);
      const readPlayerRecords = async name => {
        const groups = [];
        for (let offset = 0; offset < playerIds.length; offset += 30) {
          const playerIdGroup = playerIds.slice(offset, offset + 30);
          const snapshot = await getDocs(query(collection(db, name), where("playerId", "in", playerIdGroup)));
          groups.push(...documentsFromSnapshot(snapshot, false));
        }
        return groups;
      };
      const [attendance, payments] = await Promise.all([
        readPlayerRecords("attendance"),
        readPlayerRecords("payments")
      ]);
      return {
        guardian: { ...guardianSnapshot.data(), id: guardianSnapshot.id },
        players,
        attendance,
        payments
      };
    },
    async loadAcademyData(profile, state, onUpdate, onError) {
      if (profile.role === "member") {
        const playerSnapshot = await getDoc(doc(db, "players", profile.playerCode));
        if (playerSnapshot.exists()) {
          const playerData = playerSnapshot.data();
          profile = { ...profile, ...playerData, id: playerData.id, role: "member" };
        }
      }
      if (profile.role !== "coach" && !profile.email && auth.currentUser && !auth.currentUser.isAnonymous) {
        profile = { ...profile, email: auth.currentUser.email };
      }
      stopWatching();
      activeProfile = profile;
      const names = collectionsForRole(profile);
      const snapshots = await Promise.all(names.map(name => {
        const reference = queryForRole(name, profile);
        return name === "settings" || (name === "users" && profile.role !== "coach") || (name === "players" && profile.role === "member")
          ? getDoc(reference)
          : getDocs(reference);
      }));
      const initialRecords = snapshots.map((snapshot, index) => {
        const name = names[index];
        const single = name === "settings" || (name === "users" && profile.role !== "coach") || (name === "players" && profile.role === "member");
        return documentsFromSnapshot(snapshot, single);
      });
      const settingsIndex = names.indexOf("settings");
      const settingsRecord = initialRecords[settingsIndex]?.[0];
      if (profile.role === "coach" && settingsRecord && (settingsRecord.workDaysVersion || 1) < 2) {
        const workDays = Array.isArray(settingsRecord.workDays) ? [...settingsRecord.workDays] : [...state.workDays];
        if (!workDays.includes("الجمعة")) workDays.push("الجمعة");
        const migratedSettings = { ...settingsRecord, workDays, workDaysVersion: 2 };
        await setDoc(doc(db, "settings", "academy"), {
          workDays,
          workDaysVersion: 2,
          updatedAt: serverTimestamp()
        }, { merge: true });
        initialRecords[settingsIndex] = [migratedSettings];
      }
      names.forEach((name, index) => {
        const records = initialRecords[index];
        applyRecords(state, name, records, profile);
        records.forEach(record => baseline.set(`${name}/${record.__docId || record.id}`, baselineValue(name, record)));
      });
      activeUnsubscribers = names.map(name => {
        const reference = queryForRole(name, profile);
        const single = name === "settings" || (name === "users" && profile.role !== "coach") || (name === "players" && profile.role === "member");
        return onSnapshot(reference, snapshot => {
          const records = documentsFromSnapshot(snapshot, single);
          const previous = new Set([...baseline.keys()].filter(key => key.startsWith(`${name}/`)));
          const removedDocumentIds = [];
          records.forEach(record => {
            const key = `${name}/${record.__docId || record.id}`;
            previous.delete(key);
            baseline.set(key, baselineValue(name, record));
          });
          previous.forEach(key => {
            removedDocumentIds.push(key.slice(name.length + 1));
            baseline.delete(key);
          });
          removeRecordsByDocumentId(state, name, removedDocumentIds);
          if (name !== "settings" || records.length) applyRecords(state, name, records, profile);
          onUpdate?.();
        }, error => {
          console.error(`تعذر مزامنة ${name} من Firestore.`, error);
          onError?.(error);
        });
      });
      return state;
    },
    async saveAcademyData(state, profile) {
      if (!activeProfile || activeProfile.id !== profile.id) throw new Error("جلسة Firestore غير جاهزة. أعد تسجيل الدخول.");
      const playerForId = new Map(state.users.filter(record => record.role === "member").map(record => [record.id, record]));
      const buckets = {
        users: state.users.filter(record => record.role !== "member"),
        players: state.users.filter(record => record.role === "member").map(record => ({
          ...playerForFirestore(record),
          assignedTrainerIds: profile.role === "coach" ? [...new Set(state.sessions.filter(session =>
            sessionAllowsPlayer(session, record)
          ).map(session => session.coachId).filter(Boolean))] : (record.assignedTrainerIds || []),
          ...(profile.role === "trainer" ? {
            lastAttendanceId: state.attendance.find(attendance =>
              attendance.playerId === record.id
              && attendance.trainerId === profile.id
              && !baseline.has(`attendance/${attendance.id}`)
            )?.id
          } : {})
        })),
        sessions: state.sessions,
        payments: state.payments.map(record => ({
          ...record,
          guardianId: record.guardianId || playerForId.get(record.playerId)?.guardianId,
          playerCode: record.playerCode || playerForId.get(record.playerId)?.playerCode
        })),
        attendance: state.attendance.map(record => ({ ...record, guardianId: record.guardianId || playerForId.get(record.playerId)?.guardianId })),
        attendanceExceptions: state.attendanceExceptions.map(record => ({ ...record, guardianId: record.guardianId || playerForId.get(record.playerId)?.guardianId })),
        trainerAttendance: profile.role === "coach" ? state.trainerAttendance : state.trainerAttendance.filter(record => record.trainerId === profile.id),
        expenses: profile.role === "coach" ? state.expenses : [],
        revenues: profile.role === "coach" ? state.revenues : []
      };
      let batch = writeBatch(db);
      let operationCount = 0;
      const batches = [];
      const baselineUpdates = [];
      for (const [name, records] of Object.entries(buckets)) {
        for (const record of records) {
          const scopedRecord = { ...record };
          if (name === "payments" || name === "attendance" || name === "attendanceExceptions") {
            scopedRecord.guardianId ||= state.users.find(user => user.id === record.playerId)?.guardianId;
          }
          if (!validateWriteRole(profile, name, scopedRecord)) continue;
          const id = name === "players" ? scopedRecord.playerCode : scopedRecord.id;
          if (!id) continue;
          const key = `${name}/${id}`;
          const safeRecord = name === "players" ? playerForFirestore(scopedRecord) : withoutPassword(scopedRecord);
          const serialized = baselineValue(name, safeRecord);
          if (name === "players" && profile.role === "trainer" && !scopedRecord.lastAttendanceId) continue;
          if (baseline.get(key) === serialized) continue;
          const releasePaymentLock = name === "payments" && profile.role === "coach"
            && scopedRecord.status !== "بانتظار المراجعة" && scopedRecord.playerId;
          const writesNeeded = releasePaymentLock ? 2 : 1;
          if (operationCount + writesNeeded > 500) {
            batches.push(batch);
            batch = writeBatch(db);
            operationCount = 0;
          }
          batch.set(doc(db, name, id), { ...safeRecord, updatedAt: serverTimestamp() }, { merge: true });
          if (releasePaymentLock) {
            batch.delete(doc(db, "playerPaymentLocks", scopedRecord.playerId));
          }
          baselineUpdates.push([key, serialized]);
          operationCount += writesNeeded;
        }
      }
      if (profile.role === "coach") {
        const settings = {
          workDays: state.workDays,
          pricesByDays: state.pricesByDays,
          instaPayAddress: state.instaPayAddress,
          paymentDestinationType: state.paymentDestinationType,
          workDaysVersion: 2
        };
        const serialized = JSON.stringify(settings);
        if (baseline.get("settings/academy") !== serialized) {
          if (operationCount === 500) {
            batches.push(batch);
            batch = writeBatch(db);
            operationCount = 0;
          }
          batch.set(doc(db, "settings", "academy"), { ...settings, updatedAt: serverTimestamp() }, { merge: true });
          baselineUpdates.push(["settings/academy", serialized]);
          operationCount += 1;
        }
      }
      if (operationCount) batches.push(batch);
      for (const pendingBatch of batches) await pendingBatch.commit();
      baselineUpdates.forEach(([key, value]) => baseline.set(key, value));
    },
    async deleteRecord(collectionName, id) {
      if (collectionName === "payments" && activeProfile?.role === "coach"
        && activeProfile.id === auth.currentUser?.uid) {
        const paymentRef = doc(db, "payments", id);
        await runTransaction(db, async transaction => {
          const paymentSnapshot = await transaction.get(paymentRef);
          if (!paymentSnapshot.exists()) return;
          const payment = paymentSnapshot.data();
          const lockRef = typeof payment.playerId === "string"
            ? doc(db, "playerPaymentLocks", payment.playerId)
            : null;
          const lockSnapshot = lockRef ? await transaction.get(lockRef) : null;
          transaction.delete(paymentRef);
          if (lockSnapshot?.exists() && lockSnapshot.data().paymentId === id) transaction.delete(lockRef);
        });
      } else {
        await deleteDoc(doc(db, collectionName, id));
      }
      baseline.delete(`${collectionName}/${id}`);
    },
    async listAnnouncements() {
      const snapshot = await getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc")));
      return snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    },
    async listAnnouncementReads(profile) {
      const currentUid = auth.currentUser?.uid;
      const ownerUid = profile?.role === "guardian" ? profile.id : profile?.authUid;
      if (!profile || !["guardian", "member"].includes(profile.role) || !currentUid || ownerUid !== currentUid) {
        throw new Error("حالة قراءة الإعلانات متاحة لولي الأمر أو اللاعب المسجل فقط.");
      }
      const snapshot = await getDocs(query(
        collection(db, "announcementReads"),
        where("ownerUid", "==", ownerUid)
      ));
      return snapshot.docs.map(item => item.data().announcementId);
    },
    async markAnnouncementRead(profile, announcementId) {
      const currentUid = auth.currentUser?.uid;
      const ownerUid = profile?.role === "guardian" ? profile.id : profile?.authUid;
      if (!profile || !["guardian", "member"].includes(profile.role) || !currentUid || ownerUid !== currentUid) {
        throw new Error("تحديد الإعلانات كمقروءة متاح لولي الأمر أو اللاعب المسجل فقط.");
      }
      if (typeof announcementId !== "string" || !announcementId) {
        throw new Error("تعذر تحديد الإعلان المطلوب.");
      }
      await setDoc(doc(db, "announcementReads", `${ownerUid}_${announcementId}`), {
        ownerUid,
        announcementId,
        readAt: serverTimestamp()
      });
    },
    async createAnnouncement(announcement) {
      if (!activeProfile || !["coach", "trainer"].includes(activeProfile.role)
        || activeProfile.id !== auth.currentUser?.uid) {
        throw new Error("إرسال الإعلانات متاح للمشرف والمدرب المسجلين فقط.");
      }
      const optionalFields = {};
      if (announcement.type) optionalFields.type = announcement.type;
      if (announcement.date) optionalFields.date = announcement.date;
      if (Array.isArray(announcement.targetGuardianIds)) optionalFields.targetGuardianIds = [...new Set(announcement.targetGuardianIds)];
      if (Array.isArray(announcement.sessionIds)) optionalFields.sessionIds = [...new Set(announcement.sessionIds)];
      const reference = await addDoc(collection(db, "announcements"), {
        message: announcement.message,
        authorId: activeProfile.id,
        authorName: activeProfile.name,
        authorRole: activeProfile.role,
        ...optionalFields,
        createdAt: serverTimestamp()
      });
      const saved = await getDoc(reference);
      if (!saved.exists()) throw new Error("تم إنشاء الإعلان ولكن تعذر تحميل النسخة المحفوظة.");
      return { ...saved.data(), id: saved.id };
    },
    async createAdministrativeAbsence(absence) {
      if (!activeProfile || activeProfile.role !== "coach"
        || activeProfile.id !== auth.currentUser?.uid
        || absence.createdBy !== activeProfile.id) {
        throw new Error("تسجيل الغياب الإداري متاح للمشرف المسجل فقط.");
      }
      if (typeof absence.playerId !== "string" || !absence.playerId
        || typeof absence.playerCode !== "string" || !/^\d{6}$/.test(absence.playerCode)
        || typeof absence.isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(absence.isoDate)) {
        throw new Error("بيانات اللاعب أو تاريخ الغياب غير صالحة.");
      }
      const absenceId = `${absence.playerId}_${absence.isoDate}`;
      const reference = doc(db, "administrativeAbsences", absenceId);
      await runTransaction(db, async transaction => {
        const [existing, playerSnapshot] = await Promise.all([
          transaction.get(reference),
          transaction.get(doc(db, "players", absence.playerCode))
        ]);
        if (existing.exists()) throw new Error("تم تسجيل غياب هذا اللاعب في التاريخ نفسه من قبل.");
        if (!playerSnapshot.exists() || playerSnapshot.data().id !== absence.playerId) {
          throw new Error("بيانات اللاعب غير متطابقة. حدّث الصفحة وحاول مرة أخرى.");
        }
        transaction.set(reference, {
          id: absenceId,
          playerId: absence.playerId,
          playerCode: absence.playerCode,
          playerName: absence.playerName,
          isoDate: absence.isoDate,
          dateLabel: absence.dateLabel,
          createdBy: activeProfile.id,
          createdByName: activeProfile.name,
          createdAt: serverTimestamp()
        });
      });
      return {
        ...absence,
        id: absenceId,
        createdBy: activeProfile.id,
        createdByName: activeProfile.name,
        createdAt: Date.now()
      };
    },
    migratePaymentReferenceClaims,
    async saveSubscriptionRequest(subscription, payment) {
      return this.saveSubscriptionRequests([{ subscription, payment }]);
    },
    async saveSubscriptionRequests(submissions) {
      if (!Array.isArray(submissions) || !submissions.length) throw new Error("اختر لاعبًا واحدًا على الأقل لإرسال طلب الدفع.");
      if (submissions.length > 3) throw new Error("يمكن إرسال طلب واحد إلى ثلاثة لاعبين كحد أقصى في العملية نفسها.");
      if (submissions.some(({ payment }) => payment.guardianId !== auth.currentUser?.uid)) {
        throw new Error("لا يمكن إرسال طلب دفع لأبناء حساب ولي الأمر الحالي فقط.");
      }
      if (!auth.currentUser || submissions.some(({ payment }) => auth.currentUser.uid !== payment.guardianId)) {
        throw new Error("لا يمكن إرسال طلب اشتراك لهذا الحساب.");
      }
      const reference = submissions[0].payment.reference;
      if (submissions.some(({ payment }) => payment.reference !== reference)) {
        throw new Error("تعذر التحقق من الرقم المرجعي لطلبات الدفع.");
      }
      const hasTransfer = submissions.some(({ payment }) => Number(payment.amount) > 0);
      if (hasTransfer && (typeof reference !== "string" || reference.trim().length < 4 || reference.trim().length > 120)) {
        throw new Error("أدخل رقمًا مرجعيًا صحيحًا للتحويل.");
      }
      const claimReference = hasTransfer
        ? doc(db, "paymentReferenceClaims", await paymentReferenceClaimId(reference))
        : null;
      const locks = submissions.map(({ subscription, payment }) => ({
        reference: doc(db, "playerPaymentLocks", payment.playerId),
        playerCode: subscription.playerCode,
        playerId: payment.playerId,
        guardianId: payment.guardianId,
        paymentId: payment.id
      }));
      if (new Set(locks.map(lock => lock.playerId)).size !== locks.length) {
        throw new Error("لا يمكن إرسال أكثر من طلب للاعب نفسه في عملية دفع واحدة.");
      }
      const existingPaymentQueries = locks.map(lock => query(
        collection(db, "payments"),
        where("playerId", "==", lock.playerId),
        where("guardianId", "==", auth.currentUser.uid)
      ));
      const paymentBaselines = submissions.map(({ payment, subscription }) => [
        `payments/${payment.id}`,
        baselineValue("payments", { ...withoutPassword(payment), playerCode: subscription.playerCode })
      ]);
      try {
        await runTransaction(db, async transaction => {
          const [claimSnapshot, ...lockSnapshots] = await Promise.all([
            ...(claimReference ? [transaction.get(claimReference)] : [Promise.resolve(null)]),
            ...locks.map(lock => transaction.get(lock.reference)),
            ...existingPaymentQueries.map(paymentQuery => transaction.get(paymentQuery))
          ]);
          const playerPaymentSnapshots = lockSnapshots.splice(locks.length);
          if (claimSnapshot?.exists()) {
            throw new Error("الرقم المرجعي خطأ، هذا الرقم مستخدم بالفعل. تحقق من الرقم المرجعي.");
          }
          if (lockSnapshots.some(snapshot => snapshot.exists())
            || playerPaymentSnapshots.some(snapshot => snapshot.docs.some(document =>
              ["بانتظار المراجعة", "دفع جزئي نقدًا"].includes(document.data().status)))) {
            throw new Error("لدى هذا اللاعب طلب دفع قيد المراجعة بالفعل.");
          }
          if (claimReference) {
            transaction.set(claimReference, {
              ownerUid: auth.currentUser.uid,
              createdAt: serverTimestamp()
            });
          }
          submissions.forEach(({ subscription, payment }) => {
            const safePayment = withoutPassword(payment);
            const lock = locks.find(item => item.paymentId === payment.id);
            transaction.set(doc(db, "subscriptions", subscription.id), {
              playerId: subscription.playerId,
              playerCode: subscription.playerCode,
              playerName: subscription.playerName,
              expectedStartDate: subscription.expectedStartDate,
              transferCode: subscription.transferCode,
              createdAt: serverTimestamp()
            });
            transaction.set(doc(db, "payments", payment.id), {
              ...safePayment,
              playerCode: subscription.playerCode,
              createdAt: payment.createdAt,
              updatedAt: serverTimestamp()
            });
            transaction.set(lock.reference, {
              playerId: lock.playerId,
              playerCode: lock.playerCode,
              guardianId: lock.guardianId,
              paymentId: lock.paymentId,
              ownerUid: auth.currentUser.uid,
              createdAt: serverTimestamp()
            });
          });
        });
      } catch (error) {
        if (error?.message?.includes("الرقم المرجعي خطأ")) throw error;
        if (error?.code === "permission-denied") {
          throw new Error("رفض Firestore حفظ طلب الاشتراك. تأكد من نشر firestore.rules وأن حساب ولي الأمر وبيانات اللاعب متطابقة.");
        }
        throw error;
      }
      paymentBaselines.forEach(([key, value]) => baseline.set(key, value));
    },
    async quotePlayerPayment(planId) {
      if (activeProfile?.role !== "member" || activeProfile.authUid !== auth.currentUser?.uid) {
        throw new Error("طلب تسعير اشتراك اللاعب متاح من جلسة اللاعب الحالية فقط.");
      }
      const requestedPlanId = Number(planId);
      if (!Number.isInteger(requestedPlanId) || requestedPlanId < 1 || requestedPlanId > 7) {
        throw new Error("الباقة المحددة غير صالحة.");
      }
      return runTransaction(db, async transaction => {
        const context = await readPlayerPaymentContext(transaction, auth.currentUser.uid);
        if (context.dayCount !== requestedPlanId) {
          throw new Error("تغيرت أيام تدريب اللاعب. حدّث الصفحة وحاول مجددًا.");
        }
        const fullQuote = playerPaymentQuote(context, "full");
        const halfQuote = playerPaymentQuote(context, "half");
        return {
          playerId: fullQuote.playerId,
          playerName: fullQuote.playerName,
          planId: fullQuote.planId,
          planName: fullQuote.planName,
          monthlyPrice: fullQuote.monthlyPrice,
          walletCreditReserved: fullQuote.walletCreditReserved,
          fullSiblingDiscount: fullQuote.siblingDiscount,
          fullAmount: fullQuote.amount,
          halfAmount: halfQuote.amount
        };
      });
    },
    async createPlayerPaymentRequest(request) {
      if (activeProfile?.role !== "member" || activeProfile.authUid !== auth.currentUser?.uid) {
        throw new Error("إرسال طلب الدفع متاح من جلسة اللاعب الحالية فقط.");
      }
      const duration = request?.subscriptionDuration;
      if (duration !== "full" && duration !== "half") throw new Error("مدة الاشتراك غير صالحة.");
      const planId = Number(request?.planId);
      if (!Number.isInteger(planId) || planId < 1 || planId > 7) throw new Error("الباقة المحددة غير صالحة.");
      const paymentRef = doc(collection(db, "payments"));
      const subscriptionRef = doc(collection(db, "subscriptions"));
      const now = Date.now();
      const reference = typeof request.reference === "string" ? request.reference.trim() : "";

      const payment = await runTransaction(db, async transaction => {
        const context = await readPlayerPaymentContext(transaction, auth.currentUser.uid);
        if (context.dayCount !== planId) {
          throw new Error("تغيرت أيام تدريب اللاعب. حدّث الصفحة وحاول مجددًا.");
        }
        validatePlayerPaymentStartDate(request.expectedStartDate, context.sessions);
        const quote = playerPaymentQuote(context, duration);
        if (Number(request.quotedAmount) !== quote.amount
          || Number(request.quotedMonthlyPrice) !== quote.monthlyPrice
          || Number(request.quotedWalletCredit) !== quote.walletCreditReserved
          || Number(request.quotedSiblingDiscount) !== quote.siblingDiscount) {
          throw new Error("تغير سعر الاشتراك أو رصيد المحفظة أو خصم الإخوة. أعد فتح طلب الدفع.");
        }
        if (quote.amount > 0 && (reference.length < 4 || reference.length > 120)) {
          throw new Error("أدخل رقمًا مرجعيًا صحيحًا للتحويل.");
        }

        const transferCode = quote.amount > 0 ? reference : "رصيد محفظة اللاعب";
        const claimRef = quote.amount > 0
          ? doc(db, "paymentReferenceClaims", await paymentReferenceClaimId(reference))
          : null;
        if (claimRef && (await transaction.get(claimRef)).exists()) {
          throw new Error("الرقم المرجعي مستخدم بالفعل. تحقق من رقم العملية.");
        }
        const savedPayment = {
          id: paymentRef.id,
          guardianId: context.player.guardianId,
          playerId: quote.playerId,
          playerName: quote.playerName,
          planId: quote.planId,
          planName: quote.planName,
          amount: quote.amount,
          walletCreditReserved: quote.walletCreditReserved,
          siblingDiscount: quote.siblingDiscount,
          subscriptionDuration: duration,
          expectedStartDate: request.expectedStartDate,
          reference: transferCode,
          method: "instapay",
          methodLabel: "إنستا باي / محفظة بنكية",
          status: "بانتظار المراجعة",
          createdAt: now,
          date: new Intl.DateTimeFormat("ar-EG", {
            day: "numeric",
            month: "long",
            year: "numeric",
            timeZone: "Africa/Cairo"
          }).format(new Date(now))
        };
        if (claimRef) {
          transaction.set(claimRef, {
            ownerUid: auth.currentUser.uid,
            createdAt: serverTimestamp()
          });
        }
        transaction.set(context.lockRef, {
          playerId: context.player.id,
          playerCode: context.player.playerCode,
          guardianId: context.player.guardianId,
          paymentId: paymentRef.id,
          ownerUid: auth.currentUser.uid,
          createdAt: serverTimestamp()
        });
        transaction.set(subscriptionRef, {
          playerId: quote.playerId,
          playerCode: quote.playerCode,
          playerName: quote.playerName,
          expectedStartDate: request.expectedStartDate,
          transferCode,
          createdAt: serverTimestamp()
        });
        transaction.set(paymentRef, { ...savedPayment, updatedAt: serverTimestamp() });
        return savedPayment;
      });
      baseline.set(`payments/${payment.id}`, baselineValue("payments", {
        ...payment,
        playerCode: activeProfile.playerCode
      }));
      return payment;
    },
    async deleteGuardian(guardian, players) {
      await runTransaction(db, async transaction => {
        const profileRef = doc(db, "users", guardian.id);
        const playerRefs = players.map(player => doc(db, "players", player.playerCode));
        const codeRefs = players.map(player => playerCodeRef(player.playerCode));
        const references = [profileRef, ...playerRefs, ...codeRefs];
        const snapshots = await Promise.all(references.map(reference => transaction.get(reference)));
        snapshots.forEach((snapshot, index) => {
          if (snapshot.exists()) transaction.delete(references[index]);
        });
      });
    }
  };
}

window.firebaseServices = academyServices();
if (!useFirebaseEmulators) {
  isAnalyticsSupported().then(supported => {
    if (supported) getAnalytics(app);
  }).catch(error => console.warn("تعذر تهيئة Firebase Analytics.", error));
}
