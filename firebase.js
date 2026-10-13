import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAnalytics, isSupported as isAnalyticsSupported } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-analytics.js";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function createPlayerCode(existingCodes) {
  let code;
  do {
    code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
}

function withoutPassword(record) {
  const { password, __docId, createdAt, updatedAt, ...safeRecord } = record;
  return safeRecord;
}

function playerForFirestore(player) {
  const { guardian, guardianPhone, whatsappPhone, password, __docId, createdAt, updatedAt, ...safePlayer } = player;
  return safePlayer;
}

async function assignedTrainersFor(category) {
  const sessions = await getDocs(collection(db, "sessions"));
  return [...new Set(sessions.docs
    .map(snapshot => snapshot.data())
    .filter(session => session.category === "جميع الفئات العمرية" || session.category === category || category === "جميع الفئات العمرية")
    .map(session => session.coachId)
    .filter(Boolean))];
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
  if (name === "sessions") return profile.role === "member" ? query(all, where("category", "in", ["جميع الفئات العمرية", profile.category])) : all;
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
  const names = ["players", "sessions"];
  if (profile.role !== "member") names.unshift("users");
  names.push("attendance");
  if (profile.role !== "trainer") names.push("payments", "attendanceExceptions");
  if (profile.role === "coach") names.push("trainerAttendance");
  if (profile.role === "coach") names.push("expenses");
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
    expenses: ["coach"]
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
      const guardian = state.users.find(user => user.id === appRecord.guardianId && user.role === "guardian");
      appRecord.guardian = guardian?.name || "";
      appRecord.guardianPhone ||= guardian?.guardianPhone || "";
      appRecord.whatsappPhone ||= guardian?.whatsappPhone || appRecord.guardianPhone;
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
      return onAuthStateChanged(auth, callback);
    },
    async registerGuardian(guardian, players) {
      const credential = await createUserWithEmailAndPassword(auth, guardian.email.trim(), guardian.password);
      try {
        await updateProfile(credential.user, { displayName: guardian.name });
        const guardianProfile = {
          ...withoutPassword(guardian),
          id: credential.user.uid,
          email: credential.user.email,
          role: "guardian",
          joinedAt: guardian.joinedAt
        };
        const usedCodes = new Set();
        const registeredPlayers = players.map(player => ({
          ...player,
          guardianId: credential.user.uid,
          playerCode: createPlayerCode(usedCodes)
        }));
        for (const player of registeredPlayers) player.assignedTrainerIds = await assignedTrainersFor(player.category);
        await runTransaction(db, async transaction => {
          const profileRef = doc(db, "users", credential.user.uid);
          const profileSnapshot = await transaction.get(profileRef);
          if (profileSnapshot.exists()) throw new Error("هذا الحساب مسجل بالفعل.");
          const playerRefs = registeredPlayers.map(player => doc(db, "players", player.playerCode));
          const codeRefs = registeredPlayers.map(player => playerCodeRef(player.playerCode));
          const playerSnapshots = await Promise.all(playerRefs.map(reference => transaction.get(reference)));
          const codeSnapshots = await Promise.all(codeRefs.map(reference => transaction.get(reference)));
          if (playerSnapshots.some(snapshot => snapshot.exists()) || codeSnapshots.some(snapshot => snapshot.exists())) {
            throw new Error("تعذر حجز أكواد الأبناء. حاول إنشاء الحساب مرة أخرى.");
          }
          transaction.set(profileRef, { ...guardianProfile, createdAt: serverTimestamp() });
          registeredPlayers.forEach((player, index) => {
            const safePlayer = playerForFirestore(player);
            transaction.set(playerRefs[index], { ...safePlayer, createdAt: serverTimestamp() });
            transaction.set(codeRefs[index], { playerId: player.id, playerCode: player.playerCode });
            baseline.set(`players/${player.playerCode}`, baselineValue("players", safePlayer));
          });
          baseline.set(`users/${credential.user.uid}`, baselineValue("users", guardianProfile));
        });
        return { profile: guardianProfile, players: registeredPlayers };
      } catch (error) {
        try {
          await deleteUser(credential.user);
        } catch (cleanupError) {
          console.error("تعذر تنظيف حساب Authentication بعد فشل التسجيل.", cleanupError);
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
        const credential = await signInAnonymously(auth);
        const codeSnapshot = await getDoc(playerCodeRef(code));
        if (!codeSnapshot.exists()) throw new Error("كود اللاعب غير صحيح.");
        await setDoc(doc(db, "playerSessions", credential.user.uid), { playerCode: code, createdAt: serverTimestamp() });
        const playerSnapshot = await getDoc(doc(db, "players", code));
        if (!playerSnapshot.exists()) throw new Error("لم يتم العثور على بيانات اللاعب.");
        return { ...playerSnapshot.data(), id: playerSnapshot.data().id || playerSnapshot.id, role: "member", authUid: credential.user.uid };
      } catch (error) {
        if (auth.currentUser?.isAnonymous) await signOut(auth);
        if (error?.code === "auth/configuration-not-found" || error?.code === "auth/operation-not-allowed") {
          throw new Error("دخول اللاعبين يحتاج إلى تفعيل Firebase Authentication → Sign-in method → Anonymous في مشروع الأكاديمية.");
        }
        if (error?.code === "permission-denied") {
          throw new Error("تعذر الوصول إلى كود اللاعب. تأكد من نشر firestore.rules وأن الكود تابع للاعب مسجل في Firestore.");
        }
        throw error;
      }
    },
    async createPlayer(player, existingCodes) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const codes = new Set(existingCodes);
        const playerCode = createPlayerCode(codes);
        const playerRef = doc(db, "players", playerCode);
        const codeRef = playerCodeRef(playerCode);
        const record = {
          ...playerForFirestore(player),
          playerCode,
          assignedTrainerIds: await assignedTrainersFor(player.category)
        };
        const created = await runTransaction(db, async transaction => {
          const playerSnapshot = await transaction.get(playerRef);
          const codeSnapshot = await transaction.get(codeRef);
          if (playerSnapshot.exists() || codeSnapshot.exists()) return false;
          transaction.set(playerRef, { ...record, createdAt: serverTimestamp() });
          transaction.set(codeRef, { playerId: record.id, playerCode });
          return true;
        });
        if (created) {
          baseline.set(`players/${playerCode}`, baselineValue("players", record));
          return { ...player, playerCode, assignedTrainerIds: record.assignedTrainerIds };
        }
      }
      throw new Error("تعذر توليد كود فريد للاعب. حاول مرة أخرى.");
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
    async currentProfile(user) {
      if (user.isAnonymous) {
        const session = await getDoc(doc(db, "playerSessions", user.uid));
        if (!session.exists()) return null;
        const code = session.data().playerCode;
        const player = await getDoc(doc(db, "players", code));
        if (!player.exists()) return null;
        return { ...player.data(), id: player.data().id || player.id, role: "member", authUid: user.uid };
      }
      return getProfile(user);
    },
    async signOut() {
      stopWatching();
      await signOut(auth);
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
            session.category === "جميع الفئات العمرية" || session.category === record.category || record.category === "جميع الفئات العمرية"
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
        expenses: profile.role === "coach" ? state.expenses : []
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
    async saveSubscriptionRequest(subscription, payment) {
      if (!auth.currentUser || auth.currentUser.uid !== payment.guardianId) throw new Error("لا يمكن إرسال طلب اشتراك لهذا الحساب.");
      const safePayment = withoutPassword(payment);
      const batch = writeBatch(db);
      batch.set(doc(db, "subscriptions", subscription.id), {
        playerName: subscription.playerName,
        transferCode: subscription.transferCode,
        createdAt: serverTimestamp()
      });
      batch.set(doc(db, "payments", payment.id), {
        ...safePayment,
        createdAt: payment.createdAt,
        updatedAt: serverTimestamp()
      });
      try {
        await batch.commit();
      } catch (error) {
        if (error?.code === "permission-denied") {
          throw new Error("رفض Firestore حفظ طلب الاشتراك. تأكد من نشر firestore.rules وأن حساب ولي الأمر وبيانات اللاعب متطابقة.");
        }
        throw error;
      }
      baseline.set(`payments/${payment.id}`, baselineValue("payments", safePayment));
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
isAnalyticsSupported().then(supported => {
  if (supported) getAnalytics(app);
}).catch(error => console.warn("تعذر تهيئة Firebase Analytics.", error));
