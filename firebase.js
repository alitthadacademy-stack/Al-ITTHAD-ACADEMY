import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAnalytics, isSupported as isAnalyticsSupported } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-analytics.js";
import {
  createUserWithEmailAndPassword,
  connectAuthEmulator,
  deleteUser,
  getAuth,
  onIdTokenChanged,
  signInAnonymously,
  signInWithCustomToken,
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
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-functions.js";
import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported as isMessagingSupported,
  onMessage
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging.js";
const firebaseConfig = {
  apiKey: "AIzaSyC9aS9Syk-aeAkRxdfVozcgn_ntufrDU7U",
  authDomain: "al-attihad-academy-68905.firebaseapp.com",
  projectId: "al-attihad-academy-68905",
  messagingSenderId: "6173840281",
  appId: "1:6173840281:web:a02c45aeafef1a455ff908",
  measurementId: "G-T993GGK10Z"
};
const COACH_EMAIL = "al.itthad.academy@gmail.com";
const FIREBASE_WEB_PUSH_VAPID_KEY = "BG_n4zEwQIE8kkSM-H-bUp5smvv9SIdo9tzZ8NFbxAoYJRHBRBjFLqMfN4GJ_M1Bly9x2X1alwPM96mynMc6620";
const FIREBASE_APPCHECK_SITE_KEY = "6LdKV_stAAAAAISGKewc6xy9x-bY1CILrl9yECS-";

const useFirebaseEmulators = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get("emulator") === "1";
const app = initializeApp(useFirebaseEmulators
  ? { ...firebaseConfig, projectId: "demo-alittihad-academy" }
  : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
if (!useFirebaseEmulators && FIREBASE_APPCHECK_SITE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(FIREBASE_APPCHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
}
if (useFirebaseEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
let foregroundMessageUnsubscribe = null;
let activeSessionUnsubscribe = null;

function requireAppCheckConfiguration() {
  if (!useFirebaseEmulators && !FIREBASE_APPCHECK_SITE_KEY) {
    throw new Error("يلزم إعداد مفتاح Firebase App Check للموقع قبل تسجيل الدخول. أضف مفتاح reCAPTCHA v3 في firebase.js ثم أعد النشر.");
  }
}

async function closeActiveDeviceSession() {
  const user = auth.currentUser;
  if (!user) return;
  const { claims } = await user.getIdTokenResult();
  if (claims.playerSession === true) {
    await httpsCallable(functions, "closePlayerSession")({});
  }
}

async function notificationTokenDocumentId(ownerUid, token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const tokenHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${ownerUid}_${tokenHash}`;
}

function notificationProfileReference(profile) {
  if (profile.role === "member") {
    if (typeof profile.playerCode !== "string" || !/^\d{6}$/.test(profile.playerCode)) {
      throw new Error("تعذر تحديد ملف اللاعب لحفظ رمز الإشعارات.");
    }
    return doc(db, "players", profile.playerCode);
  }
  if (typeof profile.id !== "string" || !profile.id) {
    throw new Error("تعذر تحديد ملف المستخدم لحفظ رمز الإشعارات.");
  }
  return doc(db, "users", profile.id);
}

async function syncProfileFcmToken(profile, token) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("انتهت جلسة المستخدم قبل تحديث رمز الإشعارات.");
  const tokens = await getDocs(query(collection(db, "notificationTokens"), where("ownerUid", "==", uid)));
  const activeToken = token || tokens.docs
    .map(document => document.data().token)
    .find(value => typeof value === "string" && value.length > 0);
  await updateDoc(notificationProfileReference(profile), {
    fcmToken: activeToken || deleteField()
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

async function messagingClient() {
  if (useFirebaseEmulators) {
    throw new Error("إشعارات Firebase معطلة في وضع المحاكيات لتجنب الاتصال بخدمات الإنتاج.");
  }
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  if (window.location.protocol !== "https:" && !(window.location.protocol === "http:" && localHost)) {
    throw new Error("إشعارات Firebase تحتاج فتح الأكاديمية من رابط HTTPS، وليس من ملف على الجهاز.");
  }
  if (!FIREBASE_WEB_PUSH_VAPID_KEY) {
    throw new Error("إشعارات الهاتف غير مهيأة بعد. أضف مفتاح Web Push من Firebase Console إلى FIREBASE_WEB_PUSH_VAPID_KEY في firebase.js.");
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !(await isMessagingSupported())) {
    throw new Error("هذا المتصفح أو الجهاز لا يدعم إشعارات Firebase. افتح الموقع عبر HTTPS على متصفح حديث.");
  }
  const legacyWorkerUrl = new URL("./public/firebase-messaging-sw.js", document.baseURI).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const legacyRegistrations = registrations.filter(registration =>
    [registration.installing, registration.waiting, registration.active]
      .some(worker => worker?.scriptURL === legacyWorkerUrl)
  );
  await Promise.all(legacyRegistrations.map(registration => registration.unregister()));
  const workerUrl = new URL("./firebase-messaging-sw.js", document.baseURI);
  const registration = await navigator.serviceWorker.register(workerUrl);
  const messaging = getMessaging(app);
  return { messaging, registration };
}

async function subscribeUserToNotifications(profile) {
  const uid = auth.currentUser?.uid;
  if (!profile || !["guardian", "member", "coach", "trainer"].includes(profile.role) || !uid) {
    throw new Error("تفعيل إشعارات الهاتف متاح للحسابات المسجلة في الأكاديمية فقط.");
  }
  const profileUid = profile.role === "member" ? profile.authUid : profile.id;
  if (uid !== profileUid) {
    throw new Error("حساب المستخدم الحالي لا يطابق ملف الإشعارات.");
  }
  if (Notification.permission !== "granted") {
    throw new Error("يجب السماح بإشعارات الأكاديمية من إعدادات المتصفح أولًا.");
  }
  const { messaging, registration } = await messagingClient();
  const token = await getToken(messaging, { vapidKey: FIREBASE_WEB_PUSH_VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) throw new Error("لم يتمكن Firebase من إنشاء رمز إشعارات لهذا الجهاز.");
  const tokenId = await notificationTokenDocumentId(uid, token);
  await setDoc(doc(db, "notificationTokens", tokenId), {
    ownerUid: uid,
    ...(["guardian", "member"].includes(profile.role)
      ? { guardianId: profile.role === "guardian" ? profile.id : profile.guardianId }
      : {}),
    ...(profile.role === "member" ? { playerId: profile.id } : {}),
    role: profile.role,
    token,
    updatedAt: serverTimestamp()
  });
  await syncProfileFcmToken(profile, token);
  if (!foregroundMessageUnsubscribe) {
    foregroundMessageUnsubscribe = onMessage(messaging, payload => {
      const title = payload.data?.title || "الاتحاد أكادمي";
      const body = payload.data?.body || "لديك تحديث جديد من الأكاديمية.";
      if (Notification.permission === "granted") {
        registration.showNotification(title, {
          body,
          icon: "./app-icon.svg?v=2",
          badge: "./app-icon.svg?v=2",
          tag: payload.data?.eventId || undefined,
          data: { url: payload.data?.url || "/" }
        });
      }
    });
  }
  return tokenId;
}

async function unsubscribeUserFromNotifications(profile) {
  const uid = auth.currentUser?.uid;
  if (!profile || !["guardian", "member", "coach", "trainer"].includes(profile.role) || !uid) {
    throw new Error("إدارة إشعارات الهاتف متاحة للحسابات المسجلة في الأكاديمية فقط.");
  }
  const profileUid = profile.role === "member" ? profile.authUid : profile.id;
  if (uid !== profileUid) {
    throw new Error("حساب المستخدم الحالي لا يطابق ملف الإشعارات.");
  }
  const { messaging } = await messagingClient();
  const token = await getToken(messaging, { vapidKey: FIREBASE_WEB_PUSH_VAPID_KEY });
  if (token) {
    const tokenId = await notificationTokenDocumentId(uid, token);
    await deleteDoc(doc(db, "notificationTokens", tokenId));
    await deleteToken(messaging);
  }
  await syncProfileFcmToken(profile, null);
  foregroundMessageUnsubscribe?.();
  foregroundMessageUnsubscribe = null;
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
        activeSessionUnsubscribe?.();
        activeSessionUnsubscribe = null;
        if (user) {
          try {
            const { claims } = await user.getIdTokenResult();
            let sessionRef = null;
            if (claims.playerSession === true) {
              sessionRef = doc(db, "playerSessions", user.uid);
            }
            if (sessionRef) {
              activeSessionUnsubscribe = onSnapshot(sessionRef, snapshot => {
                if (!snapshot.exists() || snapshot.data().active !== true) {
                  signOut(auth).catch(error => console.error("تعذر إنهاء جلسة جهاز تم استبدالها.", error));
                }
              }, error => {
                console.error("تعذر التحقق من صلاحية جلسة هذا الجهاز.", error);
                signOut(auth).catch(signOutError => console.error("تعذر إنهاء جلسة جهاز غير صالحة.", signOutError));
              });
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
        let saved = false;
        for (let attempt = 0; attempt < 10 && !saved; attempt += 1) {
          const codes = new Set();
          while (codes.size < registeredPlayers.length) {
            const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
            codes.add(String(value).padStart(6, "0"));
          }
          const playerCodes = [...codes];
          const playersWithCodes = registeredPlayers.map((player, index) => ({
            ...player,
            playerCode: playerCodes[index]
          }));
          const batch = writeBatch(db);
          batch.set(profileRef, { ...guardianProfile, createdAt: serverTimestamp() });
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
            registeredPlayers.splice(0, registeredPlayers.length, ...playersWithCodes);
            saved = true;
          } catch (error) {
            if (error?.code !== "permission-denied" || attempt === 9) {
              if (error?.code === "permission-denied") {
                throw new Error("تعذر حفظ الحساب أو حجز كود لاعب فريد. تحقق من نشر قواعد Firestore المحدّثة ثم حاول مرة أخرى.");
              }
              throw error;
            }
          }
        }
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
        } else {
          await signOut(auth);
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
        if (auth.currentUser) {
          try {
            await closeActiveDeviceSession();
          } catch (closeError) {
            console.error("تعذر تحرير الجلسة السابقة قبل دخول اللاعب.", closeError);
          }
          await signOut(auth);
        }
        const credential = await signInAnonymously(auth);
        const result = await httpsCallable(functions, "loginPlayerWithCode")({ code });
        await signInWithCustomToken(auth, result.data.token);
        const codeSnapshot = await getDoc(doc(db, "players", code));
        if (!codeSnapshot.exists()) throw new Error("لم يتم العثور على بيانات اللاعب.");
        const player = codeSnapshot.data();
        if (player.activePlayerSessionUid !== auth.currentUser?.uid) {
          throw new Error("تم تسجيل دخول اللاعب من جهاز آخر. أعد تسجيل الدخول بهذا الجهاز.");
        }
        return { ...player, id: player.id || code, role: "member", authUid: credential.user.uid };
      } catch (error) {
        if (auth.currentUser) {
          try {
            await closeActiveDeviceSession();
          } catch (closeError) {
            console.error("تعذر تحرير جلسة اللاعب بعد فشل الدخول.", closeError);
          }
          await signOut(auth);
        }
        if (error?.code === "auth/configuration-not-found" || error?.code === "auth/operation-not-allowed") {
          throw new Error("دخول اللاعبين يحتاج إلى تفعيل Firebase Authentication → Sign-in method → Anonymous في مشروع الأكاديمية.");
        }
        if (error?.code === "permission-denied") {
          throw new Error("تعذر التحقق من جلسة اللاعب. تأكد من نشر وظائف Firebase وقواعد Firestore المحدّثة.");
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
      if (claims.playerSession === true) {
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
        payments: state.payments.map(record => ({ ...record, guardianId: record.guardianId || playerForId.get(record.playerId)?.guardianId })),
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
          batch.set(doc(db, name, id), { ...safeRecord, updatedAt: serverTimestamp() }, { merge: true });
          baselineUpdates.push([key, serialized]);
          operationCount += 1;
          if (operationCount === 500) {
            batches.push(batch);
            batch = writeBatch(db);
            operationCount = 0;
          }
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
      await deleteDoc(doc(db, collectionName, id));
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
    subscribeUserToNotifications,
    unsubscribeUserFromNotifications,
    migratePaymentReferenceClaims,
    async saveSubscriptionRequest(subscription, payment) {
      return this.saveSubscriptionRequests([{ subscription, payment }]);
    },
    async saveSubscriptionRequests(submissions) {
      if (!Array.isArray(submissions) || !submissions.length) throw new Error("اختر لاعبًا واحدًا على الأقل لإرسال طلب الدفع.");
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
      const paymentBaselines = submissions.map(({ payment, subscription }) => [
        `payments/${payment.id}`,
        baselineValue("payments", { ...withoutPassword(payment), playerCode: subscription.playerCode })
      ]);
      try {
        await runTransaction(db, async transaction => {
          if (claimReference) {
            const existingClaim = await transaction.get(claimReference);
            if (existingClaim.exists()) {
              throw new Error("الرقم المرجعي خطأ، هذا الرقم مستخدم بالفعل. تحقق من الرقم المرجعي.");
            }
            transaction.set(claimReference, {
              ownerUid: auth.currentUser.uid,
              createdAt: serverTimestamp()
            });
          }
          submissions.forEach(({ subscription, payment }) => {
            const safePayment = withoutPassword(payment);
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
      const quotePlayerPayment = httpsCallable(functions, "quotePlayerPayment");
      const result = await quotePlayerPayment({ planId });
      return result.data;
    },
    async createPlayerPaymentRequest(request) {
      if (activeProfile?.role !== "member" || activeProfile.authUid !== auth.currentUser?.uid) {
        throw new Error("إرسال طلب الدفع متاح من جلسة اللاعب الحالية فقط.");
      }
      const createPlayerPaymentRequest = httpsCallable(functions, "createPlayerPaymentRequest");
      const result = await createPlayerPaymentRequest(request);
      return result.data.payment;
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
