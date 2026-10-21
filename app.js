const STORAGE_KEY = "alEtihadAcademy.portal.v1";
const WEEK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const DEFAULT_WORK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const DEFAULT_DAY_PRICES = { 1: 400, 2: 760, 3: 1020, 4: 1200, 5: 1400, 6: 1600, 7: 1800 };
const DEFAULT_INSTAPAY_NUMBER = "01017692213";
const SUBSCRIPTION_DURATIONS = { full: { label: "شهر كامل", days: 30, sessionMultiplier: 1 }, half: { label: "نصف شهر", days: 15, sessionMultiplier: 0.5 } };
const AGE_CATEGORIES = ["أطفال حتى ٦ سنوات", "براعم تحت ١٠", "ناشئين تحت ١٤", "شباب تحت ١٨", "شباب ١٨+", "جميع الفئات العمرية"];
const SIBLING_DISCOUNT_PER_PLAYER = 50;
const OWNER_NAME = "حازم الدخاخني";
const arabicDigits = value => String(value).replace(/\d/g, digit => "٠١٢٣٤٥٦٧٨٩"[digit]);
const egyptianDate = new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long", year: "numeric" });
const byId = id => document.getElementById(id);
const toast = byId("toast");
const offlineMessage = "لا يوجد اتصال بالإنترنت، يُرجى التحقق من الاتصال بالإنترنت.";
let toastTimeout;
let currentUser = null;
let activeView = "home";
let viewHistory = [];
let selectedPlayerId = null;
let selectedLegacyPlayerId = null;
let legacyPlayerSearch = "";
let guardianReportSearch = "";
let selectedReportGuardianId = "";
let guardianReport = null;
let guardianReportLoading = false;
let guardianReportError = "";
let data = loadData();
let cloudProfile = null;
let cloudWriteQueue = Promise.resolve();
let authFlowInProgress = false;
let introFinished = false;
let initialAuthResolved = false;
let appUserReady = false;
let startupReady = false;
let connectionCheckInProgress = false;
let connectionRetryTimer = null;
let firebaseObserverStarted = false;
let attendanceClockInterval = null;

function notificationConsentStorageKey(userId) {
  return `${STORAGE_KEY}.push.${userId}`;
}

function notificationSubscriptionStorageKey(userId) {
  return `${STORAGE_KEY}.push.subscription.${userId}`;
}

function supportsPushNotificationsOnThisOrigin() {
  return window.location.protocol === "https:"
    || (window.location.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname));
}

async function requestNotificationPermission(consent) {
  if (consent !== "accept" || !("Notification" in window) || !supportsPushNotificationsOnThisOrigin()) return null;
  let permission = Notification.permission;
  if (permission === "default" && window.isSecureContext) {
    permission = await Notification.requestPermission();
  }
  return permission;
}

function saveNotificationConsent(userId, consent, permission) {
  localStorage.setItem(
    notificationConsentStorageKey(userId),
    consent === "decline" ? "declined" : permission === "granted" ? "accepted" : "pending"
  );
}

function hasAcceptedNotifications(user) {
  if (!user || !["guardian", "member", "coach", "trainer"].includes(user.role)) return false;
  const choice = localStorage.getItem(notificationConsentStorageKey(user.id));
  if (choice === "declined") return false;
  return choice === "accepted" || choice === "enabled"
    || ("Notification" in window && Notification.permission === "granted");
}

function hasNotificationSubscription(user) {
  if (!user || !["guardian", "member", "coach", "trainer"].includes(user.role)) return false;
  return "Notification" in window
    && Notification.permission === "granted"
    && (localStorage.getItem(notificationSubscriptionStorageKey(user.id)) === "enabled"
      || localStorage.getItem(notificationConsentStorageKey(user.id)) === "enabled");
}

function emptyData() {
  return { users: [], sessions: [], announcements: [], payments: [], attendance: [], administrativeAbsences: [], attendanceExceptions: [], trainerAttendance: [], expenses: [], revenues: [], instaPayAddress: DEFAULT_INSTAPAY_NUMBER, paymentDestinationType: "instapay", workDays: [...DEFAULT_WORK_DAYS], pricesByDays: { ...DEFAULT_DAY_PRICES } };
}

function loadData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return emptyData();
  try {
    const parsed = JSON.parse(saved);
    const workDays = Array.isArray(parsed.workDays) ? parsed.workDays.filter(day => WEEK_DAYS.includes(day)) : [...DEFAULT_WORK_DAYS];
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    const usedCodes = new Set();
    const migratedGuardians = [];
    const normalizedUsers = users.map(user => {
      if (user.role !== "member") {
        const { password, ...safeUser } = user;
        return safeUser;
      }
      const legacyDayCount = { basic: 2, plus: 3, pro: 4 }[user.plan] || user.weeklyDaysCount || 2;
      let playerCode = String(user.playerCode || "");
      if (!/^\d{6}$/.test(playerCode) || usedCodes.has(playerCode)) playerCode = createPlayerCode(usedCodes);
      else usedCodes.add(playerCode);
      const guardianId = user.guardianId || crypto.randomUUID();
      if (!user.guardianId) {
        migratedGuardians.push({
          id: guardianId,
          role: "guardian",
          name: user.guardian || user.name,
          guardianPhone: user.guardianPhone || "",
          whatsappPhone: user.whatsappPhone || user.guardianPhone || "",
          joinedAt: user.joinedAt || new Date().toISOString()
        });
      }
      const { password, ...safeUser } = user;
      return {
        ...safeUser,
        guardianId,
        playerCode,
        joinedAt: user.joinedAt || new Date().toISOString(),
        weeklyDays: Array.isArray(user.weeklyDays) ? user.weeklyDays : workDays.slice(0, legacyDayCount),
        weeklyDaysCount: user.weeklyDaysCount || legacyDayCount,
        plan: legacyDayCount,
        walletBalance: Math.max(0, Math.floor(Number(user.walletBalance) || 0)),
        expectedStartDate: user.expectedStartDate || user.subscriptionStart || null,
        actualStartDate: user.actualStartDate || user.subscriptionStart || null,
        subscriptionEnd: user.subscriptionEnd || user.endDate || null,
        endDate: user.endDate || user.subscriptionEnd || null,
        attendanceLogs: Array.isArray(user.attendanceLogs) ? user.attendanceLogs : []
      };
    });
    const legacyDemoIds = new Set(["s1", "s2", "s3", "s4"]);
    const legacyPlanDays = { basic: 2, plus: 3, pro: 4 };
    const sessions = (Array.isArray(parsed.sessions) ? parsed.sessions : []).filter(session => !legacyDemoIds.has(session.id));
    return {
      users: [...normalizedUsers, ...migratedGuardians],
      sessions: sessions.map(session => ({
        ...session,
        coach: session.coach || OWNER_NAME,
        categories: Array.isArray(session.categories) && session.categories.some(category => AGE_CATEGORIES.includes(category))
          ? [...new Set(session.categories.filter(category => AGE_CATEGORIES.includes(category)))]
          : [AGE_CATEGORIES.includes(session.category) ? session.category : "جميع الفئات العمرية"],
        category: Array.isArray(session.categories) && session.categories.some(category => AGE_CATEGORIES.includes(category))
          ? [...new Set(session.categories.filter(category => AGE_CATEGORIES.includes(category)))].join("، ")
          : AGE_CATEGORIES.includes(session.category) ? session.category : "جميع الفئات العمرية"
      })),
      announcements: Array.isArray(parsed.announcements) ? parsed.announcements : [],
      payments: Array.isArray(parsed.payments) ? parsed.payments.map(payment => ({
        ...payment,
        planId: legacyPlanDays[payment.planId] || payment.planId,
        method: payment.method || "instapay",
        methodLabel: payment.method === "cash" ? "نقدي" : "إنستا باي / محفظة بنكية"
      })) : [],
      attendance: Array.isArray(parsed.attendance) ? parsed.attendance.map(record => ({
        ...record,
        status: record.status || "حاضر",
        timestamp: Number(record.timestamp) || Date.now(),
        isoDate: record.isoDate || localDateString(new Date(Number(record.timestamp) || Date.now()))
      })) : [],
      administrativeAbsences: Array.isArray(parsed.administrativeAbsences) ? parsed.administrativeAbsences : [],
      attendanceExceptions: Array.isArray(parsed.attendanceExceptions) ? parsed.attendanceExceptions : [],
      trainerAttendance: Array.isArray(parsed.trainerAttendance) ? parsed.trainerAttendance : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      revenues: Array.isArray(parsed.revenues) ? parsed.revenues : [],
      instaPayAddress: DEFAULT_INSTAPAY_NUMBER,
      paymentDestinationType: "instapay",
      workDays,
      pricesByDays: { ...DEFAULT_DAY_PRICES, ...(parsed.pricesByDays || {}) }
    };
  } catch (error) {
    console.error("تعذر قراءة بيانات الأكاديمية المحفوظة.", error);
    return emptyData();
  }
}

function createPlayerCode(existingCodes = new Set(data?.users?.map(user => user.playerCode).filter(Boolean) || [])) {
  let code;
  do {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    code = String(value % 1000000).padStart(6, "0");
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
}

function playerCategoryForBirthDate(birthDate) {
  const birthday = new Date(`${birthDate}T12:00:00`);
  if (Number.isNaN(birthday.getTime()) || birthDate > localDateString()) return null;
  let age = new Date().getFullYear() - birthday.getFullYear();
  if (new Date().getMonth() < birthday.getMonth() || (new Date().getMonth() === birthday.getMonth() && new Date().getDate() < birthday.getDate())) age -= 1;
  return age <= 6 ? "أطفال حتى ٦ سنوات" : age < 10 ? "براعم تحت ١٠" : age < 14 ? "ناشئين تحت ١٤" : age < 18 ? "شباب تحت ١٨" : "شباب ١٨+";
}

function pendingPlayerCategory(player) {
  if (!player?.birthDate || !AGE_CATEGORIES.includes(player.category) || player.category === "جميع الفئات العمرية") return null;
  const currentCategory = playerCategoryForBirthDate(player.birthDate);
  return currentCategory && currentCategory !== player.category ? currentCategory : null;
}

function saveLocalData() {
  try {
    const safeData = { ...data, users: data.users.map(user => {
      const { password, ...safeUser } = user;
      return safeUser;
    }) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeData));
    return true;
  } catch (error) {
    console.error("تعذر حفظ بيانات الأكاديمية في هذا المتصفح.", error);
    showToast("تعذر حفظ البيانات. تحقق من مساحة التخزين في المتصفح.");
    return false;
  }
}

function saveData() {
  if (!saveLocalData()) return false;
  if (cloudProfile) {
    const snapshot = JSON.parse(JSON.stringify(data));
    queueCloudSave(snapshot, cloudProfile);
  }
  return true;
}

function queueCloudSave(snapshot, profile) {
  cloudWriteQueue = cloudWriteQueue
    .then(() => window.firebaseReady)
    .then(firebase => firebase.saveAcademyData(snapshot, profile))
    .catch(error => {
      console.error("تعذر حفظ تغييرات الأكاديمية في Firestore.", error);
      showToast(error instanceof Error ? `تعذر الحفظ سحابيًا: ${error.message}` : "تعذر حفظ التغييرات سحابيًا.");
    });
}

saveLocalData();

function showToast(message) {
  const networkFailure = !navigator.onLine
    || ["auth/network-request-failed", "network-request-failed"].includes(message?.code)
    || /failed to fetch|network[- ]request[- ]failed|network error|client is offline/i.test(message);
  toast.querySelector("p").textContent = networkFailure ? offlineMessage : message;
  toast.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function updateConnectivityStatus() {
  const offline = !navigator.onLine;
  if (!offline) return;
  byId("connection-screen").hidden = false;
  byId("connection-status").textContent = "لا يتوفر اتصال بالإنترنت. أعد المحاولة أو انتظر عودة الاتصال.";
  byId("connection-retry").disabled = false;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function whatsappPhone(phone) {
  return String(phone).replace(/\D/g, "").replace(/^0/, "20");
}

function guardianWhatsApp(user, message, label = "إشعار ولي الأمر") {
  const number = user?.whatsappPhone || user?.guardianPhone;
  if (!number) return "لم يسجل رقم ولي الأمر";
  const url = `https://wa.me/${whatsappPhone(number)}?text=${encodeURIComponent(message)}`;
  return `<a class="text-link whatsapp-link" target="_blank" rel="noopener" href="${url}">${label}</a>`;
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addCalendarDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localDateString(date) === value;
}

function expectedStartDateFor(user) {
  const today = localDateString();
  const previousEnd = user?.endDate || user?.subscriptionEnd;
  if (previousEnd && previousEnd >= today) return addCalendarDays(previousEnd, 1);
  const subscriptionStatus = evaluateSubscriptionStartStatus(user);
  if (subscriptionStatus.status === "continuous") return subscriptionStatus.firstPostExpiryAttendance;
  const partialPayment = data.payments
    .filter(payment => payment.playerId === user?.id && payment.status === "دفع جزئي نقدًا" && payment.expectedStartDate)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return partialPayment?.expectedStartDate >= today ? partialPayment.expectedStartDate : today;
}

function evaluateSubscriptionStartStatus(user) {
  const previousEndDate = user?.endDate || user?.subscriptionEnd || null;
  const hasPreviousSubscription = Boolean(
    previousEndDate
    || user?.subscriptionStart
    || user?.actualStartDate
    || data.payments.some(payment =>
      payment.playerId === user?.id
      && ["تم التأكيد", "تم الدفع نقدًا", "تم استكمال الدفع النقدي"].includes(payment.status)
    )
  );
  if (!hasPreviousSubscription) return { status: "new", previousEndDate: null, firstPostExpiryAttendance: null };
  if (previousEndDate && previousEndDate >= localDateString()) {
    return { status: "active", previousEndDate, firstPostExpiryAttendance: null };
  }
  const firstPostExpiryAttendance = previousEndDate
    ? data.attendance
      .filter(record => record.playerId === user.id
        && record.isoDate > previousEndDate
        && (record.attendedUnpaid || ["حاضر", "متأخر", "معذور"].includes(record.status)))
      .map(record => record.isoDate)
      .filter(isValidIsoDate)
      .sort()[0] || null
    : null;
  return firstPostExpiryAttendance
    ? { status: "continuous", previousEndDate, firstPostExpiryAttendance }
    : { status: "returning", previousEndDate, firstPostExpiryAttendance: null };
}

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩۰-۹]/g, digit => {
    const digitCode = digit.charCodeAt(0);
    return String(digitCode >= 0x06f0 ? digitCode - 0x06f0 : digitCode - 0x0660);
  });
}

function sessionClockParts(value) {
  const rawTime = normalizeDigits(value || "").trim().toLocaleLowerCase("ar");
  const match = rawTime.match(/(\d{1,2})\s*[:٫]\s*(\d{2})/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const isPm = /مساء|(?:^|\s)م(?:\s|$)|pm/.test(rawTime);
  const isAm = /صباح|(?:^|\s)ص(?:\s|$)|am/.test(rawTime);
  if (minutes > 59 || (isAm && isPm)) return null;
  if (isAm || isPm) {
    if (hours < 1 || hours > 12) return null;
    return { hour: String(hours), minute: String(minutes).padStart(2, "0"), period: isPm ? "pm" : "am" };
  }
  if (hours > 23) return null;
  const period = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return { hour: String(hours), minute: String(minutes).padStart(2, "0"), period };
}

function sessionTimePicker(name, label, value) {
  const parts = sessionClockParts(value);
  const hourOptions = Array.from({ length: 12 }, (_, index) => {
    const hour = String(index + 1);
    return `<option value="${hour}" ${parts?.hour === hour ? "selected" : ""}>${arabicDigits(hour)}</option>`;
  }).join("");
  const minuteOptions = Array.from({ length: 60 }, (_, minute) => {
    const value = String(minute).padStart(2, "0");
    return `<option value="${value}" ${parts?.minute === value ? "selected" : ""}>${arabicDigits(value)}</option>`;
  }).join("");
  return `<fieldset class="session-time-field"><legend>${label}</legend><div class="session-time-picker"><label>الساعة<select name="${name}Hour" required><option value="" disabled ${parts ? "" : "selected"}>اختر</option>${hourOptions}</select></label><label>الدقيقة<select name="${name}Minute" required><option value="" disabled ${parts ? "" : "selected"}>اختر</option>${minuteOptions}</select></label><label>الفترة<select name="${name}Period" required><option value="" disabled ${parts ? "" : "selected"}>اختر</option><option value="am" ${parts?.period === "am" ? "selected" : ""}>صباحًا</option><option value="pm" ${parts?.period === "pm" ? "selected" : ""}>مساءً</option></select></label></div></fieldset>`;
}

function selectedSessionTime(form, name) {
  const hour = String(form.get(`${name}Hour`) || "");
  const minute = String(form.get(`${name}Minute`) || "");
  const period = String(form.get(`${name}Period`) || "");
  if (!/^(?:[1-9]|1[0-2])$/.test(hour) || !/^(?:[0-5]\d)$/.test(minute) || !["am", "pm"].includes(period)) return null;
  return `${hour}:${minute} ${period === "am" ? "صباحًا" : "مساءً"}`;
}

function sessionTimeTimestamp(rawTimeValue, isoDate) {
  const rawTime = normalizeDigits(rawTimeValue || "").trim().toLocaleLowerCase("ar");
  const match = rawTime.match(/(\d{1,2})\s*[:٫]\s*(\d{2})/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const isPm = /مساء|(?:^|\s)م(?:\s|$)|pm/.test(rawTime);
  const isAm = /صباح|(?:^|\s)ص(?:\s|$)|am/.test(rawTime);
  if (minutes > 59 || (isAm && isPm)) return null;
  if ((isAm || isPm) && (hours < 1 || hours > 12)) return null;
  if (!isAm && !isPm && hours > 23) return null;
  if (isPm && hours < 12) hours += 12;
  if (isAm && hours === 12) hours = 0;
  const timestamp = new Date(`${isoDate}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sessionStartTimestamp(session, isoDate) {
  return sessionTimeTimestamp(session?.time, isoDate);
}

function sessionEndTimestamp(session, isoDate) {
  return sessionTimeTimestamp(session?.endTime, isoDate);
}

function attendanceWindowError(session, isoDate, now = new Date()) {
  if (!session?.endTime) return "أضف وقت نهاية الحصة من تعديل التدريب قبل تسجيل الحضور.";
  const startsAt = sessionStartTimestamp(session, isoDate);
  const endsAt = sessionEndTimestamp(session, isoDate);
  if (startsAt === null || endsAt === null || endsAt <= startsAt) return "وقت بداية الحصة أو نهايتها غير صحيح. حدّث موعد التدريب أولًا.";
  if (isoDate !== localDateString(now)) return "لا يمكن تسجيل الحضور إلا في يوم الحصة.";
  if (!sessionDays(session).includes(weekdayForDate(isoDate))) return "هذه الحصة غير مجدولة في يوم الحضور المحدد.";
  if (now.getTime() < startsAt - 30 * 60 * 1000) return "يفتح تسجيل الحضور قبل بداية الحصة بنصف ساعة فقط.";
  if (now.getTime() > endsAt) return "انتهى وقت تسجيل الحضور لهذه الحصة.";
  return "";
}

function attendanceTimeIsWithinSession(session, isoDate, timestamp, now = Date.now()) {
  const startsAt = sessionStartTimestamp(session, isoDate);
  const endsAt = sessionEndTimestamp(session, isoDate);
  return startsAt !== null && endsAt !== null
    && timestamp >= startsAt - 30 * 60 * 1000
    && timestamp <= endsAt
    && timestamp <= now;
}

function attendanceStatus(session, isoDate, timestamp, user) {
  const weekday = weekdayForDate(isoDate);
  if (!user.weeklyDays?.includes(weekday) || !sessionDays(session).includes(weekday)) return "معذور";
  const startsAt = sessionStartTimestamp(session, isoDate);
  if (startsAt !== null && timestamp >= startsAt + 30 * 60 * 1000) return "متأخر";
  return "حاضر";
}

function isPaidMember(user, isoDate = localDateString()) {
  const sessionsLeft = playerTrainingBalance(user).remaining;
  return subscriptionState(user).className === "status-active"
    && isSubscriptionActiveOn(user, isoDate)
    && sessionsLeft > 0;
}

function legacyAutoAttendanceRecords(player, now = new Date()) {
  const startDate = player?.legacyAttendanceStartDate || player?.subscriptionStart || player?.actualStartDate;
  if (!player?.legacyAttendanceAuto || !isValidIsoDate(startDate)) return [];
  const endDate = player.endDate || player.subscriptionEnd || addCalendarDays(startDate, 30);
  if (!isValidIsoDate(endDate) || endDate < startDate) return [];
  const today = localDateString(now);
  const lastDate = endDate < today ? endDate : today;
  const sessions = selectedSessionsForMember(player);
  const slots = attendanceSlots(sessions);
  if (!slots.length || !player.weeklyDays?.length || lastDate < startDate) return [];
  const allowance = priceSummary(player.weeklyDaysCount || player.weeklyDays.length).plan.sessions;
  const occurrences = [];
  const cursor = new Date(`${startDate}T12:00:00`);
  const stop = new Date(`${lastDate}T12:00:00`);
  while (cursor <= stop) {
    const isoDate = localDateString(cursor);
    slots.forEach(slot => {
      const session = sessionForPlayerInSlot(player, slot, isoDate);
      if (!session || dayOffExists(slot.id, isoDate)) return;
      const startsAt = sessionStartTimestamp(session, isoDate);
      const endsAt = sessionEndTimestamp(session, isoDate);
      if ((endsAt ?? startsAt) === null || (endsAt ?? startsAt) > now.getTime()) return;
      const recorded = data.attendance.find(record => {
        if (record.playerId !== player.id || record.isoDate !== isoDate) return false;
        const recordedSession = data.sessions.find(item => item.id === record.sessionId);
        return recordedSession && attendanceSlotKey(recordedSession) === slot.id;
      });
      if (!recorded && occurrences.filter(item => ["حاضر", "متأخر"].includes(item.status)).length >= allowance) return;
      const attended = !recorded || ["حاضر", "متأخر"].includes(recorded.status);
      occurrences.push({
        id: recorded?.id || `legacy-auto-${player.id}-${isoDate}-${encodeURIComponent(slot.id)}`,
        playerId: player.id,
        sessionId: recorded?.sessionId || session.id,
        sessionTitle: recorded?.sessionTitle || session.title,
        sessionTime: recorded?.sessionTime || session.time,
        isoDate,
        date: recorded?.date || egyptianDate.format(new Date(`${isoDate}T12:00:00`)),
        timestamp: recorded?.timestamp || (endsAt ?? startsAt),
        registeredAt: recorded?.registeredAt || "",
        status: attended ? (recorded?.status || "حاضر") : recorded?.status || "غائب",
        legacyAuto: !recorded
      });
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return occurrences.sort((left, right) => right.isoDate.localeCompare(left.isoDate)
    || right.timestamp - left.timestamp);
}

function playerTrainingBalance(player) {
  const allowance = priceSummary(player?.weeklyDaysCount || player?.weeklyDays?.length || player?.plan || 1).plan.sessions;
  if (!player?.legacyAttendanceAuto) {
    return {
      allowance,
      used: Number(player?.sessionsUsed) || 0,
      remaining: Number(player?.sessionsLeft ?? allowance)
    };
  }
  const records = legacyAutoAttendanceRecords(player);
  const used = Math.min(allowance, records.filter(record => ["حاضر", "متأخر"].includes(record.status)).length);
  return { allowance, used, remaining: Math.max(0, allowance - used) };
}

function appendLegacyPlayerChange(player, title, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const entry = {
    id: crypto.randomUUID(),
    title,
    before: String(before ?? "—"),
    after: String(after ?? "—"),
    changedAt: Date.now(),
    changedBy: currentUser?.name || "مشرف الأكاديمية"
  };
  player.supervisorChangeHistory = [
    ...(Array.isArray(player.supervisorChangeHistory) ? player.supervisorChangeHistory : []),
    entry
  ].slice(-50);
}

function legacyChangeTimestamp(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function consumeTraining(user) {
  if (user.legacyAttendanceAuto) {
    const balance = playerTrainingBalance(user);
    user.sessionsUsed = balance.used;
    user.sessionsLeft = balance.remaining;
    return;
  }
  const sessionsLeft = user.sessionsLeft == null ? priceSummary(user.plan).plan.sessions : Number(user.sessionsLeft);
  user.sessionsUsed = (user.sessionsUsed || 0) + 1;
  if (sessionsLeft < 999) user.sessionsLeft = Math.max(0, sessionsLeft - 1);
}

function memberNotifications(user) {
  const notices = [];
  const state = subscriptionState(user);
  const latestPayment = data.payments.filter(payment => payment.playerId === user.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (state.remaining === null) notices.push("الاشتراك بانتظار التفعيل. أرسل بيانات الدفع لتفعيل التدريبات.");
  else if (state.label === "منتهي") notices.push("انتهى الاشتراك أو نفدت التدريبات. يرجى التجديد لمواصلة التدريب.");
  else if (state.remaining <= 7) notices.push("اشتراكك يقترب من الانتهاء. جدّده لتجنب توقف التدريبات.");
  if (latestPayment?.status === "بانتظار المراجعة") notices.push("تم استلام طلب الدفع وهو بانتظار مراجعة الأكاديمية.");
  if (latestPayment?.status === "تم التأكيد" || latestPayment?.status === "تم الدفع نقدًا") notices.push("تم تأكيد الدفع وتفعيل الاشتراك.");
  if (latestPayment?.status === "دفع جزئي نقدًا") notices.push(`تم تسجيل دفع نقدي جزئي بقيمة ${arabicDigits(latestPayment.amount)} ج.م. أكمل المبلغ المتبقي لتفعيل الاشتراك.`);
  return notices;
}

function showAuth(mode = "login") {
  if (!introFinished) return;
  byId("intro-screen").hidden = true;
  byId("auth-loading").hidden = true;
  byId("auth-screen").hidden = false;
  byId("portal").hidden = true;
  byId("coach-auth").hidden = true;
  byId("member-auth").hidden = false;
  setAuthTab(mode);
}

function finishIntro() {
  if (introFinished) return;
  introFinished = true;
  byId("intro-video").pause();
  byId("intro-screen").hidden = true;
  if (appUserReady) {
    byId("auth-loading").hidden = true;
    byId("auth-screen").hidden = true;
    byId("portal").hidden = false;
  } else if (initialAuthResolved) {
    showAuth();
  } else {
    byId("auth-loading").hidden = false;
    byId("auth-screen").hidden = true;
    byId("portal").hidden = true;
  }
}

byId("intro-video").addEventListener("ended", finishIntro);
byId("intro-video").addEventListener("error", () => {
  byId("intro-continue").hidden = false;
});
byId("intro-continue").addEventListener("click", finishIntro);

function enableIntroAudioFromInteraction() {
  const video = byId("intro-video");
  if (video.muted) {
    video.muted = false;
    video.play().catch(error => {
      console.warn("تعذر تشغيل صوت الفيديو الافتتاحي بعد تفاعل المستخدم.", error);
      video.muted = true;
    });
  }
  document.removeEventListener("pointerdown", enableIntroAudioFromInteraction);
  document.removeEventListener("keydown", enableIntroAudioFromInteraction);
}

document.addEventListener("pointerdown", enableIntroAudioFromInteraction);
document.addEventListener("keydown", enableIntroAudioFromInteraction);

function startApplication() {
  if (startupReady) return;
  startupReady = true;
  byId("connection-screen").hidden = true;
  byId("intro-screen").hidden = false;
  const video = byId("intro-video");
  video.muted = false;
  video.volume = 1;
  video.play().catch(error => {
    if (introFinished) return;
    console.warn("منع المتصفح تشغيل الفيديو الافتتاحي بالصوت تلقائياً.", error);
    video.muted = true;
    video.play().catch(playError => {
      if (introFinished) return;
      console.error("تعذر تشغيل الفيديو الافتتاحي.", playError);
      byId("intro-continue").hidden = false;
    });
  });
  observeFirebaseAuth();
}

async function hasInternetConnection() {
  if (!navigator.onLine) return false;
  return new Promise(resolve => {
    const probe = new Image();
    const timeout = window.setTimeout(() => finish(false), 5000);
    function finish(connected) {
      window.clearTimeout(timeout);
      probe.onload = null;
      probe.onerror = null;
      resolve(connected);
    }
    probe.onload = () => finish(true);
    probe.onerror = () => finish(false);
    probe.src = `https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg?check=${Date.now()}`;
  });
}

async function checkStartupConnection() {
  if (connectionCheckInProgress) return;
  connectionCheckInProgress = true;
  const retryButton = byId("connection-retry");
  const status = byId("connection-status");
  retryButton.disabled = true;
  status.textContent = "جارٍ التحقق من اتصال الإنترنت...";
  try {
    if (await hasInternetConnection()) {
      window.clearInterval(connectionRetryTimer);
      connectionRetryTimer = null;
      byId("connection-screen").hidden = true;
      if (!startupReady) startApplication();
    } else {
      byId("connection-screen").hidden = false;
      status.textContent = "لا يتوفر اتصال بالإنترنت. أعد المحاولة أو انتظر عودة الاتصال.";
      retryButton.disabled = false;
      connectionRetryTimer ||= window.setInterval(checkStartupConnection, 10000);
    }
  } finally {
    connectionCheckInProgress = false;
  }
}

byId("connection-retry").addEventListener("click", checkStartupConnection);
window.addEventListener("online", () => {
  updateConnectivityStatus();
  checkStartupConnection();
  if (cloudProfile) queueCloudSave(JSON.parse(JSON.stringify(data)), cloudProfile);
});
window.addEventListener("offline", () => {
  updateConnectivityStatus();
  connectionRetryTimer ||= window.setInterval(checkStartupConnection, 10000);
});
checkStartupConnection();

function setAuthTab(mode) {
  const register = mode === "register";
  byId("login-form").hidden = register;
  byId("register-form").hidden = !register;
  document.querySelectorAll(".auth-tab").forEach(tab => tab.classList.toggle("selected", tab.dataset.authTab === mode));
  byId("auth-title").textContent = register ? "انضم إلى الأكاديمية" : "سجّل دخولك";
  byId("auth-subtitle").textContent = register ? "ابدأ رحلتك الرياضية مع فريق الاتحاد." : "ادخل إلى حسابك لمتابعة رحلتك الرياضية.";
}

function selectedPlayerStorageKey(guardianId) {
  return `${STORAGE_KEY}.selected-player.${guardianId}`;
}

function signIn(user) {
  currentUser = user;
  viewHistory = [];
  guardianReportSearch = "";
  selectedReportGuardianId = "";
  guardianReport = null;
  guardianReportLoading = false;
  guardianReportError = "";
  if (user.role === "guardian") {
    const children = childrenForGuardian(user.id);
    const savedPlayerId = localStorage.getItem(selectedPlayerStorageKey(user.id));
    selectedPlayerId = children.some(child => child.id === savedPlayerId)
      ? savedPlayerId
      : children[0]?.id || null;
    if (selectedPlayerId) localStorage.setItem(selectedPlayerStorageKey(user.id), selectedPlayerId);
  } else {
    selectedPlayerId = user.role === "member" ? user.id : null;
  }
  appUserReady = true;
  byId("auth-loading").hidden = true;
  byId("auth-screen").hidden = true;
  byId("portal").hidden = !introFinished;
  byId("user-name").textContent = user.name;
  byId("user-avatar").textContent = user.name.trim().charAt(0);
  byId("user-role").textContent = user.role === "coach" ? "مشرف الأكاديمية" : user.role === "trainer" ? "مدرب الأكاديمية" : user.role === "guardian" ? "ولي أمر اللاعبين" : "اللاعب";
  document.querySelectorAll(".supervisor-only").forEach(item => { item.hidden = user.role !== "coach"; });
  document.querySelectorAll(".member-only").forEach(item => { item.hidden = !["member", "guardian"].includes(user.role); });
  document.querySelectorAll(".trainer-only").forEach(item => { item.hidden = user.role !== "trainer"; });
  activeView = "home";
  renderView();
  if (supportsPushNotificationsOnThisOrigin() && hasAcceptedNotifications(user)
    && "Notification" in window && Notification.permission === "granted") {
    window.firebaseReady
      .then(async firebase => {
        await firebase.subscribeUserToNotifications(user);
        localStorage.setItem(notificationConsentStorageKey(user.id), "accepted");
        localStorage.setItem(notificationSubscriptionStorageKey(user.id), "enabled");
        if (currentUser?.id === user.id) renderView();
      })
      .catch(error => {
        localStorage.removeItem(notificationSubscriptionStorageKey(user.id));
        if (localStorage.getItem(notificationConsentStorageKey(user.id)) === "enabled") {
          localStorage.setItem(notificationConsentStorageKey(user.id), "accepted");
        }
        console.error("تعذر استعادة اشتراك إشعارات ولي الأمر.", error);
        showToast(error instanceof Error ? `تعذر استعادة الإشعارات: ${error.message}` : "تعذر استعادة الإشعارات على هذا الجهاز.");
        if (currentUser?.id === user.id) renderView();
      });
  }
}

async function activateCloudProfile(profile) {
  appUserReady = false;
  cloudProfile = profile;
  currentUser = profile;
  data = emptyData();
  try {
    const firebase = await window.firebaseReady;
    await firebase.loadAcademyData(profile, data, () => {
      saveLocalData();
      if (currentUser && !byId("portal").hidden) renderView();
    }, error => {
      showToast(error instanceof Error ? `تعذرت المزامنة السحابية: ${error.message}` : "تعذرت مزامنة بيانات الأكاديمية.");
    });
    if (profile.role === "coach") {
      try {
        await firebase.migratePaymentReferenceClaims(data.payments, profile);
      } catch (error) {
        console.error("تعذر ترحيل أرقام التحويل السابقة إلى سجل منع التكرار.", error);
        showToast(error instanceof Error
          ? `تعذر فحص أرقام التحويل السابقة: ${error.message}`
          : "تعذر فحص أرقام التحويل السابقة. تحقق من صلاحيات Firestore.");
      }
    }
    saveLocalData();
    signIn(profile);
  } catch (error) {
    cloudProfile = null;
    currentUser = null;
    appUserReady = false;
    console.error("تعذر تحميل بيانات الحساب من Firestore.", error);
    try {
      const firebase = await window.firebaseReady;
      await firebase.signOut();
    } catch (signOutError) {
      console.error("تعذر إنهاء جلسة Firebase بعد فشل تحميل البيانات.", signOutError);
    }
    showAuth();
    throw error;
  }
}

function dayCheckboxes(days, selectedDays = [], name = "weeklyDays", disabled = false) {
  if (!days.length) return '<p class="form-note">لم يحدد المدرب أيام العمل بعد.</p>';
  return days.map(day => `<label class="day-choice"><input type="checkbox" name="${name}" value="${escapeHtml(day)}" ${selectedDays.includes(day) ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${escapeHtml(day)}</span></label>`).join("");
}

function joinedDate(user) {
  return egyptianDate.format(new Date(user.joinedAt || Date.now()));
}

function userForMember(playerId = currentUser?.id) {
  const targetId = currentUser?.role === "guardian" && playerId === currentUser.id ? selectedPlayerId : playerId;
  return data.users.find(user => user.id === targetId && user.role === "member");
}

function childrenForGuardian(guardianId = currentUser?.id) {
  return data.users.filter(user => user.role === "member" && user.guardianId === guardianId);
}

function guardianChildBar() {
  if (currentUser?.role !== "guardian") return "";
  const children = childrenForGuardian();
  if (!children.length) return `<section class="panel"><p>أضف بيانات لاعبك لعرض الجدول والاشتراك وكود الحضور.</p><button class="primary-button" data-action="new-player">＋ إضافة لاعب</button></section>`;
  if (!children.some(child => child.id === selectedPlayerId)) {
    const savedPlayerId = localStorage.getItem(selectedPlayerStorageKey(currentUser.id));
    selectedPlayerId = children.some(child => child.id === savedPlayerId) ? savedPlayerId : children[0].id;
    localStorage.setItem(selectedPlayerStorageKey(currentUser.id), selectedPlayerId);
  }
  const selectedChild = children.find(child => child.id === selectedPlayerId);
  const completeProfile = selectedChild && (!selectedChild.birthDate || !selectedChild.gender || !selectedChild.weeklyDays?.length)
    ? `<button class="small-action" aria-label="استكمال بيانات اللاعب" data-action="complete-player" data-player="${escapeHtml(selectedChild.id)}">استكمال بيانات اللاعب</button>`
    : "";
  return `<div class="child-picker-topbar"><label for="selected-player">اختيار اللاعب</label><select id="selected-player">${children.map(child => `<option value="${escapeHtml(child.id)}" ${child.id === selectedPlayerId ? "selected" : ""}>${escapeHtml(child.name)}</option>`).join("")}</select>${completeProfile}<button class="small-action" aria-label="إضافة لاعب" data-action="new-player">＋ إضافة لاعب</button></div>`;
}

function sessionIncludesMember(session, user) {
  const categories = sessionCategories(session);
  const categoryMatches = categories.includes("جميع الفئات العمرية")
    || categories.includes(user.category)
    || !AGE_CATEGORIES.includes(user.category)
    || user.category === "جميع الفئات العمرية";
  const genderMatches = !["male", "female"].includes(session.gender)
    || !["male", "female"].includes(user.gender)
    || session.gender === user.gender;
  return categoryMatches && genderMatches;
}

function genderLabel(gender) {
  return gender === "male" ? "ذكر" : gender === "female" ? "أنثى" : "غير محدد";
}

function sessionGenderLabel(session) {
  return session.gender === "male" ? "ولاد" : session.gender === "female" ? "بنات" : "الكل";
}

function sessionCategories(session) {
  const categories = Array.isArray(session.categories) ? session.categories.filter(category => AGE_CATEGORIES.includes(category)) : [];
  if (categories.length) return [...new Set(categories)];
  return [AGE_CATEGORIES.includes(session.category) ? session.category : "جميع الفئات العمرية"];
}

function readableSessionTitle(title) {
  const normalized = String(title || "").trim();
  return /^\d{5,}$/.test(normalized) ? "تمرين الأكاديمية" : normalized;
}

function sessionCategoryLabel(session) {
  return sessionCategories(session).join("، ");
}

function trainingGroups(sessions = data.sessions) {
  const groups = new Map();
  sessions.forEach(session => {
    const key = session.trainingGroupId || `legacy:${session.id}`;
    if (!groups.has(key)) groups.set(key, { id: key, sessions: [] });
    groups.get(key).sessions.push(session);
  });
  return [...groups.values()];
}

function attendanceSlotKey(session) {
  return `${session.time}|${session.endTime || ""}`;
}

function attendanceSlots(sessions) {
  const slots = new Map();
  sessions.forEach(session => {
    const key = attendanceSlotKey(session);
    if (!slots.has(key)) slots.set(key, { id: key, sessions: [] });
    slots.get(key).sessions.push(session);
  });
  return [...slots.values()];
}

function attendanceSlotForSession(session) {
  return attendanceSlots(data.sessions).find(slot => slot.sessions.some(item => item.id === session.id));
}

function sessionForPlayerInSlot(player, slot, isoDate = localDateString()) {
  const weekday = weekdayForDate(isoDate);
  return slot.sessions.find(session => sessionIncludesMember(session, player) && sessionDays(session).includes(weekday));
}

function legacyProjectedEndDate(player, startDate, weeklyDays = player?.weeklyDays) {
  if (!isValidIsoDate(startDate) || !weeklyDays?.length || !weeklyDays.includes(weekdayForDate(startDate))) return "";
  const sessions = selectedSessionsForMember({ ...player, weeklyDays });
  const slots = attendanceSlots(sessions);
  if (!slots.length) return "";
  const allowance = priceSummary(weeklyDays.length).plan.sessions;
  let attendedSessions = 0;
  const cursor = new Date(`${startDate}T12:00:00`);
  for (let dayOffset = 0; dayOffset < 730; dayOffset += 1) {
    const isoDate = localDateString(cursor);
    for (const slot of slots) {
      const session = sessionForPlayerInSlot({ ...player, weeklyDays }, slot, isoDate);
      if (!session || dayOffExists(slot.id, isoDate)) continue;
      const startsAt = sessionStartTimestamp(session, isoDate);
      const endsAt = sessionEndTimestamp(session, isoDate);
      if ((endsAt ?? startsAt) === null) continue;
      const recorded = data.attendance.find(record => {
        if (record.playerId !== player.id || record.isoDate !== isoDate) return false;
        const recordedSession = data.sessions.find(item => item.id === record.sessionId);
        return recordedSession && attendanceSlotKey(recordedSession) === slot.id;
      });
      if (recorded?.status === "غائب") continue;
      attendedSessions += 1;
      if (attendedSessions >= allowance) return isoDate;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return "";
}

function sessionsForMember(user) {
  return data.sessions.filter(session => sessionIncludesMember(session, user));
}

function selectedSessionsForMember(user) {
  const selectedIds = Array.isArray(user.selectedSessionIds) ? user.selectedSessionIds : [];
  return sessionsForMember(user).filter(session => selectedIds.includes(session.id) && sessionMatchesMemberDays(session, user));
}

function sessionMatchesMemberDays(session, user) {
  return sessionDays(session).some(day => (user.weeklyDays || []).includes(day));
}

function paymentMethodLabel(payment) {
  return payment.method === "cash" ? "نقدي" : "إنستا باي / محفظة بنكية";
}

function isRecordedPayment(payment) {
  return ["تم التأكيد", "تم الدفع نقدًا", "دفع جزئي نقدًا", "تم استكمال الدفع النقدي", "سداد مديونية نقدية"].includes(payment.status);
}

function normalizedPaymentReference(reference) {
  return String(reference || "").normalize("NFKC").trim().replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).toLocaleUpperCase();
}

function hasDuplicatePaymentReference(reference) {
  const normalizedReference = normalizedPaymentReference(reference);
  return Boolean(normalizedReference) && data.payments.some(payment =>
    normalizedPaymentReference(payment.reference) === normalizedReference
  );
}

function sessionDays(session) {
  const days = Array.isArray(session.days) ? session.days : [session.day];
  return days.filter(day => WEEK_DAYS.includes(day));
}

function automaticSubscriptionStartDate(user) {
  const subscriptionStatus = evaluateSubscriptionStartStatus(user);
  if (subscriptionStatus.status === "continuous") return subscriptionStatus.firstPostExpiryAttendance;
  if (subscriptionStatus.status === "active") return expectedStartDateFor(user);
  const now = Date.now();
  const today = localDateString();
  const candidates = [];
  for (let offset = 0; offset < 15; offset += 1) {
    const date = addCalendarDays(today, offset);
    const weekday = weekdayForDate(date);
    selectedSessionsForMember(user).forEach(session => {
      if (!sessionDays(session).includes(weekday)) return;
      const startsAt = sessionStartTimestamp(session, date);
      if (startsAt !== null && startsAt - now >= 5 * 60 * 60 * 1000) {
        candidates.push({ date, startsAt });
      }
    });
  }
  candidates.sort((left, right) => left.startsAt - right.startsAt);
  const todayCandidate = candidates.find(item => item.date === today);
  if (todayCandidate && todayCandidate.startsAt - now < 24 * 60 * 60 * 1000) {
    const startsAt = new Date(todayCandidate.startsAt);
    const time = new Intl.DateTimeFormat("ar-EG", { hour: "numeric", minute: "2-digit" }).format(startsAt);
    if (window.confirm(`يوجد تمرين اليوم الساعة ${time}، وموعده بعد خمس ساعات أو أكثر. هل تريد حضور تمرين اليوم؟`)) {
      return todayCandidate.date;
    }
  }
  const scheduledStart = candidates.find(item => item.startsAt - now >= 24 * 60 * 60 * 1000);
  if (scheduledStart) return scheduledStart.date;
  throw new Error("لا يوجد موعد تدريب مختار يبدأ بعد خمس ساعات على الأقل خلال الأسبوعين القادمين.");
}

function sessionTimeRange(session) {
  return session.endTime ? `${session.time} - ${session.endTime}` : `${session.time} · يلزم تحديد النهاية`;
}

function weekdayForDate(isoDate) {
  const dayIndex = new Date(`${isoDate}T12:00:00`).getDay();
  return WEEK_DAYS[(dayIndex + 1) % 7];
}

function daysUntil(dateValue) {
  if (!dateValue) return null;
  const end = new Date(`${dateValue}T23:59:59`);
  return Math.ceil((end.getTime() - Date.now()) / 86400000);
}

function subscriptionState(user) {
  const endDate = user?.endDate || user?.subscriptionEnd;
  const remaining = daysUntil(endDate);
  if (remaining === null) return { label: "بانتظار تفعيل الاشتراك", className: "status-soon", remaining: null };
  if (remaining < 0) return { label: "منتهي", className: "status-expired", remaining };
  const startDate = subscriptionStartDate(user);
  if (startDate && startDate > localDateString()) return { label: "يبدأ " + egyptianDate.format(new Date(`${startDate}T12:00:00`)), className: "status-soon", remaining };
  if (remaining <= 7) return { label: "بحاجة إلى تجديد", className: "status-soon", remaining };
  return { label: "نشط", className: "status-active", remaining };
}

function canRequestPayment(user) {
  const endDate = user?.endDate || user?.subscriptionEnd;
  if (!endDate) return true;
  const sessionsLeft = playerTrainingBalance(user).remaining;
  const remainingDays = daysUntil(endDate);
  return sessionsLeft <= 1 || remainingDays === null || remainingDays <= 0;
}

function hasPendingPayment(user) {
  return data.payments.some(payment => payment.playerId === user?.id && payment.status === "بانتظار المراجعة");
}

function memberWalletBalance(user) {
  return Math.max(0, Math.floor(Number(user?.walletBalance) || 0));
}

function hasPartialCashPayment(user) {
  return data.payments.some(payment => payment.playerId === user?.id && payment.status === "دفع جزئي نقدًا");
}

function attendedUnpaidSessionCount(user) {
  return data.attendance.filter(record =>
    record.playerId === user?.id && record.attendedUnpaid && record.status !== "غائب"
  ).length;
}

function isInitialSubscriptionSetup(user) {
  if (!user || playerTrainingBalance(user).used > 0 || hasPendingPayment(user)) return false;
  const subscriptionDates = ["expectedStartDate", "actualStartDate", "subscriptionStart", "subscriptionEnd", "endDate"];
  return !subscriptionDates.some(field => user[field]);
}

function canEditPlayerSchedule(user) {
  if (!user) return false;
  const remainingSessions = playerTrainingBalance(user).remaining;
  const isExpiredWithUnpaidAttendance = subscriptionState(user).className === "status-expired"
    && attendedUnpaidSessionCount(user) > 0;
  return isInitialSubscriptionSetup(user)
    || remainingSessions === 1
    || isExpiredWithUnpaidAttendance
    || hasPartialCashPayment(user);
}

function priceSummary(planId) {
  const dayCount = Math.max(1, Math.min(7, Number(planId) || 1));
  const price = Number(data.pricesByDays[dayCount] ?? DEFAULT_DAY_PRICES[dayCount]);
  const plan = { name: `${arabicDigits(dayCount)} ${dayCount === 1 ? "يوم" : "أيام"} أسبوعيًا`, sessions: dayCount * 4, price };
  const sessionPrice = Math.round(price / plan.sessions);
  return { plan, sessionPrice, sessions: arabicDigits(plan.sessions) };
}

function normalizeSubscriptionDuration(duration) {
  if (duration === undefined || duration === null || duration === "") return "full";
  if (duration !== "full" && duration !== "half") throw new Error("مدة الاشتراك غير صالحة.");
  return duration;
}

function subscriptionPrice(planId, duration = "full") {
  const normalizedDuration = normalizeSubscriptionDuration(duration);
  const monthlyPrice = priceSummary(planId).plan.price;
  return normalizedDuration === "half" ? monthlyPrice / 2 : monthlyPrice;
}

function subscriptionDurationLabel(duration = "full") {
  return SUBSCRIPTION_DURATIONS[normalizeSubscriptionDuration(duration)].label;
}

function paymentDurationLabel(payment) {
  return payment.debtPaymentAmount ? "" : subscriptionDurationLabel(payment.subscriptionDuration);
}

function isValidCurrencyAmount(amount) {
  return Number.isFinite(amount) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8;
}

function planForAmount(amount) {
  const affordableDays = Object.keys(DEFAULT_DAY_PRICES).map(Number)
    .filter(dayCount => Number(data.pricesByDays[dayCount]) <= amount)
    .sort((a, b) => b - a)[0];
  return affordableDays ? priceSummary(affordableDays).plan : null;
}

function subscriptionStartDate(user) {
  if (user.expectedStartDate && user.actualStartDate) {
    return user.actualStartDate < user.expectedStartDate ? user.actualStartDate : user.expectedStartDate;
  }
  if (user.actualStartDate) return user.actualStartDate;
  if (user.expectedStartDate) return user.expectedStartDate;
  if (user.subscriptionStart) return user.subscriptionStart;
  const endDate = user.endDate || user.subscriptionEnd;
  if (!endDate) return null;
  const inferredStart = new Date(`${endDate}T12:00:00`);
  inferredStart.setDate(inferredStart.getDate() - 30);
  return localDateString(inferredStart);
}

function isSubscriptionActiveOn(user, isoDate) {
  const startDate = subscriptionStartDate(user);
  const endDate = user?.endDate || user?.subscriptionEnd;
  return Boolean(startDate && endDate && isoDate >= startDate && isoDate <= endDate);
}

function startSubscriptionFromAttendance(user, isoDate) {
  const endDate = user.endDate || user.subscriptionEnd;
  const expectedStartDate = user.expectedStartDate || subscriptionStartDate(user);
  if (!endDate || !expectedStartDate || user.actualStartDate || isoDate > endDate) return false;
  user.actualStartDate = isoDate;
  if (isoDate < expectedStartDate) {
    const recalculatedEndDate = addCalendarDays(isoDate, 30);
    user.expectedStartDate = expectedStartDate;
    user.subscriptionStart = isoDate;
    user.subscriptionEnd = recalculatedEndDate;
    user.endDate = recalculatedEndDate;
  }
  return true;
}

function canRequestMakeup(user, record) {
  const startDate = subscriptionStartDate(user);
  const endDate = user.endDate || user.subscriptionEnd;
  if (record.status !== "غائب" || !record.isoDate || !startDate || !endDate) return false;
  if (record.isoDate < startDate || record.isoDate >= endDate || localDateString() > endDate) return false;
  return !data.attendanceExceptions.some(item => item.attendanceId === record.id);
}

function makeUpRequestFor(record) {
  return data.attendanceExceptions.find(item => item.attendanceId === record.id);
}

function renderView() {
  const isCoach = currentUser?.role === "coach";
  const isTrainer = currentUser?.role === "trainer";
  const isMemberSpace = ["member", "guardian"].includes(currentUser?.role);
  const portal = byId("portal");
  portal.classList.toggle("simple-dashboard", !isCoach && (isMemberSpace || isTrainer));
  portal.classList.toggle("assistant-dashboard", !isCoach && isTrainer);
  const memberSwitch = byId("portal-member-switch");
  const showMemberSwitch = !isCoach && currentUser?.role === "guardian" && childrenForGuardian().length > 0;
  memberSwitch.hidden = !showMemberSwitch;
  memberSwitch.innerHTML = showMemberSwitch ? guardianChildBar() : "";
  document.querySelectorAll(".portal-nav-item").forEach(button => {
    if (!button.dataset.defaultLabel && button.lastChild?.nodeType === Node.TEXT_NODE) button.dataset.defaultLabel = button.lastChild.textContent;
    if (button.lastChild?.nodeType !== Node.TEXT_NODE) return;
    const labels = { schedule: "المواعيد والحضور", subscription: "الاشتراكات والتدريب", payments: "المدفوعات" };
    button.lastChild.textContent = !isCoach && isMemberSpace && labels[button.dataset.view]
      ? labels[button.dataset.view]
      : button.dataset.defaultLabel;
  });
  const titles = { home: "الرئيسية", legacyPlayers: "ملفات اللاعبين الحاليين", schedule: "جدول التدريبات", attendance: "الحضور", subscription: isCoach ? "اشتراكات اللاعبين" : "اشتراكي", guardianReport: "تقرير ولي الأمر الشامل", payments: "المدفوعات", settings: "أيام العمل والأسعار", trainers: "إدارة المدربين", trainerAttendance: "حضور المدربين", finances: "الإيرادات والمصروفات" };
  if ((isTrainer && !["home", "schedule", "attendance"].includes(activeView)) || (["member", "guardian"].includes(currentUser?.role) && !["home", "schedule", "attendance", "subscription", "payments"].includes(activeView))) activeView = "home";
  byId("view-title").textContent = isCoach && activeView === "home" ? "إدارة الأكاديمية" : isTrainer && activeView === "home" ? "مساحة المدرب" : isTrainer && activeView === "attendance" ? "تسجيل حضور لاعب" : isMemberSpace && activeView === "schedule" ? "المواعيد والحضور" : isMemberSpace && activeView === "subscription" ? "الاشتراكات والتدريب" : titles[activeView];
  byId("portal-back").disabled = viewHistory.length === 0;
  document.querySelectorAll(".portal-nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === activeView));
  const content = byId("portal-content");
  const notificationButton = byId("portal-notifications");
  const notificationActions = byId("portal-topbar-actions");
  const logoutButton = byId("logout-button");
  const showAnnouncementsButton = (isMemberSpace || isCoach) && activeView === "home";
  if (notificationButton && notificationActions) {
    notificationButton.title = isCoach ? "إرسال إشعار للأكاديمية" : "الإعلانات والتنويهات";
    notificationButton.setAttribute("aria-label", notificationButton.title);
    if (logoutButton?.parentElement === notificationActions) {
      notificationActions.insertBefore(notificationButton, logoutButton);
    } else {
      notificationActions.append(notificationButton);
    }
    notificationButton.hidden = !showAnnouncementsButton;
  }
  if (isCoach) {
    content.innerHTML = activeView === "legacyPlayers" ? coachLegacyPlayersView() : activeView === "schedule" ? coachScheduleView() : activeView === "attendance" ? coachAttendanceView() : activeView === "subscription" ? coachPlayersView() : activeView === "guardianReport" ? coachGuardianReportView() : activeView === "payments" ? coachPaymentsView() : activeView === "settings" ? coachSettingsView() : activeView === "trainers" ? coachTrainersView() : activeView === "trainerAttendance" ? supervisorTrainerAttendanceView() : activeView === "finances" ? financeView() : coachHomeView();
  } else if (isTrainer) {
    content.innerHTML = activeView === "schedule" ? trainerScheduleView() : activeView === "attendance" ? trainerAttendanceView() : trainerHomeView();
  } else {
    if (currentUser.role === "guardian" && !childrenForGuardian().length) content.innerHTML = guardianChildBar();
    else content.innerHTML = activeView === "schedule" ? `${memberScheduleView()}${memberAttendanceView()}` : activeView === "attendance" ? memberAttendanceView() : activeView === "subscription" ? memberSubscriptionView() : activeView === "payments" ? memberPaymentsView() : memberHomeView();
  }
  const notificationSlot = content.querySelector(".welcome-notification-slot");
  if (notificationButton && showAnnouncementsButton && notificationSlot) {
    notificationSlot.append(notificationButton);
  } else if (notificationButton && showAnnouncementsButton && notificationActions) {
    const currentLogoutButton = byId("logout-button");
    if (currentLogoutButton?.parentElement === notificationActions) {
      notificationActions.insertBefore(notificationButton, currentLogoutButton);
    } else {
      notificationActions.append(notificationButton);
    }
  } else if (notificationButton && showAnnouncementsButton) {
    document.body.append(notificationButton);
  }
}

function upcomingAppointmentFor(user, sessions) {
  const now = new Date();
  const selectedDays = user.weeklyDays || [];
  const candidates = [];
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
    const isoDate = localDateString(date);
    const day = weekdayForDate(isoDate);
    if (!selectedDays.includes(day)) continue;
    sessions.filter(session => sessionDays(session).includes(day)).forEach(session => {
      const startsAt = sessionStartTimestamp(session, isoDate);
      if (startsAt !== null && startsAt > now.getTime()) candidates.push({ session, date, startsAt });
    });
  }
  return candidates.sort((a, b) => a.startsAt - b.startsAt)[0] || null;
}

function memberHomeView() {
  const user = userForMember();
  if (!user) return "";
  const state = subscriptionState(user);
  const planInfo = priceSummary(user.plan);
  const balance = playerTrainingBalance(user);
  const sessionsLeft = balance.remaining;
  const chosenSessions = selectedSessionsForMember(user);
  const memberSessions = chosenSessions.length ? chosenSessions : sessionsForMember(user);
  const nextSession = upcomingAppointmentFor(user, memberSessions);
  const notices = memberNotifications(user);
  const noticeTitle = notices[0] || "خصم تدريباتك مرتبط بباقة اشتراكك";
  const noticeMessage = notices[1] || `سعر التدريب الواحد ${arabicDigits(planInfo.sessionPrice)} ج.م حسب الأيام التي اخترتها.`;
  const endDateLabel = user.subscriptionEnd ? egyptianDate.format(new Date(`${user.subscriptionEnd}T12:00:00`)) : "لم يتم تفعيل الاشتراك";
  const notificationPanel = notificationPanelForCurrentUser();
  const parentName = currentUser.role === "guardian" ? currentUser.name : user.name;
  const attendanceCount = user.legacyAttendanceAuto
    ? balance.used
    : data.attendance.filter(record => record.playerId === user.id && record.status === "حاضر").length;
  const recentChanges = (Array.isArray(user.supervisorChangeHistory) ? user.supervisorChangeHistory : [])
    .slice().sort((left, right) => right.changedAt - left.changedAt).slice(0, 5);
  const supervisorUpdates = recentChanges.length
    ? `<section class="panel supervisor-update-panel"><div class="panel-heading"><div><h2>تحديثات المشرف على ملف اللاعب</h2><p>تظهر هنا التعديلات التي تمت على الاشتراك والحضور والمدفوعات.</p></div></div><div class="supervisor-update-list">${recentChanges.map(change =>     `<article><time>${escapeHtml(legacyChangeTimestamp(change.changedAt))}</time><strong>${escapeHtml(change.title)}</strong><span>${escapeHtml(change.before)} ← ${escapeHtml(change.after)}</span><small>بواسطة ${escapeHtml(change.changedBy || "مشرف الأكاديمية")}</small></article>`).join("")}</div></section>`
    : "";
  const actionMessage = encodeURIComponent(`مرحبًا، أود الاستفسار عن متابعة اللاعب ${user.name}.`);
  const playerCodeContact = ["guardian", "member"].includes(currentUser.role) && user.playerCode
    ? `<div class="guardian-player-code"><span>كود اللاعب: <strong>${escapeHtml(user.playerCode)}</strong></span><button type="button" class="copy-code" data-action="copy-text" data-copy="${escapeHtml(user.playerCode)}" aria-label="نسخ كود اللاعب">⧉ نسخ</button><a class="text-link whatsapp-link" href="https://wa.me/${whatsappPhone(DEFAULT_INSTAPAY_NUMBER)}?text=${encodeURIComponent(`اسم اللاعب / ${user.name}\nكود اللاعب / ${user.playerCode}`)}" target="_blank" rel="noopener noreferrer">إرسال الكود للمشرف عبر واتساب</a></div>`
    : "";
  const pendingCategory = pendingPlayerCategory(user);
  const categoryNotice = pendingCategory
    ? `<div class="inline-notice">بلغ اللاعب السن المؤهل للانتقال إلى فئة ${escapeHtml(pendingCategory)}. تظل فئته الحالية حتى اعتماد المشرف.</div>`
    : "";
  return `<section class="portal-welcome"><div><p class="eyebrow"><span class="live-dot"></span>${egyptianDate.format(new Date())}</p><h1>أهلًا بك يا ${escapeHtml(parentName)} <span class="wave">✦</span></h1><p class="welcome-subtitle">متابعة اللاعب: <strong>${escapeHtml(user.name)}</strong></p>${playerCodeContact}</div><div class="welcome-actions"><div class="welcome-notification-slot"></div><span class="welcome-ball">🏀</span></div></section>${notificationPanel}${categoryNotice}
    <section class="member-stats">
      <article class="member-stat"><span class="member-stat-icon green-icon">◷</span><p>الموعد القادم</p><strong>${nextSession ? `${escapeHtml(weekdayForDate(localDateString(nextSession.date)))} · ${escapeHtml(egyptianDate.format(nextSession.date))}` : "لا يوجد تدريب"}</strong><small>${escapeHtml(nextSession ? `${sessionTimeRange(nextSession.session)} · ${nextSession.session.title}` : "تظهر المواعيد بعد إضافتها من الأكاديمية")}</small></article>
      <article class="member-stat"><span class="member-stat-icon blue-icon">✓</span><p>التمارين المتبقية</p><strong>${arabicDigits(Math.max(0, sessionsLeft))} تمرين</strong><small>${user.legacyAttendanceAuto ? "حضور محسوب" : "حضر"} ${arabicDigits(attendanceCount)} من ${arabicDigits(balance.allowance)} تمارين</small></article>
      <article class="member-stat"><span class="member-stat-icon amber-icon">▤</span><p>حالة الاشتراك</p><strong><span class="subscription-badge ${state.className}">${state.label}</span></strong><small>${state.remaining === null ? "بانتظار تأكيد الدفع" : `متبقي ${arabicDigits(Math.max(0, state.remaining))} يومًا`}</small></article>
    </section>
    <nav class="member-quick-actions" aria-label="إجراءات سريعة"><button type="button" data-view="subscription">🟢 تغيير أيام التدريب</button><button type="button" data-view="payments">💳 تجديد الاشتراك</button><a href="https://wa.me/201017692213?text=${actionMessage}" target="_blank" rel="noopener noreferrer">📲 التواصل عبر واتساب</a></nav>
    <section class="member-summary-grid"><article class="panel"><h2>اشتراك ${escapeHtml(planInfo.plan.name)}</h2><p class="welcome-subtitle">ينتهي في: <strong>${endDateLabel}</strong></p><p>أيام التدريب: <strong>${escapeHtml(user.weeklyDays.join("، ") || "لم تحدد بعد")}</strong></p><button class="text-link" data-view="subscription">تفاصيل الاشتراك والتدريب ←</button></article><article class="panel"><h2>الموعد القادم</h2>${nextSession ? `<p class="member-next-summary"><strong>${escapeHtml(readableSessionTitle(nextSession.session.title))}</strong><span>${escapeHtml(weekdayForDate(localDateString(nextSession.date)))} ${escapeHtml(egyptianDate.format(nextSession.date))}</span><span>${escapeHtml(sessionTimeRange(nextSession.session))} · ${escapeHtml(nextSession.session.place)}</span></p>` : '<p>لا توجد تدريبات قادمة مجدولة.</p>'}<button class="text-link" data-view="schedule">المواعيد والحضور ←</button></article></section>
    <section class="panel upcoming-panel"><div class="panel-heading"><div><h2>تنبيهات تهمك</h2><p>ابقَ على اطلاع بحسابك وتدريباتك</p></div></div>${notices.length ? notices.map((notice, index) => `<div class="notice-item"><span class="notice-icon ${index ? "status-soon" : state.className}">!</span><span><strong>${escapeHtml(notice)}</strong><small>${index === 0 ? escapeHtml(noticeMessage) : "تابع صفحة الحضور والمدفوعات لمزيد من التفاصيل."}</small></span></div>`).join("") : `<div class="notice-item"><span class="notice-icon ${state.className}">!</span><span><strong>${escapeHtml(noticeTitle)}</strong><small>${escapeHtml(noticeMessage)}</small></span></div>`}</section>${supervisorUpdates}`;
}

function notificationPanelForCurrentUser() {
  if (!currentUser || !["guardian", "member", "coach", "trainer"].includes(currentUser.role)
    || hasNotificationSubscription(currentUser)) return "";
  const accountDescription = ["guardian", "member"].includes(currentUser.role)
    ? "استقبل تنبيهات الحضور والغياب والدفع الخاصة بحسابك، والإعلانات الجديدة."
    : "استقبل الإعلانات والتنبيهات العامة الجديدة من الأكاديمية.";
  const description = !supportsPushNotificationsOnThisOrigin()
    ? "الإشعارات تحتاج فتح الأكاديمية من رابط HTTPS؛ لا تعمل عند فتح ملف الموقع مباشرة."
    : "Notification" in window && Notification.permission === "denied"
      ? "إذن الإشعارات مرفوض من المتصفح. غيّره إلى السماح من إعدادات الموقع ثم أعد تحميل الصفحة."
      : accountDescription;
  return `<section class="panel push-notification-panel"><div><strong>إشعارات الأكاديمية</strong><p>${description}</p></div><button class="small-action" data-action="toggle-guardian-notifications">🔔 ${hasAcceptedNotifications(currentUser) ? "إعادة محاولة تفعيل الإشعارات" : "تفعيل الإشعارات"}</button></section>`;
}

async function toggleUserNotifications() {
  if (!["guardian", "member", "coach", "trainer"].includes(currentUser?.role)) { showToast("إشعارات الهاتف متاحة للحسابات المسجلة في الأكاديمية فقط."); return; }
  try {
    if (!supportsPushNotificationsOnThisOrigin()) {
      throw new Error("إشعارات الهاتف تحتاج فتح الأكاديمية من رابط HTTPS، وليس من ملف على الجهاز.");
    }
    if (!("serviceWorker" in navigator)) throw new Error("هذا المتصفح لا يدعم تشغيل خدمة إشعارات الأكاديمية.");
    if (!("Notification" in window)) throw new Error("هذا المتصفح لا يدعم إشعارات الهاتف.");
    if (Notification.permission === "denied") {
      throw new Error("إذن الإشعارات مرفوض. افتح إعدادات الموقع في المتصفح، وغيّر الإشعارات إلى سماح، ثم أعد تحميل الصفحة.");
    }
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") throw new Error("لم يتم السماح بالإشعارات. فعّلها من إعدادات المتصفح ثم حاول مرة أخرى.");
    const firebase = await window.firebaseReady;
    await firebase.subscribeUserToNotifications(currentUser);
    localStorage.setItem(notificationConsentStorageKey(currentUser.id), "accepted");
    localStorage.setItem(notificationSubscriptionStorageKey(currentUser.id), "enabled");
    renderView();
    showToast("تم تفعيل إشعارات الحضور والغياب والدفع والإعلانات على هذا الهاتف.");
  } catch (error) {
    localStorage.removeItem(notificationSubscriptionStorageKey(currentUser.id));
    console.error("تعذر تفعيل إشعارات ولي الأمر.", error);
    showToast(error instanceof Error ? error.message : "تعذر إعداد الإشعارات. حاول مرة أخرى.");
    renderView();
  }
}

function announcementTime(announcement) {
  const value = announcement.createdAt;
  const date = value?.toDate ? value.toDate() : new Date(value || 0);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("ar-EG", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function openAnnouncementsBoard() {
  if (!currentUser) return;
  try {
    const firebase = await window.firebaseReady;
    const announcements = await firebase.listAnnouncements();
    data.announcements = announcements;
    const canPublish = ["coach", "trainer"].includes(currentUser.role);
    const canTrackReads = ["guardian", "member"].includes(currentUser.role);
    const currentGuardianId = currentUser.role === "member" ? currentUser.guardianId : currentUser.id;
    const visibleAnnouncements = announcements.filter(item =>
      !Array.isArray(item.targetGuardianIds)
      || canPublish
      || item.targetGuardianIds.includes(currentGuardianId)
    );
    const readAnnouncementIds = canTrackReads
      ? new Set(await firebase.listAnnouncementReads(currentUser))
      : new Set();
    const unreadAnnouncements = canTrackReads
      ? visibleAnnouncements.filter(item => !readAnnouncementIds.has(item.id))
      : [];
    const markAllRead = unreadAnnouncements.length
      ? `<button type="button" class="small-action" data-action="mark-all-announcements-read">تحديد الكل كمقروء</button>`
      : "";
    const list = visibleAnnouncements.length
      ? `${markAllRead}<div class="announcement-list">${visibleAnnouncements.map(item => {
        const isRead = readAnnouncementIds.has(item.id);
        const readStatus = canTrackReads
          ? `<button type="button" class="small-action announcement-read-button" data-action="${isRead ? "announcement-read" : "mark-announcement-read"}" data-announcement="${escapeHtml(item.id)}" ${isRead ? "disabled" : ""}>${isRead ? "مقروءة ✓" : "تحديد كمقروء"}</button>`
          : "";
        return `<article class="announcement-item"><div><strong>${escapeHtml(item.authorName || "إدارة الأكاديمية")}</strong><time>${escapeHtml(announcementTime(item))}</time></div><p>${escapeHtml(item.message)}</p>${readStatus}</article>`;
      }).join("")}</div>`
      : '<div class="empty-state"><p>لا توجد إعلانات أو تنويهات موجهة إليك.</p></div>';
    const composer = canPublish
      ? '<label class="announcement-composer">إعلان جديد<textarea name="message" rows="3" maxlength="1000" required placeholder="اكتب إعلان الأكاديمية..."></textarea></label>'
      : "";
    openModal("لوحة الإعلانات والتنويهات", `${list}${composer}`, canPublish ? "إرسال الإعلان" : "إغلاق", canPublish ? saveAnnouncement : closeModal, "الإعلانات");
  } catch (error) {
    console.error("تعذر تحميل لوحة الإعلانات.", error);
    showToast(error instanceof Error ? `تعذر تحميل الإعلانات: ${error.message}` : "تعذر تحميل الإعلانات.");
  }
}

async function markAnnouncementRead(announcementIds) {
  if (!["guardian", "member"].includes(currentUser?.role)) {
    showToast("تحديد الإعلانات كمقروءة متاح لولي الأمر أو اللاعب فقط.");
    return;
  }
  const ids = [...new Set(announcementIds)].filter(id => data.announcements.some(item => item.id === id));
  if (!ids.length) return;
  try {
    const firebase = await window.firebaseReady;
    await Promise.all(ids.map(id => firebase.markAnnouncementRead(currentUser, id)));
    showToast(ids.length === 1 ? "تم تحديد الإعلان كمقروء." : "تم تحديد الإعلانات كمقروءة.");
    await openAnnouncementsBoard();
  } catch (error) {
    console.error("تعذر تحديث حالة قراءة الإعلانات.", error);
    showToast(error instanceof Error ? error.message : "تعذر تحديد الإعلانات كمقروءة.");
  }
}

async function saveAnnouncement(form) {
  if (!["coach", "trainer"].includes(currentUser?.role)) {
    showToast("إرسال الإعلانات متاح للمشرف والمدرب فقط.");
    return;
  }
  const message = String(form.get("message") || "").trim();
  if (!message || message.length > 1000) {
    showToast("اكتب إعلانًا من حرف واحد إلى ١٠٠٠ حرف.");
    return;
  }
  const firebase = await window.firebaseReady;
  const announcement = await firebase.createAnnouncement({
    message,
    authorId: currentUser.id
  });
  data.announcements = [announcement, ...data.announcements.filter(item => item.id !== announcement.id)];
  closeModal();
  showToast("تم نشر الإعلان، وسيتم إرسال تنبيه للأجهزة المشتركة.");
}

function dayOffExists(slotId, isoDate) {
  return data.attendance.some(record =>
    record.dayOff === true
    && record.slotId === slotId
    && record.isoDate === isoDate
  );
}

function openDayOffForm(sessionId) {
  if (currentUser?.role !== "coach") { showToast("إعلان الإجازة متاح لمشرف الأكاديمية فقط."); return; }
  const session = data.sessions.find(item => item.id === sessionId);
  const slot = session && attendanceSlotForSession(session);
  if (!slot) { showToast("لم يتم العثور على مجموعة التدريب."); return; }
  openModal(`إعلان إجازة · ${sessionTimeRange(slot.sessions[0])}`, `<p class="modal-explainer">سيتم إعلان عدم وجود تمرين لكل اللاعبين المسجلين في يوم التدريب المحدد، وتسجيل حالتهم إجازة دون احتساب حضور أو غياب.</p><label>تاريخ الإجازة<input name="dayOffDate" type="date" min="${localDateString()}" value="${localDateString()}" required></label><input type="hidden" name="slotId" value="${escapeHtml(slot.id)}">`, "تأكيد الإجازة وإرسال الإشعار", form => saveDayOff(form), "الحضور والغياب");
}

async function saveDayOff(form) {
  if (currentUser?.role !== "coach") { showToast("إعلان الإجازة متاح لمشرف الأكاديمية فقط."); return; }
  const slotId = String(form.get("slotId") || "");
  const slot = attendanceSlots(data.sessions).find(item => item.id === slotId);
  const isoDate = String(form.get("dayOffDate") || "");
  if (!slot || !isValidIsoDate(isoDate) || isoDate < localDateString()) {
    showToast("اختر تاريخ إجازة صحيحًا من اليوم فصاعدًا.");
    return;
  }
  const weekday = weekdayForDate(isoDate);
  const daySessions = slot.sessions.filter(session => sessionDays(session).includes(weekday));
  if (!daySessions.length) {
    showToast(`المجموعة المحددة لا يوجد لها تمرين يوم ${weekday}.`);
    return;
  }
  if (dayOffExists(slotId, isoDate)) {
    showToast("تم إعلان إجازة لهذه المجموعة في هذا التاريخ بالفعل.");
    return;
  }
  const roster = data.users.filter(user =>
    user.role === "member"
    && user.weeklyDays?.includes(weekday)
    && sessionForPlayerInSlot(user, slot, isoDate)
  );
  if (!roster.length) {
    showToast("لا يوجد لاعبون مسجلون في هذه المجموعة في اليوم المحدد.");
    return;
  }
  const existingRecords = roster.map(user => ({
    user,
    session: sessionForPlayerInSlot(user, slot, isoDate),
    record: data.attendance.find(item =>
      item.playerId === user.id
      && slot.sessions.some(session => session.id === item.sessionId)
      && item.isoDate === isoDate
    )
  }));
  if (existingRecords.some(item => item.record && !["غائب", "غير مسجل"].includes(item.record.status))) {
    showToast("تم تسجيل حضور لاعب بالفعل في هذه المجموعة والتاريخ. لا يمكن إعلان الإجازة بعد بدء تسجيل الحضور.");
    return;
  }

  const timestamp = Date.now();
  const date = egyptianDate.format(new Date(`${isoDate}T12:00:00`));
  const previousRecords = existingRecords.map(item => ({ record: item.record, snapshot: item.record ? { ...item.record } : null }));
  const previousAttendanceIds = new Set(data.attendance.map(record => record.id));
  const recordsToAdd = [];
  existingRecords.forEach(({ user, session, record }) => {
    const holidayRecord = {
      ...(record || {}),
      id: record?.id || crypto.randomUUID(),
      playerId: user.id,
      playerCode: user.playerCode,
      playerName: user.name,
      sessionId: session.id,
      sessionTitle: session.title,
      sessionTime: session.time,
      guardianId: user.guardianId,
      guardianPhone: user.guardianPhone || "",
      slotId,
      timestamp,
      markedAt: timestamp,
      isoDate,
      date,
      registeredAt: "",
      status: "إجازة / لا يوجد تمرين اليوم",
      dayOff: true,
      attendedUnpaid: false,
      unpaidException: false
    };
    if (record) Object.assign(record, holidayRecord);
    else {
      recordsToAdd.push(holidayRecord);
      data.attendance.push(holidayRecord);
    }
  });
  const announcement = {
    id: crypto.randomUUID(),
    type: "dayOff",
    date: isoDate,
    sessionIds: daySessions.map(session => session.id),
    targetGuardianIds: [...new Set(roster.map(user => user.guardianId).filter(Boolean))],
    message: `إجازة معلنة يوم ${weekday} الموافق ${date}: اليوم إجازة ولا يوجد تمرين ${daySessions.map(session => session.title).join("، ")}.`,
    authorId: currentUser.id
  };
  if (!saveData()) {
    existingRecords.forEach(({ record }, index) => {
      if (record) Object.assign(record, previousRecords[index].snapshot);
    });
    data.attendance = data.attendance.filter(record => previousAttendanceIds.has(record.id));
    return;
  }
  try {
    const firebase = await window.firebaseReady;
    if (cloudProfile) {
      await cloudWriteQueue;
      await firebase.saveAcademyData(JSON.parse(JSON.stringify(data)), cloudProfile);
    }
    const savedAnnouncement = await firebase.createAnnouncement(announcement);
    data.announcements = [savedAnnouncement, ...data.announcements.filter(item => item.id !== savedAnnouncement.id)];
    closeModal();
    renderView();
    showToast(`تم إعلان الإجازة لـ ${arabicDigits(roster.length)} لاعبًا وإرسال إشعار ${arabicDigits(announcement.targetGuardianIds.length)} ولي أمر.`);
  } catch (error) {
    existingRecords.forEach(({ record }, index) => {
      if (record) Object.assign(record, previousRecords[index].snapshot);
    });
    data.attendance = data.attendance.filter(record => previousAttendanceIds.has(record.id));
    if (saveData() && cloudProfile) {
      try {
        await cloudWriteQueue;
        const firebase = await window.firebaseReady;
        await firebase.saveAcademyData(JSON.parse(JSON.stringify(data)), cloudProfile);
      } catch (rollbackError) {
        console.error("تعذر التراجع عن تحديث سجلات الإجازة في Firestore.", rollbackError);
      }
    }
    console.error("تعذر حفظ إعلان الإجازة أو إرسال التنويه.", error);
    showToast(error instanceof Error ? `تعذر إعلان الإجازة: ${error.message}` : "تعذر إعلان الإجازة. أُعيدت سجلات الحضور إلى حالتها السابقة.");
  }
}

function sessionCards(sessions, showCoach = false, member = null) {
  if (!sessions.length) return '<div class="empty-state"><strong>لا توجد تدريبات مجدولة</strong><p>ستظهر التدريبات هنا عند إضافتها من الأكاديمية.</p></div>';
  if (showCoach) {
    const groups = trainingGroups(sessions);
    return `<div class="schedule-list">${groups.map(group => {
      const session = group.sessions[0];
      const days = sessionDays(session);
      const details = group.sessions.map(item => {
        const count = data.users.filter(user => user.role === "member" && sessionIncludesMember(item, user) && (user.weeklyDays || []).some(day => days.includes(day))).length;
        return `<li><strong>${escapeHtml(item.title)}</strong> · ${escapeHtml(sessionCategoryLabel(item))} · ${escapeHtml(sessionGenderLabel(item))} · ${escapeHtml(item.coach)} · ${arabicDigits(count)} لاعب</li>`;
      }).join("");
      return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(sessionTimeRange(session))}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(session.place)}</strong><ul class="training-exercise-summary">${details}</ul></div><div class="schedule-actions"><button type="button" data-action="take-attendance" data-session="${escapeHtml(session.id)}">كشف الساعة</button><button type="button" data-action="day-off" data-session="${escapeHtml(session.id)}">إعلان إجازة</button><button type="button" data-action="edit-session" data-session="${escapeHtml(session.id)}">تعديل الساعة</button><button type="button" data-action="delete-session" data-session="${escapeHtml(session.id)}">حذف الساعة</button></div></article>`;
    }).join("")}</div>`;
  }
  return `<div class="schedule-list">${sessions.map(session => { const days = sessionDays(session); const playerCount = data.users.filter(user => user.role === "member" && sessionIncludesMember(session, user) && (user.weeklyDays || []).some(day => days.includes(day))).length; const categoryLabel = member ? (sessionMatchesMemberDays(session, member) ? "مناسب لأيام تدريبك" : "موعد متاح لفئتك") : sessionCategoryLabel(session); return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(sessionTimeRange(session))}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(member ? readableSessionTitle(session.title) : session.title)}</strong><span>${escapeHtml(session.place)} · ${escapeHtml(session.coach)}</span>${showCoach ? `<small>الفئة: ${escapeHtml(sessionCategoryLabel(session))} · ${escapeHtml(sessionGenderLabel(session))} · ${arabicDigits(playerCount)} لاعب مسجل</small>` : ""}</div>${showCoach ? `<div class="schedule-actions"><button type="button" data-action="take-attendance" data-session="${escapeHtml(session.id)}">كشف الحضور</button><button type="button" data-action="edit-session" data-session="${escapeHtml(session.id)}">تعديل</button><button type="button" data-action="delete-session" data-session="${escapeHtml(session.id)}">حذف</button></div>` : `<span class="schedule-category">${escapeHtml(categoryLabel)}</span>`}</article>`; }).join("")}</div>`;
}

function memberScheduleView() {
  const user = userForMember();
  if (!user) return "";
  const availableSessions = sessionsForMember(user).filter(session => sessionMatchesMemberDays(session, user));
  const selectedSessions = selectedSessionsForMember(user);
  const selectedIds = new Set(selectedSessions.map(session => session.id));
  const canEditSchedule = canEditPlayerSchedule(user);
  const scheduleEditNote = canEditSchedule
    ? isInitialSubscriptionSetup(user)
      ? "اختر مواعيد اشتراكك الأول قبل إرسال طلب الدفع."
      : "يمكنك تعديل الجدول حسب حالة اشتراكك الحالية."
    : "تعديل الجدول متاح عند تبقي تدريب واحد، أو وجود تدريبات غير مدفوعة بعد انتهاء الاشتراك، أو وجود دفع جزئي.";
  const selectionForm = availableSessions.length ? `<section class="panel"><div class="panel-heading"><div><h2>اختر مواعيدك المفضلة</h2><p>اختر الوقت الأنسب للاعب. ${scheduleEditNote}</p></div></div><form id="member-sessions-form"><div class="session-choice-list">${availableSessions.map(session => `<label class="session-choice"><input type="checkbox" name="sessionIds" value="${escapeHtml(session.id)}" ${selectedIds.has(session.id) ? "checked" : ""} ${canEditSchedule ? "" : "disabled"}><span><strong>${escapeHtml(readableSessionTitle(session.title))}</strong><small>${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))} · ${escapeHtml(session.place)} · ${escapeHtml(session.coach)}</small></span></label>`).join("")}</div><button class="primary-button" type="submit" ${canEditSchedule ? "" : "disabled"}>حفظ المواعيد المختارة</button></form></section>` : `<section class="panel"><div class="empty-state"><p>لا توجد مواعيد لفئتك وأيام تدريبك حاليًا. تواصل مع الأكاديمية لاختيار موعد.</p></div></section>`;
  const sessions = selectedSessions.length ? selectedSessions : sessionsForMember(user);
  return `<section class="page-intro"><div><p class="eyebrow">جدولك الرياضي</p><h1>تدريبات ${escapeHtml(user.category)}</h1><p class="welcome-subtitle">اختر وقت تدريبك من المواعيد التي أضافها المشرف؛ يمكنك تحديث اختيارك لاحقًا.</p></div></section>${selectionForm}<section class="panel schedule-panel"><div class="panel-heading"><div><h2>${selectedSessions.length ? "مواعيدك المختارة" : "المواعيد المتاحة لفئتك"}</h2><p>${arabicDigits(sessions.length)} حصص على الجدول</p></div></div>${sessionCards(sessions, false, user)}</section>`;
}

function memberAttendanceView() {
  const user = userForMember();
  if (!user) return "";
  const records = [
    ...data.attendance.filter(record => record.playerId === user.id),
    ...legacyAutoAttendanceRecords(user).filter(record => record.legacyAuto)
  ].sort((a, b) => b.timestamp - a.timestamp);
  const chosenSessions = selectedSessionsForMember(user);
  const schedules = chosenSessions.length ? chosenSessions : sessionsForMember(user);
  const selectedDays = WEEK_DAYS.filter(day => (user.weeklyDays || []).includes(day));
  const today = new Date();
  const todayIsoDate = localDateString(today);
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 1) % 7, 12);
  const upcomingSessions = schedules
    .filter(session => sessionDays(session).some(day => selectedDays.includes(day)))
    .flatMap(session => {
      const matchingDays = sessionDays(session).filter(day => selectedDays.includes(day));
      return matchingDays.map(day => {
        const dayIndex = WEEK_DAYS.indexOf(day);
        const sessionDate = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + dayIndex, 12);
        const isoDate = localDateString(sessionDate);
        const record = records.find(item => item.sessionId === session.id && item.isoDate === isoDate);
        const start = sessionStartTimestamp(session, isoDate);
        const isPast = isoDate < todayIsoDate || (isoDate === todayIsoDate && start !== null && start < today.getTime());
        const beforeStart = !subscriptionStartDate(user) || isoDate < subscriptionStartDate(user);
        const afterEnd = Boolean((user.endDate || user.subscriptionEnd) && isoDate > (user.endDate || user.subscriptionEnd));
        const status = record?.status || (beforeStart ? "قبل بداية الاشتراك" : afterEnd ? "خارج مدة الاشتراك" : isPast ? "غائب" : isoDate === todayIsoDate ? "بانتظار التسجيل" : "موعد قادم");
        return { day, isoDate, sessionDate, session, record, status };
      });
    });
  const nextAppointment = (fromDate = today) => {
    const candidates = [];
    for (let offset = 0; offset <= 7; offset += 1) {
      const date = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + offset, 12);
      const day = weekdayForDate(localDateString(date));
      if (!selectedDays.includes(day)) continue;
      schedules.filter(session => sessionDays(session).includes(day)).forEach(session => {
        const isoDate = localDateString(date);
        const startsAt = sessionStartTimestamp(session, isoDate);
        const timestamp = startsAt ?? new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59).getTime();
        if (timestamp > fromDate.getTime()) candidates.push({ date, session, timestamp });
      });
    }
    return candidates.sort((a, b) => a.timestamp - b.timestamp)[0];
  };
  const weekGrid = selectedDays.length ? `<div class="attendance-week-grid">${selectedDays.map(day => {
    const dayIndex = WEEK_DAYS.indexOf(day);
    const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + dayIndex, 12);
    const isoDate = localDateString(date);
    const daySessions = upcomingSessions.filter(item => item.day === day);
    const entries = daySessions.length ? daySessions.map(item => {
      const isException = item.status === "معذور" || item.status === "استثناء";
      const label = isException ? "استثناء" : item.status;
      const badgeClass = label === "غائب" || label === "خارج مدة الاشتراك" ? "status-expired" : label === "متأخر" || label === "استثناء" || label === "قبل بداية الاشتراك" ? "status-soon" : label === "حاضر" ? "status-active" : "";
      const next = label === "متأخر" ? nextAppointment(today) : null;
      return `<div class="attendance-day-entry"><div><strong>${escapeHtml(readableSessionTitle(item.session.title))}</strong><small>${escapeHtml(sessionTimeRange(item.session))}</small></div><span class="subscription-badge ${badgeClass}">${escapeHtml(label)}</span>${item.record?.registeredAt && label !== "غائب" ? `<small>وقت الوصول: ${escapeHtml(item.record.registeredAt)}</small>` : ""}${next ? `<small>الموعد القادم: ${escapeHtml(weekdayForDate(localDateString(next.date)))} ${escapeHtml(egyptianDate.format(next.date))} · ${escapeHtml(sessionTimeRange(next.session))}</small>` : ""}</div>`;
    }).join("") : '<small>لا يوجد موعد محدد</small>';
    return `<article class="attendance-day-card"><strong>${escapeHtml(day)}</strong><span class="attendance-day-date">${escapeHtml(egyptianDate.format(date))}</span>${entries}</article>`;
  }).join("")}</div>` : '<div class="empty-state"><p>لم تختر أيام تدريب أسبوعية بعد.</p></div>';
  const exceptions = records.filter(record => record.status === "معذور" || record.status === "استثناء");
  const exceptionList = exceptions.length ? `<div class="attendance-exception-list">${exceptions.map(record => `<div class="attendance-exception-row"><span class="subscription-badge status-soon">استثناء</span><strong>${escapeHtml(weekdayForDate(record.isoDate))} · ${escapeHtml(record.date)}</strong><span>${escapeHtml(readableSessionTitle(record.sessionTitle))} · وصل الساعة ${escapeHtml(record.registeredAt || "—")}</span></div>`).join("")}</div>` : "";
  const presentCount = user.legacyAttendanceAuto
    ? playerTrainingBalance(user).used
    : records.filter(record => record.status === "حاضر" || record.status === "متأخر").length;
  const absentCount = records.filter(record => record.status === "غائب" && !record.dayOff).length;
  const excuseCount = exceptions.length;
  return `<section class="page-intro"><div><p class="eyebrow">حساب اللاعب</p><h1>الحضور والغياب</h1><p class="welcome-subtitle">تابع أيام تدريبك وتاريخ كل حصة وحالة حضورك ووقت وصولك. الحصص التاريخية المحتسبة تلقائيًا تظهر بوضوح.</p></div></section><section class="coach-code-value player-code-panel"><span>كود اللاعب</span><strong>${escapeHtml(user.playerCode)}</strong><button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(user.playerCode)}">نسخ الكود</button></section><section class="member-attendance-stats"><article><strong>${arabicDigits(presentCount)}</strong><span>🟢 حاضر / محسوب</span></article><article><strong>${arabicDigits(absentCount)}</strong><span>🔴 غائب</span></article><article><strong>${arabicDigits(excuseCount)}</strong><span>🟡 بعذر</span></article></section><section class="panel"><div class="panel-heading"><div><h2>كشف أيام التدريب لهذا الأسبوع</h2><p>حالة كل حصة وتاريخها ووقتها.</p></div></div>${weekGrid}${exceptionList ? `<div class="attendance-exceptions"><h3>استثناءات الحضور في أيام أخرى</h3>${exceptionList}</div>` : ""}</section><section class="panel"><div class="panel-heading"><div><h2>مواعيد التمرين المرشحة</h2><p>المواعيد المناسبة لفئة اللاعب وأيام تدريبه.</p></div></div>${sessionCards(schedules, false, user)}</section><section class="panel"><div class="panel-heading"><div><h2>سجل الحضور والغياب</h2><p>سجلات الحضور والغياب والتدريبات التي احتسبها المشرف تلقائيًا من تاريخ بداية الاشتراك.</p></div></div>${records.length ? `<div class="table-wrap"><table><thead><tr><th>التدريب</th><th>تاريخ الحصة وموعدها</th><th>وقت الحضور</th><th>الحالة / الاستثناء</th></tr></thead><tbody>${records.map(record => { const request = record.legacyAuto ? null : makeUpRequestFor(record); const exceptionLabel = request ? `استثناء ${request.status}` : ""; const exceptionAction = !record.legacyAuto && !request && canRequestMakeup(user, record) ? `<button class="small-action" data-action="request-makeup" data-attendance="${escapeHtml(record.id)}">طلب استثناء</button>` : ""; const statusLabel = record.status === "معذور" ? "استثناء" : record.status || "حاضر"; return `<tr><td>${escapeHtml(readableSessionTitle(record.sessionTitle || "تدريب"))}</td><td>${escapeHtml(record.date || record.isoDate)} · ${escapeHtml(record.sessionTime || "—")}</td><td>${escapeHtml(record.registeredAt || "—")}</td><td><span class="subscription-badge ${record.status === "غائب" ? "status-expired" : record.status === "معذور" || record.status === "متأخر" ? "status-soon" : "status-active"}">${escapeHtml(statusLabel)}</span>${record.legacyAuto ? '<small class="table-subtext">احتساب تلقائي حسب موعد التدريب</small>' : ""}${exceptionLabel ? `<small class="table-subtext">${escapeHtml(exceptionLabel)}${request.date ? ` · ${escapeHtml(request.date)} ${escapeHtml(request.time || "")} · ${escapeHtml(request.sessionTitle || "")}` : ""}</small>` : ""}${exceptionAction}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد سجلات حضور بعد.</p></div>'}</section>`;
}

function memberSubscriptionView() {
  const user = userForMember();
  if (!user) return "";
  const selectedDays = user.weeklyDays || [];
  const summary = priceSummary(selectedDays.length || user.weeklyDaysCount);
  const trainingBalance = playerTrainingBalance(user);
  const state = subscriptionState(user);
  const endDate = user.subscriptionEnd ? egyptianDate.format(new Date(`${user.subscriptionEnd}T12:00:00`)) : "لم يتم التفعيل بعد";
  const canEditSchedule = canEditPlayerSchedule(user);
  const scheduleEditNote = canEditSchedule
    ? isInitialSubscriptionSetup(user)
      ? '<p class="form-note">اختر أيام تدريبك وجدولك قبل إرسال طلب الاشتراك الأول.</p>'
      : ""
    : '<p class="form-note">تعديل أيام التدريب متاح عند تبقي تدريب واحد، أو وجود تدريبات غير مدفوعة بعد انتهاء الاشتراك، أو وجود دفع جزئي.</p>';
  const daysInput = dayCheckboxes(data.workDays, selectedDays, "weeklyDays", !canEditSchedule);
  const pendingPayment = hasPendingPayment(user);
  const hasChosenSession = selectedSessionsForMember(user).length > 0;
  const walletBalance = memberWalletBalance(user);
  const remainingBalance = Math.max(0, Number(user.cashDebt || 0));
  const renewalAmountDue = Math.max(0, summary.plan.price - walletBalance);
  return `<section class="page-intro"><div><p class="eyebrow">باقتك وتدريباتك</p><h1>اشتراك ${escapeHtml(summary.plan.name)}</h1><p class="welcome-subtitle">اختر أيام حضورك الأسبوعية، ويُحسب الاشتراك حسب عددها.</p></div><span class="subscription-badge ${state.className}">${state.label}</span></section>
    <section class="pricing-hero"><span class="pricing-kicker">سعر الاشتراك الشهري</span><div class="pricing-number">${arabicDigits(summary.plan.price)} <small>ج.م / شهر · ${summary.sessions} تدريبات</small></div><p>سعر التدريب الواحد ${arabicDigits(summary.sessionPrice)} ج.م · يحدّد المدرب الأسعار من لوحة الأكاديمية.</p></section>
    <section class="member-stats plan-details"><article class="member-stat"><p>التدريبات المستخدمة</p><strong>${arabicDigits(trainingBalance.used)}</strong><small>${user.legacyAttendanceAuto ? "تُحسب من أول تمرين والجدول مع استثناء الغياب" : "تُخصم عند تأكيد الحضور"}</small></article><article class="member-stat"><p>التمارين المتبقية</p><strong>${arabicDigits(trainingBalance.remaining)}</strong><small>من ${arabicDigits(trainingBalance.allowance)} تمرينًا</small></article><article class="member-stat"><p>تاريخ نهاية الاشتراك</p><strong>${endDate}</strong><small>الحالة: ${state.label}</small></article><article class="member-stat"><p>رصيد المحفظة</p><strong>${arabicDigits(walletBalance)} ج.م</strong><small>المستحق بعد الخصم: ${arabicDigits(renewalAmountDue)} ج.م</small></article><article class="member-stat"><p>الرصيد المتبقي المستحق</p><strong>${arabicDigits(remainingBalance)} ج.م</strong><small>مبالغ جزئية لم تُستكمل بعد</small></article><article class="member-stat"><p>كود اللاعب</p><strong class="player-code">${escapeHtml(user.playerCode)}</strong><small>تاريخ الانضمام: ${joinedDate(user)}</small></article></section>
    <section class="panel plan-options"><div class="panel-heading"><div><h2>أيام تدريبك الأسبوعية</h2><p>اختر من أيام عمل الأكاديمية المحددة من المدرب.</p></div></div>${data.workDays.length ? `<form id="member-days-form"><div class="day-choice-grid member-day-grid">${daysInput}</div>${scheduleEditNote}<p id="member-days-price" class="price-preview">${selectedDays.length ? `اشتراكك الحالي: ${arabicDigits(summary.plan.price)} ج.م شهريًا` : "اختر يومًا واحدًا على الأقل."}</p><button class="primary-button" type="submit" ${canEditSchedule ? "" : "disabled"}>حفظ أيام التدريب <span>←</span></button></form>` : '<div class="empty-state"><p>لم يحدد المدرب أيام العمل بعد.</p></div>'}<div class="payment-cta"><strong>السعر ${arabicDigits(summary.plan.price)} ج.م · رصيد ${arabicDigits(walletBalance)} ج.م · المستحق ${arabicDigits(renewalAmountDue)} ج.م</strong><button class="primary-button" data-action="payment" ${selectedDays.length && hasChosenSession && canRequestPayment(user) && !pendingPayment && !hasPartialCashPayment(user) ? "" : "disabled"}>${pendingPayment ? "طلب الدفع قيد المراجعة" : hasPartialCashPayment(user) ? "أكمل الدفع النقدي لدى الأكاديمية" : !hasChosenSession ? "اختر مواعيدك أولًا" : canRequestPayment(user) ? renewalAmountDue ? "تجديد / دفع الاشتراك" : "تجديد باستخدام رصيد المحفظة" : "الدفع متاح عند تبقي تمرين واحد"} <span>←</span></button></div></section>`;
}

function memberPaymentsView() {
  const user = userForMember();
  if (!user) return "";
  const payments = data.payments.filter(payment => payment.playerId === user.id).sort((a, b) => b.createdAt - a.createdAt);
  const address = data.instaPayAddress
    ? `<strong>${escapeHtml(data.instaPayAddress)}</strong><button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(data.instaPayAddress)}">نسخ الرقم</button>`
    : "<strong>سيُضاف عنوان الدفع من إدارة الأكاديمية</strong>";
  const hasChosenSession = selectedSessionsForMember(user).length > 0;
  const paymentAllowed = hasChosenSession && canRequestPayment(user) && !hasPendingPayment(user) && !hasPartialCashPayment(user);
  const walletBalance = memberWalletBalance(user);
  const remainingBalance = Math.max(0, Number(user.cashDebt || 0));
  const renewalAmountDue = Math.max(0, priceSummary(user.weeklyDays?.length || user.weeklyDaysCount).plan.price - walletBalance);
  const paymentBlockedMessage = hasPartialCashPayment(user)
    ? "لديك دفعة نقدية جزئية. أكمل المبلغ المتبقي لدى الأكاديمية لتفعيل الاشتراك."
    : !hasChosenSession ? "اختر مواعيد التدريب أولًا من صفحة جدول التدريبات."
      : `لا يمكن الدفع الآن. يتاح التجديد عند تبقي تمرين واحد أو انتهاء الاشتراك. المتبقي حاليًا ${arabicDigits(user.sessionsLeft || 0)} تمرين.`;
  return `<section class="page-intro"><div><p class="eyebrow">وسائل الدفع</p><h1>المدفوعات والاشتراك</h1><p class="welcome-subtitle">راجع طرق الدفع وسجل عمليات الاشتراك.</p></div></section>
    <section class="instapay-panel"><span class="instapay-brand">⇄</span><div><h2>الدفع عبر إنستا باي / المحفظة البنكية</h2><p>${paymentAllowed ? `المبلغ المطلوب بعد خصم رصيدك (${arabicDigits(walletBalance)} ج.م): ${arabicDigits(renewalAmountDue)} ج.م.` : paymentBlockedMessage}</p><div class="instapay-hint"><span>رصيدك الدائن</span><strong>${arabicDigits(walletBalance)} ج.م</strong></div><div class="instapay-hint"><span>الرصيد المتبقي المستحق</span><strong>${arabicDigits(remainingBalance)} ج.م</strong></div><div class="instapay-hint"><span>رقم / عنوان التحويل</span>${address}</div><p class="payment-warning">أرسل صورة إيصال التحويل إلى الأكاديمية عبر واتساب بعد الدفع.</p></div><button class="primary-button" data-action="payment" ${paymentAllowed ? "" : "disabled"}>${paymentAllowed ? renewalAmountDue ? "تسجيل تحويل جديد" : "تجديد باستخدام رصيد المحفظة" : "التجديد غير متاح الآن"} <span>←</span></button></section>
    <section class="panel payment-history"><div class="panel-heading"><div><h2>سجل المدفوعات</h2><p>المبلغ وتاريخ الدفع وحالته</p></div></div>${payments.length ? `<div class="history-list">${payments.map(payment => `<div class="history-item"><span class="payment-icon">⇄</span><span><strong>${escapeHtml(payment.planName)}${paymentDurationLabel(payment) ? ` · ${escapeHtml(paymentDurationLabel(payment))}` : ""} · ${arabicDigits(payment.amount)} ج.م</strong><small>${escapeHtml(paymentMethodLabel(payment))} · ${escapeHtml(payment.date)}</small>${payment.siblingDiscount ? `<small>خصم إخوة: ${arabicDigits(payment.siblingDiscount)} ج.م</small>` : ""}${payment.walletCreditUsedAmount ? `<small>استُخدم من رصيدك: ${arabicDigits(payment.walletCreditUsedAmount)} ج.م</small>` : ""}${payment.walletCreditAddedAmount ? `<small>أُضيف إلى رصيدك: ${arabicDigits(payment.walletCreditAddedAmount)} ج.م</small>` : ""}</span><span class="subscription-badge ${isRecordedPayment(payment) && payment.status !== "دفع جزئي نقدًا" ? "status-active" : "status-soon"}">${escapeHtml(payment.status)}</span></div>`).join("")}</div>` : '<div class="empty-state"><p>لا توجد مدفوعات مسجلة بعد.</p></div>'}</section>`;
}

function coachHomeView() {
  const activeUsers = data.users.filter(user => user.role === "member");
  const expiring = activeUsers.filter(user => {
    const remaining = daysUntil(user.subscriptionEnd);
    return remaining !== null && remaining >= 0 && remaining <= 7;
  });
  const pending = data.payments.filter(payment => payment.status === "بانتظار المراجعة");
  const today = localDateString();
  const presentToday = data.attendance.filter(item => item.isoDate === today && item.status !== "غائب" && item.dayOff !== true).length;
  return `${notificationPanelForCurrentUser()}<section class="portal-welcome"><div><p class="eyebrow"><span class="live-dot"></span>${egyptianDate.format(new Date())}</p><h1>أهلًا ${OWNER_NAME} <span class="wave">✦</span></h1><p class="welcome-subtitle">إدارة الأكاديمية، المدربين، حضور اللاعبين والحسابات المالية.</p></div><div class="welcome-actions"><div class="welcome-notification-slot"></div><button class="primary-button" data-action="new-session"><span>＋</span> إضافة تدريب</button></div></section>
    <section class="member-stats coach-stats"><article class="member-stat"><span class="member-stat-icon green-icon">♙</span><p>اللاعبون المسجلون</p><strong>${arabicDigits(activeUsers.length)} لاعب</strong><small>في قاعدة بيانات هذا الجهاز</small></article><article class="member-stat"><span class="member-stat-icon blue-icon">✓</span><p>الحضور اليوم</p><strong>${arabicDigits(presentToday)} لاعب</strong><small>مسجل بواسطة المشرف</small></article><article class="member-stat"><span class="member-stat-icon amber-icon">!</span><p>اشتراكات للتجديد</p><strong>${arabicDigits(expiring.length)} اشتراك</strong><small>خلال الأيام السبعة القادمة</small></article><article class="member-stat"><span class="member-stat-icon purple-icon">⇄</span><p>تحويلات للمراجعة</p><strong>${arabicDigits(pending.length)} طلب</strong><small>بانتظار تأكيد المشرف</small></article></section>
    <section class="portal-grid"><article class="panel"><div class="panel-heading"><div><h2>تدريبات الأكاديمية</h2><p>أيام العمل: ${escapeHtml(data.workDays.join("، ") || "لم تحدد بعد")}</p></div><button class="text-link" data-view="schedule">إدارة الجدول <span>←</span></button></div>${sessionCards(trainingGroups().slice(0, 3).flatMap(group => group.sessions), true)}</article><article class="panel"><div class="panel-heading"><div><h2>تنبيهات المتابعة</h2><p>اشتراكات ومدفوعات تحتاج إلى مراجعة</p></div></div><div class="coach-alerts"><button data-view="subscription"><span class="alert-badge amber-icon">!</span><span><strong>${arabicDigits(expiring.length)} اشتراك قريب الانتهاء</strong><small>راجع الاشتراكات وأبلغ أولياء الأمور.</small></span></button><button data-view="payments"><span class="alert-badge purple-icon">⇄</span><span><strong>${arabicDigits(pending.length)} دفعة بنكية أو إلكترونية</strong><small>تحقق من المراجع والإيصالات قبل تأكيد الدفع.</small></span></button><button data-view="settings"><span class="alert-badge green-icon">⚙</span><span><strong>تعديل أيام العمل والأسعار</strong><small>حدد مواعيد الأكاديمية وقيمة كل باقة.</small></span></button></div></article></section>`;
}

function coachScheduleView() {
  return `<section class="page-intro"><div><p class="eyebrow">إدارة الأكاديمية</p><h1>جدول التدريبات</h1><p class="welcome-subtitle">أيام العمل: ${escapeHtml(data.workDays.join("، ") || "لم تحدد بعد")}</p></div><button class="primary-button" data-action="new-session"><span>＋</span> إضافة ساعة تدريب</button></section><section class="panel schedule-panel"><div class="panel-heading"><div><h2>ساعات التدريب</h2><p>${arabicDigits(data.sessions.length)} تمرين موزعة على ${arabicDigits(trainingGroups().length)} ساعة تدريب</p></div></div>${sessionCards(data.sessions, true)}</section>`;
}

function coachSettingsView() {
  const dayFields = WEEK_DAYS.map(day => `<label class="day-choice"><input type="checkbox" name="workDays" value="${day}" ${data.workDays.includes(day) ? "checked" : ""}><span>${day}</span></label>`).join("");
  const priceFields = WEEK_DAYS.slice(0, 7).map((_, index) => {
    const dayCount = index + 1;
    return `<label>${arabicDigits(dayCount)} ${dayCount === 1 ? "يوم" : "أيام"} أسبوعيًا<input type="number" name="price-${dayCount}" min="1" step="1" required value="${Number(data.pricesByDays[dayCount] ?? DEFAULT_DAY_PRICES[dayCount])}"></label>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">إعداد الأكاديمية</p><h1>أيام العمل والأسعار</h1><p class="welcome-subtitle">حدد أيام استقبال اللاعبين وأسعار الاشتراكات الشهرية حسب أيام التدريب.</p></div></section><form class="panel academy-settings-form" id="coach-settings-form"><fieldset class="registration-days"><legend>أيام عمل الأكاديمية</legend><div class="day-choice-grid">${dayFields}</div><p class="form-note">لا يمكن حذف يوم عليه حصة مجدولة. عدّل جدول الحصص أولًا.</p></fieldset><div class="pricing-settings"><div class="panel-heading"><div><h2>الاشتراك الشهري حسب عدد أيام التدريب</h2><p>يختار اللاعب أيام التدريب، ويُحسب السعر حسب عدد الأيام المختارة أسبوعيًا.</p></div></div><div class="price-settings-grid">${priceFields}</div></div><button class="primary-button" type="submit">حفظ أيام العمل والأسعار <span>←</span></button></form>`;
}

function trainerHomeView() {
  const sessions = data.sessions.filter(session => session.coachId === currentUser.id);
  const players = data.users.filter(user => user.role === "member" && sessions.some(session => sessionIncludesMember(session, user)));
  const present = data.attendance.filter(record => record.isoDate === localDateString() && record.status === "حاضر" && players.some(player => player.id === record.playerId)).length;
  return `${notificationPanelForCurrentUser()}<section class="portal-welcome"><div><p class="eyebrow">فريق التدريب</p><h1>أهلًا كابتن ${escapeHtml(currentUser.name)}</h1><p class="welcome-subtitle">تابع مجموعاتك وسجّل حضور اللاعبين بسهولة.</p></div></section><section class="member-stats assistant-stats"><article class="member-stat"><span class="member-stat-icon green-icon">🏀</span><p>حصصي</p><strong>${arabicDigits(sessions.length)} حصة</strong></article><article class="member-stat"><span class="member-stat-icon blue-icon">♙</span><p>لاعبو مجموعاتي</p><strong>${arabicDigits(players.length)} لاعب</strong></article><article class="member-stat"><span class="member-stat-icon amber-icon">✓</span><p>حضور اليوم</p><strong>${arabicDigits(present)} لاعب</strong></article></section><section class="assistant-quick-panel panel"><div><h2>جاهز لتسجيل الحضور؟</h2><p>ابحث باسم اللاعب، ثم اختر مجموعته وسجّل وقت وصوله.</p></div><button type="button" class="primary-button" data-view="attendance">تسجيل حضور لاعب</button></section><section class="panel schedule-panel"><div class="panel-heading"><div><h2>حصصي التدريبية</h2><p>${arabicDigits(sessions.length)} حصص مسندة إليك</p></div></div>${sessionCards(sessions)}</section>`;
}

function trainerScheduleView() {
  const sessions = data.sessions.filter(session => session.coachId === currentUser.id);
  return `<section class="page-intro"><div><p class="eyebrow">جدول المدرب</p><h1>الحصص المسندة إليك</h1><p class="welcome-subtitle">للتعديل أو تسجيل حضور اللاعبين، تواصل مع مشرف الأكاديمية.</p></div></section><section class="panel schedule-panel">${sessionCards(sessions)}</section>`;
}

function coachTrainersView() {
  const trainers = data.users.filter(user => user.role === "trainer");
  return `<section class="page-intro"><div><p class="eyebrow">فريق الأكاديمية</p><h1>إدارة المدربين</h1><p class="welcome-subtitle">سجّل أسماء المدربين ثم عيّنهم إلى حصص التدريب. لا يحتاج المدرب إلى حساب أو تسجيل دخول.</p></div><button class="primary-button" data-action="new-trainer">＋ إضافة مدرب</button></section><section class="panel">${trainers.length ? `<div class="table-wrap"><table><thead><tr><th>المدرب</th><th>الحصص المسندة</th><th>الحضور اليوم</th></tr></thead><tbody>${trainers.map(trainer => { const sessions = data.sessions.filter(session => session.coachId === trainer.id); const attended = data.trainerAttendance.some(record => record.trainerId === trainer.id && record.isoDate === localDateString() && record.status === "حاضر"); return `<tr><td>${escapeHtml(trainer.name)}</td><td>${arabicDigits(sessions.length)} حصة</td><td><span class="subscription-badge ${attended ? "status-active" : "status-soon"}">${attended ? "حاضر" : "لم يسجل بعد"}</span></td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>أضف أسماء المدربين لإسنادهم إلى الحصص وتسجيل حضورهم.</p></div>'}</section>`;
}

function openTrainerForm() {
  if (currentUser?.role !== "coach") { showToast("إدارة حسابات المدربين من صلاحية المشرف فقط."); return; }
  openModal("إضافة مدرب", `<label>اسم المدرب<input name="name" required minlength="2" maxlength="80" placeholder="اسم المدرب بالكامل"></label><p class="modal-explainer">سيُضاف الاسم إلى قائمة المدربين ويمكن اختياره عند إعداد جدول التدريب. لا يلزم بريد إلكتروني أو حساب دخول للمدرب.</p>`, "حفظ اسم المدرب", form => saveTrainer(form), "إدارة المدربين");
}

function openPlayerForm() {
  openPlayerFormFor();
}

function openPlayerFormFor(player = null) {
  const isExistingPlayer = Boolean(player);
  if (currentUser?.role !== "guardian") { showToast("إضافة لاعب متاحة من حساب ولي الأمر فقط."); return; }
  if (!data.workDays.length) { showToast("لم يحدد المشرف أيام عمل الأكاديمية بعد."); return; }
  const title = isExistingPlayer ? "استكمال بيانات اللاعب" : "إضافة لاعب إلى حساب ولي الأمر";
  const nameField = `<label>اسم اللاعب<input name="name" required minlength="2" maxlength="80" ${isExistingPlayer ? "readonly" : ""} value="${escapeHtml(player?.name || "")}" placeholder="اسم اللاعب بالكامل"></label>`;
  const genderField = `<label>نوع اللاعب<select name="gender" required><option value="">اختر النوع</option><option value="male" ${player?.gender === "male" ? "selected" : ""}>ذكر</option><option value="female" ${player?.gender === "female" ? "selected" : ""}>أنثى</option></select></label>`;
  openModal(title, `${nameField}${genderField}<fieldset class="registration-birth-date"><legend>تاريخ ميلاد اللاعب</legend><div class="birth-date-fields"><label>اليوم<input name="birthDay" type="text" inputmode="numeric" pattern="[0-9٠-٩]{1,2}" maxlength="2" required placeholder="يوم"></label><label>الشهر<input name="birthMonth" type="text" inputmode="numeric" pattern="[0-9٠-٩]{1,2}" maxlength="2" required placeholder="شهر"></label><label>السنة<input name="birthYear" type="text" inputmode="numeric" pattern="[0-9٠-٩]{4}" maxlength="4" required placeholder="سنة"></label></div></fieldset><fieldset class="registration-days"><legend>أيام حضور اللاعب أسبوعيًا</legend><div class="day-choice-grid">${dayCheckboxes(data.workDays, player?.weeklyDays || [])}</div></fieldset><p class="modal-explainer">${isExistingPlayer ? `كود اللاعب ${escapeHtml(player.playerCode)} ثابت ولن يتغير. تغيير الفئة العمرية عند بلوغ الحد يتطلب موافقة المشرف.` : "سيُنشأ كود رقمي ثابت للاعب تلقائيًا. يعرضه اللاعب للمشرف لتسجيل حضوره."}</p>`, isExistingPlayer ? "حفظ البيانات" : "حفظ اللاعب", form => savePlayer(form, player?.id), "حساب ولي الأمر");
}

function openPlayerCodeLogin() {
  openModal("دخول اللاعب بكود الحضور", `<label>كود اللاعب الرقمي<input name="playerCode" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{6}" minlength="6" maxlength="6" required placeholder="أدخل الكود المكوّن من ٦ أرقام"></label><fieldset class="notification-consent"><legend>🔔 إشعارات الأكاديمية <span>الاختيار مطلوب</span></legend><label><input type="radio" name="notificationConsent" value="accept" required> أوافق على استلام إشعارات الأكاديمية</label><label><input type="radio" name="notificationConsent" value="decline" required> لا أوافق الآن، ويمكنني الموافقة لاحقًا</label></fieldset><p class="modal-explainer">كود اللاعب ثابت، ويستخدم للدخول إلى حساب اللاعب ولتسجيل الحضور بواسطة المشرف.</p>`, "دخول اللاعب", async form => {
    const code = normalizeDigits(String(form.get("playerCode")).trim());
    if (!/^\d{6}$/.test(code)) throw new Error("أدخل كود اللاعب المكوّن من ٦ أرقام.");
    const consent = String(form.get("notificationConsent") || "");
    if (!["accept", "decline"].includes(consent)) throw new Error("اختر الموافقة على إشعارات الأكاديمية أو رفضها قبل تسجيل الدخول.");
    const notificationPermission = await requestNotificationPermission(consent);
    const firebase = await window.firebaseReady;
    authFlowInProgress = true;
    try {
      const player = await firebase.signInWithPlayerCode(code);
      saveNotificationConsent(player.id, consent, notificationPermission);
      await activateCloudProfile(player);
      closeModal();
    } finally {
      authFlowInProgress = false;
    }
  }, "دخول اللاعب");
}

async function savePlayer(form, playerId = null) {
  if (currentUser?.role !== "guardian") { showToast("إضافة لاعب متاحة من حساب ولي الأمر فقط."); return; }
  const name = String(form.get("name")).trim();
  const day = Number(normalizeDigits(String(form.get("birthDay")).trim()));
  const month = Number(normalizeDigits(String(form.get("birthMonth")).trim()));
  const year = Number(normalizeDigits(String(form.get("birthYear")).trim()));
  const birthDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const gender = String(form.get("gender") || "");
  const weeklyDays = form.getAll("weeklyDays").map(String).filter(day => data.workDays.includes(day));
  const birthday = new Date(`${birthDate}T12:00:00`);
  if (name.length < 2 || !Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year) || year < 1000 || Number.isNaN(birthday.getTime()) || birthday.getFullYear() !== year || birthday.getMonth() !== month - 1 || birthday.getDate() !== day || birthDate > localDateString()) {
    showToast("أدخل يومًا وشهرًا وسنة صحيحة لتاريخ الميلاد.");
    return;
  }
  if (!["male", "female"].includes(gender)) { showToast("اختر نوع اللاعب: ذكر أو أنثى."); return; }
  if (!weeklyDays.length) { showToast("اختر يوم تدريب واحدًا على الأقل للاعب."); return; }
  const guardian = currentUser;
  const existingPlayer = playerId ? data.users.find(user => user.id === playerId && user.role === "member" && user.guardianId === guardian.id) : null;
  if (playerId && !existingPlayer) { showToast("لم يتم العثور على اللاعب في حساب ولي الأمر."); return; }
  const user = {
    ...(existingPlayer || {}),
    id: existingPlayer?.id || crypto.randomUUID(), role: "member", guardianId: guardian.id,
    playerCode: existingPlayer?.playerCode || "", joinedAt: existingPlayer?.joinedAt || new Date().toISOString(),
    name, birthDate, gender, guardian: guardian.name, guardianPhone: guardian.guardianPhone,
    whatsappPhone: guardian.whatsappPhone,
    category: !existingPlayer || !AGE_CATEGORIES.includes(existingPlayer.category) || existingPlayer.category === "جميع الفئات العمرية"
      ? playerCategoryForBirthDate(birthDate)
      : existingPlayer.category,
    weeklyDays, weeklyDaysCount: weeklyDays.length, plan: weeklyDays.length,
    sessionsLeft: existingPlayer?.sessionsLeft || 0, sessionsUsed: existingPlayer?.sessionsUsed || 0,
    subscriptionEnd: existingPlayer?.subscriptionEnd || null
  };
  const firebase = await window.firebaseReady;
  const savedUser = existingPlayer
    ? await firebase.updatePlayer(user)
    : await firebase.createPlayer(user, new Set(data.users.map(existing => existing.playerCode).filter(Boolean)));
  const previousUser = existingPlayer ? { ...existingPlayer } : null;
  if (existingPlayer) Object.assign(existingPlayer, savedUser);
  else data.users.push(savedUser);
  if (!saveData()) {
    if (existingPlayer) Object.assign(existingPlayer, previousUser);
    else data.users.pop();
    throw new Error("تم الحفظ في Firestore لكن تعذر تحديث التخزين المحلي. أعد تحميل الصفحة للتحقق من البيانات.");
  }
  selectedPlayerId = savedUser.id;
  localStorage.setItem(selectedPlayerStorageKey(guardian.id), selectedPlayerId);
  closeModal();
  renderView();
  showToast(existingPlayer ? `تم استكمال بيانات ${name} مع الحفاظ على كوده ${savedUser.playerCode}.` : `تمت إضافة ${name}. كود اللاعب ${savedUser.playerCode} ثابت لهذا الحساب.`);
}

function approvePlayerCategory(playerId) {
  if (currentUser?.role !== "coach") { showToast("اعتماد الفئات العمرية متاح للمشرف فقط."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  const nextCategory = pendingPlayerCategory(player);
  if (!player || !nextCategory) { showToast("لا يوجد انتقال فئة عمرية بانتظار الاعتماد لهذا اللاعب."); return; }
  const previousCategory = player.category;
  player.category = nextCategory;
  if (saveData()) {
    renderView();
    showToast(`تم اعتماد انتقال ${player.name} إلى فئة ${nextCategory}.`);
  } else {
    player.category = previousCategory;
  }
}

function openSubscriptionOverride(playerId) {
  if (currentUser?.role !== "coach") { showToast("تعديل الاشتراك الإداري متاح للمشرف فقط."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  if (!player) { showToast("لم يتم العثور على اللاعب."); return; }
  const startDate = player.subscriptionStart || player.actualStartDate || player.expectedStartDate || localDateString();
  const endDate = player.endDate || player.subscriptionEnd || "";
  openModal(
    `تعديل اشتراك ${player.name}`,
    `<p class="modal-explainer">هذا الإجراء مخصص للاشتراكات السابقة لإطلاق المنصة أو للتصحيح الإداري. أدخل التدريبات المنجزة سابقًا والرصيد الحالي؛ لن يُنشأ سجل دفع.</p><label>عدد التمارين المنجزة قبل المنصة<input name="attendedBeforePlatform" type="number" min="0" max="500" step="1" value="${Number(player.subscriptionOverride?.attendedBeforePlatform ?? player.sessionsUsed ?? 0)}" required></label><label>عدد التمارين المتبقية حاليًا<input name="remainingSessions" type="number" min="0" max="500" step="1" value="${Number(player.sessionsLeft ?? 0)}" required></label><div class="form-row"><label>تاريخ بدء الاشتراك<input name="subscriptionStart" type="date" value="${escapeHtml(startDate)}" required></label><label>تاريخ انتهاء الاشتراك<input name="subscriptionEnd" type="date" value="${escapeHtml(endDate)}" required></label></div>`,
    "حفظ تعديل الاشتراك",
    form => saveSubscriptionOverride(form, player.id),
    "إدارة اللاعبين"
  );
}

async function saveSubscriptionOverride(form, playerId) {
  if (currentUser?.role !== "coach") { showToast("تعديل الاشتراك الإداري متاح للمشرف فقط."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  if (!player) { showToast("لم يتم العثور على اللاعب."); return; }
  const attendedValue = String(form.get("attendedBeforePlatform") ?? "");
  const remainingValue = String(form.get("remainingSessions") ?? "");
  const attendedBeforePlatform = Number(attendedValue);
  const remainingSessions = Number(remainingValue);
  const subscriptionStart = String(form.get("subscriptionStart") || "");
  const subscriptionEnd = String(form.get("subscriptionEnd") || "");
  if (!/^\d+$/.test(attendedValue) || !Number.isInteger(attendedBeforePlatform) || attendedBeforePlatform > 500
    || !/^\d+$/.test(remainingValue) || !Number.isInteger(remainingSessions) || remainingSessions > 500
    || !isValidIsoDate(subscriptionStart) || !isValidIsoDate(subscriptionEnd)
    || subscriptionEnd < subscriptionStart || attendedBeforePlatform + remainingSessions === 0) {
    showToast("تحقق من عدد التمارين (0–500) وتواريخ الاشتراك، ويجب أن يكون مجموع التمارين أكبر من صفر.");
    return;
  }
  const previous = { ...player };
  const previousBalance = playerTrainingBalance(player);
  const previousSubscription = `${player.subscriptionStart || player.actualStartDate || player.expectedStartDate || "غير محدد"} – ${player.endDate || player.subscriptionEnd || "غير محدد"}`;
  const override = {
    attendedBeforePlatform,
    remainingSessions,
    subscriptionStart,
    subscriptionEnd,
    updatedAt: Date.now(),
    updatedBy: currentUser.id
  };
  player.sessionsUsed = attendedBeforePlatform;
  player.sessionsLeft = remainingSessions;
  player.actualStartDate = subscriptionStart;
  player.expectedStartDate = subscriptionStart;
  player.subscriptionStart = subscriptionStart;
  player.endDate = subscriptionEnd;
  player.subscriptionEnd = subscriptionEnd;
  player.legacyAttendanceAuto = false;
  player.subscriptionOverride = override;
  player.subscriptionOverrideHistory = [
    ...(Array.isArray(player.subscriptionOverrideHistory) ? player.subscriptionOverrideHistory : []),
    override
  ].slice(-20);
  appendLegacyPlayerChange(
    player,
    "تعديل إداري للاشتراك",
    `${previousBalance.used} حاضر · ${previousBalance.remaining} متبقي · ${previousSubscription}`,
    `${attendedBeforePlatform} حاضر · ${remainingSessions} متبقي · ${subscriptionStart} – ${subscriptionEnd}`
  );
  if (!saveLocalData()) {
    Object.assign(player, previous);
    return;
  }
  try {
    const firebase = await window.firebaseReady;
    await firebase.updatePlayer(player);
    closeModal();
    renderView();
    showToast(`تم تحديث اشتراك ${player.name}: ${attendedBeforePlatform} تمرينًا منجزًا و${remainingSessions} متبقيًا.`);
  } catch (error) {
    Object.assign(player, previous);
    saveLocalData();
    console.error("تعذر حفظ تعديل الاشتراك الإداري في Firestore.", error);
    showToast(error instanceof Error ? `تعذر حفظ تعديل الاشتراك: ${error.message}` : "تعذر حفظ تعديل الاشتراك.");
  }
}

async function saveTrainer(form) {
  if (currentUser?.role !== "coach") { showToast("إضافة المدربين متاحة للمشرف فقط."); return; }
  const name = String(form.get("name")).trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) { showToast("أدخل اسمًا صحيحًا للمدرب."); return; }
  if (data.users.some(user => user.role === "trainer" && user.name.trim().toLocaleLowerCase("ar") === name.toLocaleLowerCase("ar"))) {
    showToast("هذا الاسم مسجل بالفعل ضمن المدربين.");
    return;
  }
  const trainer = { id: crypto.randomUUID(), role: "trainer", name, joinedAt: new Date().toISOString() };
  data.users.push(trainer);
  if (!saveData()) {
    data.users.pop();
    return;
  }
  closeModal();
  activeView = "trainers";
  renderView();
  showToast(`تمت إضافة المدرب ${name}.`);
}

function supervisorTrainerAttendanceView() {
  const trainers = data.users.filter(user => user.role === "trainer");
  const isoDate = localDateString();
  const records = data.trainerAttendance.filter(record => record.isoDate === isoDate);
  return `<section class="page-intro"><div><p class="eyebrow">سجل الجهاز الفني</p><h1>حضور المدربين</h1><p class="welcome-subtitle">سجل حضور وانصراف المدربين يوميًا بصلاحية المشرف.</p></div><button class="primary-button" data-action="mark-trainer-attendance">تسجيل حضور اليوم</button></section><section class="panel"><div class="panel-heading"><div><h2>حالة اليوم</h2><p>${egyptianDate.format(new Date())} · ${arabicDigits(records.filter(record => record.status === "حاضر").length)} من ${arabicDigits(trainers.length)} مدرب</p></div></div>${trainers.length ? `<div class="table-wrap"><table><thead><tr><th>المدرب</th><th>الحالة</th><th>وقت التسجيل</th></tr></thead><tbody>${trainers.map(trainer => { const record = records.find(item => item.trainerId === trainer.id); return `<tr><td>${escapeHtml(trainer.name)}</td><td><span class="subscription-badge ${record?.status === "حاضر" ? "status-active" : "status-expired"}">${escapeHtml(record?.status || "لم يسجل")}</span></td><td>${escapeHtml(record?.checkInAt || "—")}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>أضف حسابات المدربين قبل تسجيل الحضور.</p></div>'}</section>`;
}

function openTrainerAttendanceForm() {
  if (currentUser?.role !== "coach") { showToast("تسجيل حضور المدربين من صلاحية المشرف فقط."); return; }
  const trainers = data.users.filter(user => user.role === "trainer");
  if (!trainers.length) { showToast("أضف حسابات المدربين أولًا."); return; }
  const today = localDateString();
  const now = new Date();
  const timeNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const rows = trainers.map(trainer => {
    const existing = data.trainerAttendance.find(record => record.trainerId === trainer.id && record.isoDate === today);
    return `<div class="roster-row"><div><strong>${escapeHtml(trainer.name)}</strong><small>${existing ? `الحالة المسجلة: ${escapeHtml(existing.status)}` : "لم يسجل حضور اليوم"}</small></div><select name="trainer-status-${escapeHtml(trainer.id)}"><option value="حاضر" ${existing?.status === "حاضر" ? "selected" : ""}>حاضر</option><option value="غائب" ${existing?.status === "غائب" ? "selected" : ""}>غائب</option></select><label>وقت الحضور<input name="trainer-time-${escapeHtml(trainer.id)}" type="time" value="${escapeHtml(existing?.checkInAt || timeNow)}"></label></div>`;
  }).join("");
  openModal("تسجيل حضور المدربين", `<label>تاريخ الحضور<input type="date" name="attendanceDate" value="${today}" required></label><div class="roster-list">${rows}</div>`, "حفظ حضور المدربين", form => saveTrainerAttendance(form), "إدارة المدربين");
}

function saveTrainerAttendance(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل حضور المدربين من صلاحية المشرف فقط."); return; }
  const isoDate = String(form.get("attendanceDate"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || Number.isNaN(new Date(`${isoDate}T12:00:00`).getTime())) { showToast("أدخل تاريخًا صحيحًا."); return; }
  const changes = [];
  data.users.filter(user => user.role === "trainer").forEach(trainer => {
    const status = String(form.get(`trainer-status-${trainer.id}`));
    if (!["حاضر", "غائب"].includes(status)) return;
    const checkInAt = String(form.get(`trainer-time-${trainer.id}`) || "");
    const existing = data.trainerAttendance.find(record => record.trainerId === trainer.id && record.isoDate === isoDate);
    if (existing) {
      changes.push({ record: existing, previous: { ...existing } });
      Object.assign(existing, { trainerName: trainer.name, status, checkInAt, timestamp: new Date(`${isoDate}T${checkInAt || "00:00"}:00`).getTime() });
    } else {
      const record = { id: crypto.randomUUID(), trainerId: trainer.id, trainerName: trainer.name, isoDate, status, checkInAt, timestamp: new Date(`${isoDate}T${checkInAt || "00:00"}:00`).getTime() };
      data.trainerAttendance.push(record);
      changes.push({ record, added: true });
    }
  });
  if (!changes.length) { showToast("لا توجد حالات حضور لتسجيلها."); return; }
  if (saveData()) { closeModal(); renderView(); showToast("تم حفظ سجل حضور المدربين."); }
  else {
    changes.forEach(change => {
      if (change.added) data.trainerAttendance.splice(data.trainerAttendance.indexOf(change.record), 1);
      else Object.assign(change.record, change.previous);
    });
  }
}

function financeView() {
  const month = byId("finance-month")?.value || localDateString().slice(0, 7);
  const paymentDate = payment => {
    const timestamp = Number(payment.confirmedAt ?? payment.createdAt);
    return Number.isFinite(timestamp) ? localDateString(new Date(timestamp)) : localDateString();
  };
  const income = data.payments.filter(isRecordedPayment);
  const monthPayments = income.filter(payment => paymentDate(payment).slice(0, 7) === month);
  const monthRevenues = data.revenues.filter(revenue => revenue.date.slice(0, 7) === month);
  const monthExpenses = data.expenses.filter(expense => expense.date.slice(0, 7) === month);
  const totalIncome = income.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
    + data.revenues.reduce((sum, revenue) => sum + Number(revenue.amount || 0), 0);
  const totalExpenses = data.expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const filteredIncomeTotal = monthPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
    + monthRevenues.reduce((sum, revenue) => sum + Number(revenue.amount || 0), 0);
  const filteredExpensesTotal = monthExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const monthlyNet = filteredIncomeTotal - filteredExpensesTotal;
  const lifetimeNet = totalIncome - totalExpenses;
  const rows = [
    ...monthPayments.map(payment => ({ date: paymentDate(payment), title: `${payment.status === "سداد مديونية نقدية" ? `سداد مديونية ${payment.playerName}` : `اشتراك ${payment.playerName}`} · ${paymentMethodLabel(payment)}${payment.siblingDiscount ? ` · خصم إخوة ${arabicDigits(payment.siblingDiscount)} ج.م` : ""}${payment.specialDiscountAmount ? ` · خصم استثنائي ${arabicDigits(payment.specialDiscountAmount)} ج.م` : ""}${payment.debtAddedAmount ? ` · مديونية ${arabicDigits(payment.debtAddedAmount)} ج.م` : ""} · ${payment.paidTime || ""}`, amount: Number(payment.amount || 0), type: "إيراد" })),
    ...monthRevenues.map(revenue => ({ date: revenue.date, title: revenue.description, amount: Number(revenue.amount || 0), type: "إيراد", revenueId: revenue.id })),
    ...monthExpenses.map(expense => ({ date: expense.date, title: expense.description, amount: Number(expense.amount || 0), type: "مصروف", expenseId: expense.id }))
  ].sort((a, b) => b.date.localeCompare(a.date));
  return `<section class="page-intro"><div><p class="eyebrow">حسابات الأكاديمية</p><h1>الإيرادات والمصروفات</h1><p class="welcome-subtitle">الإيرادات تشمل الاشتراكات المؤكدة والإيرادات اليدوية؛ التحويلات قيد المراجعة لا تُحتسب.</p></div><div class="finance-actions"><button class="primary-button" data-action="new-revenue"><span>＋</span> تسجيل إيراد</button><button class="finance-expense-button" data-action="new-expense"><span>−</span> تسجيل مصروف</button></div></section><section class="finance-filter"><label>الشهر المعروض<input id="finance-month" type="month" value="${escapeHtml(month)}"></label></section><section class="member-stats coach-stats finance-stats"><article class="member-stat"><p>إيرادات هذا الشهر</p><strong>${arabicDigits(filteredIncomeTotal)} ج.م</strong><small>${arabicDigits(monthPayments.length + monthRevenues.length)} دفعة وإيراد</small></article><article class="member-stat"><p>مصروفات هذا الشهر</p><strong>${arabicDigits(filteredExpensesTotal)} ج.م</strong><small>${arabicDigits(monthExpenses.length)} مصروف</small></article><article class="member-stat"><p>صافي هذا الشهر</p><strong class="finance-net ${monthlyNet < 0 ? "negative" : ""}"><bdi dir="ltr">${arabicDigits(monthlyNet)}</bdi> ج.م</strong><small>إيرادات الشهر ناقص مصروفاته</small></article><article class="member-stat"><p>صافي الربح منذ البداية</p><strong class="finance-net ${lifetimeNet < 0 ? "negative" : ""}"><bdi dir="ltr">${arabicDigits(lifetimeNet)}</bdi> ج.م</strong><small>الإيرادات ${arabicDigits(totalIncome)} − المصروفات ${arabicDigits(totalExpenses)}</small></article></section><section class="panel"><div class="panel-heading"><div><h2>حركة الشهر</h2><p>الإيرادات المسجلة والمصروفات حسب التاريخ</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th><th>إجراء</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.title)}</td><td><span class="subscription-badge ${row.type === "إيراد" ? "status-active" : "status-expired"}">${row.type}</span></td><td>${arabicDigits(row.amount)} ج.م</td><td>${row.expenseId ? `<button class="small-action" data-action="delete-expense" data-expense="${escapeHtml(row.expenseId)}">حذف المصروف</button>` : row.revenueId ? `<button class="small-action" data-action="delete-revenue" data-revenue="${escapeHtml(row.revenueId)}">حذف الإيراد</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد حركات مالية في هذا الشهر.</p></div>'}</section>`;
}

function openRevenueForm() {
  if (currentUser?.role !== "coach") { showToast("إدارة الإيرادات من صلاحية المشرف فقط."); return; }
  openModal("تسجيل إيراد للأكاديمية", `<label>بيان الإيراد<input name="description" required maxlength="120" placeholder="إيجار ملعب، رعاية، بيع أدوات..."></label><div class="form-row"><label>المبلغ بالجنيه<input name="amount" type="number" min="1" step="1" required></label><label>التاريخ<input name="date" type="date" value="${localDateString()}" required></label></div>`, "حفظ الإيراد", form => saveRevenue(form), "الحسابات المالية");
}

function saveRevenue(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الإيرادات متاح للمشرف فقط."); return; }
  const description = String(form.get("description")).trim();
  const amount = Number(form.get("amount"));
  const date = String(form.get("date"));
  if (!description || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast("أدخل وصفًا ومبلغًا صحيحًا بالجنيه وتاريخًا صحيحًا للإيراد."); return; }
  const revenue = { id: crypto.randomUUID(), description, amount, date, createdAt: Date.now() };
  data.revenues.push(revenue);
  if (saveData()) { closeModal(); renderView(); showToast("تم تسجيل الإيراد وإعادة حساب صافي الربح."); }
  else data.revenues.pop();
}

function deleteRevenue(revenueId) {
  if (currentUser?.role !== "coach") { showToast("حذف الإيرادات متاح للمشرف فقط."); return; }
  const index = data.revenues.findIndex(revenue => revenue.id === revenueId);
  if (index < 0) { showToast("لم يتم العثور على الإيراد."); return; }
  if (!window.confirm("هل تريد حذف هذا الإيراد من الحسابات؟")) return;
  const [revenue] = data.revenues.splice(index, 1);
  if (saveData()) {
    window.firebaseReady.then(firebase => firebase.deleteRecord("revenues", revenue.id)).then(() => {
      renderView();
      showToast("تم حذف الإيراد وإعادة حساب صافي الربح.");
    }).catch(error => {
      data.revenues.splice(index, 0, revenue);
      saveLocalData();
      console.error("تعذر حذف الإيراد من Firestore.", error);
      showToast("تعذر حذف الإيراد سحابيًا. لم يتم حذف السجل.");
    });
  } else data.revenues.splice(index, 0, revenue);
}

function openExpenseForm() {
  if (currentUser?.role !== "coach") { showToast("إدارة المصروفات من صلاحية المشرف فقط."); return; }
  openModal("تسجيل مصروف للأكاديمية", `<label>بيان المصروف<input name="description" required maxlength="120" placeholder="إيجار الملعب، أدوات، انتقالات..."></label><div class="form-row"><label>المبلغ بالجنيه<input name="amount" type="number" min="1" step="1" required></label><label>التاريخ<input name="date" type="date" value="${localDateString()}" required></label></div>`, "حفظ المصروف", form => saveExpense(form), "الحسابات المالية");
}

function saveExpense(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل المصروفات متاح للمشرف فقط."); return; }
  const description = String(form.get("description")).trim();
  const amount = Number(form.get("amount"));
  const date = String(form.get("date"));
  if (!description || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast("أدخل وصفًا ومبلغًا وتاريخًا صحيحًا للمصروف."); return; }
  const expense = { id: crypto.randomUUID(), description, amount: Math.round(amount), date, createdAt: Date.now() };
  data.expenses.push(expense);
  if (saveData()) { closeModal(); renderView(); showToast("تم تسجيل المصروف وحساب صافي الربح."); }
  else data.expenses.pop();
}

function deleteExpense(expenseId) {
  if (currentUser?.role !== "coach") { showToast("حذف المصروفات متاح للمشرف فقط."); return; }
  const index = data.expenses.findIndex(expense => expense.id === expenseId);
  if (index < 0) { showToast("لم يتم العثور على المصروف."); return; }
  if (!window.confirm("هل تريد حذف هذا المصروف من الحسابات؟")) return;
  const [expense] = data.expenses.splice(index, 1);
  if (saveData()) {
    window.firebaseReady.then(firebase => firebase.deleteRecord("expenses", expense.id)).then(() => {
      renderView();
      showToast("تم حذف المصروف وإعادة حساب صافي الربح.");
    }).catch(error => {
      data.expenses.splice(index, 0, expense);
      saveLocalData();
      console.error("تعذر حذف المصروف من Firestore.", error);
      showToast("تعذر حذف المصروف سحابيًا. لم يتم حذف السجل.");
    });
  } else data.expenses.splice(index, 0, expense);
}

function coachAttendanceView() {
  const records = [...data.attendance].sort((a, b) => b.timestamp - a.timestamp);
  const pendingMakeups = data.attendanceExceptions.filter(item => item.status === "بانتظار موافقة المشرف").sort((a, b) => b.createdAt - a.createdAt);
  const sessionButtons = data.sessions.length ? attendanceSlots(data.sessions).map(slot => {
    const session = slot.sessions[0];
    const days = [...new Set(slot.sessions.flatMap(sessionDays))];
    const categories = [...new Set(slot.sessions.flatMap(sessionCategories))].join("، ");
    const players = new Set(data.users.filter(user => user.role === "member" && slot.sessions.some(item => sessionIncludesMember(item, user))).map(user => user.id));
    const exercises = slot.sessions.map(item => `${escapeHtml(item.title)} (${escapeHtml(sessionCategoryLabel(item))})`).join("، ");
    const holiday = dayOffExists(slot.id, localDateString());
    return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(sessionTimeRange(session))}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(categories)}</strong><span>${exercises} · ${arabicDigits(players.size)} لاعب مسجل${holiday ? " · إجازة معلنة اليوم" : ""}</span></div><div class="schedule-actions"><button class="small-action" data-action="take-attendance" data-session="${escapeHtml(session.id)}" ${holiday ? "disabled" : ""}>${holiday ? "إجازة اليوم" : "كشف الساعة"}</button><button class="small-action" data-action="day-off" data-session="${escapeHtml(session.id)}" ${holiday ? "disabled" : ""}>إعلان إجازة</button></div></article>`;
  }).join("") : '<div class="empty-state"><p>أضف حصة إلى الجدول لفتح كشف الحضور.</p></div>';
  const makeupRows = pendingMakeups.map(request => {
    const user = data.users.find(item => item.id === request.playerId && item.role === "member");
    const expired = !user?.subscriptionEnd || localDateString() > user.subscriptionEnd;
    return `<article class="roster-row"><div><strong>${escapeHtml(request.playerName)} · غياب ${escapeHtml(request.absenceDate)}</strong><small>طلب تعويض: ${escapeHtml(request.sessionTitle)} · ${escapeHtml(request.date)} الساعة ${escapeHtml(request.time)}</small></div><div class="roster-actions"><button class="small-action" data-action="approve-makeup" data-request="${escapeHtml(request.id)}" ${expired ? "disabled" : ""}>${expired ? "انتهى الاشتراك" : "موافقة"}</button><button class="small-action danger-action" data-action="reject-makeup" data-request="${escapeHtml(request.id)}">رفض</button></div></article>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">متابعة اللاعبين</p><h1>الحضور والغياب</h1><p class="welcome-subtitle">سجّل حضور اليوم ووقته بدقة، وراجع طلبات تعويض الغياب قبل نهاية الاشتراك.</p></div><button class="primary-button" data-action="code-attendance">تسجيل بالكود</button></section><section class="panel"><div class="panel-heading"><div><h2>طلبات استثناء وتعويض الغياب</h2><p>يعرض اليوم والمجموعة ووقت حضور اللاعب؛ يجب اعتماد الطلب قبل انتهاء اشتراكه.</p></div><span class="subscription-badge ${pendingMakeups.length ? "status-soon" : "status-active"}">${arabicDigits(pendingMakeups.length)} طلبات معلقة</span></div>${pendingMakeups.length ? `<div class="roster-list">${makeupRows}</div>` : '<div class="empty-state"><p>لا توجد طلبات استثناء بانتظار الموافقة.</p></div>'}</section><section class="panel"><div class="panel-heading"><div><h2>كشف الحضور حسب الساعة</h2><p>يُعرض كل لاعب مرة واحدة، ويُسجل تلقائيًا في تمرينه المناسب لفئته.</p></div></div><div class="schedule-list">${sessionButtons}</div></section><section class="panel"><div class="panel-heading"><div><h2>سجل الحضور والغياب</h2><p>أوقات التسجيل والحالة وروابط واتساب الجاهزة لأولياء الأمور</p></div></div>${records.length ? `<div class="table-wrap"><table><thead><tr><th>اللاعب</th><th>الحصة</th><th>التاريخ والوقت</th><th>الحالة</th><th>ولي الأمر</th></tr></thead><tbody>${records.map(record => { const user = data.users.find(item => item.id === record.playerId); const status = record.status || "حاضر"; const message = status === "غائب" ? `نحيطكم علمًا بغياب اللاعب ${record.playerName} عن ${record.sessionTitle} بتاريخ ${record.date}.` : `تم تسجيل ${status} للاعب ${record.playerName} في ${record.sessionTitle} بتاريخ ${record.date}${record.registeredAt ? ` الساعة ${record.registeredAt}` : ""}.${record.attendedUnpaid ? " الاشتراك غير مدفوع." : ""}`; const unpaidLabel = record.unpaidException && record.attendedUnpaid ? " · استثناء غير مدفوع" : record.attendedUnpaid ? " · غير مدفوع" : ""; const makeupLabel = record.makeupException ? " · تعويض معتمد" : ""; return `<tr><td>${escapeHtml(record.playerName)}</td><td>${escapeHtml(record.sessionTitle)}</td><td>${escapeHtml(record.date)}<br>${escapeHtml(record.registeredAt || "")}</td><td><span class="subscription-badge ${status === "غائب" ? "status-expired" : status === "متأخر" ? "status-soon" : "status-active"}">${escapeHtml(status)}${unpaidLabel}${makeupLabel}</span></td><td>${user ? guardianWhatsApp(user, message) : "لم يسجل رقمًا"}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا يوجد حضور مسجل حتى الآن.</p></div>'}</section>`;
}

function openMakeupRequest(attendanceId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الاستثناء متاحة من حساب اللاعب أو ولي الأمر فقط."); return; }
  const user = userForMember();
  const absence = data.attendance.find(record => record.id === attendanceId && record.playerId === user?.id);
  if (!user || !absence || !canRequestMakeup(user, absence)) { showToast("طلب التعويض غير متاح لهذا الغياب أو انتهت فترة تقديمه."); return; }
  const maxDate = [localDateString(), user.subscriptionEnd].sort()[0];
  const sessions = sessionsForMember(user);
  if (!sessions.length) { showToast("لا توجد مجموعة مناسبة لتسجيل يوم التعويض."); return; }
  const sessionOptions = sessions.map(session => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))}</option>`).join("");
  const now = new Date();
  const timeNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal("طلب استثناء لتعويض الغياب", `<p class="modal-explainer">الغياب عن ${escapeHtml(absence.sessionTitle)} بتاريخ ${escapeHtml(absence.date)}. سجّل يومًا لاحقًا للغياب ومجموعة ووقت حضور اللاعب الفعلي. يمكن طلب التعويض في أي يوم حتى نهاية الاشتراك، ويجب اعتماده من المشرف.</p><label>يوم حضور التعويض<input name="makeupDate" type="date" min="${absence.isoDate}" max="${maxDate}" required></label><label>مجموعة التدريب<select name="sessionId" required>${sessionOptions}</select></label><label>وقت وصول اللاعب<input name="makeupTime" type="time" value="${timeNow}" required></label>`, "إرسال طلب الاستثناء", form => saveMakeupRequest(form, absence.id), "الحضور والغياب");
}

function saveMakeupRequest(form, attendanceId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الاستثناء متاحة من حساب اللاعب أو ولي الأمر فقط."); return; }
  const user = userForMember();
  const absence = data.attendance.find(record => record.id === attendanceId && record.playerId === user?.id);
  const date = String(form.get("makeupDate"));
  const time = String(form.get("makeupTime"));
  const session = data.sessions.find(item => item.id === form.get("sessionId"));
  if (!user || !absence || !canRequestMakeup(user, absence)) { showToast("طلب التعويض غير متاح لهذا الغياب أو انتهت فترة تقديمه."); return; }
  const dateValue = new Date(`${date}T12:00:00`);
  const timestamp = new Date(`${date}T${time}:00`).getTime();
  const maxDate = [localDateString(), user.subscriptionEnd].sort()[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || localDateString(dateValue) !== date || date <= absence.isoDate || date > maxDate ||
      !/^\d{2}:\d{2}$/.test(time) || !Number.isFinite(timestamp) || timestamp > Date.now() ||
      !session || !sessionIncludesMember(session, user) || !sessionDays(session).includes(weekdayForDate(date))) {
    showToast("اختر يومًا لاحقًا للغياب وضمن مدة الاشتراك، مع وقت ومجموعة صحيحة.");
    return;
  }
  const request = {
    id: crypto.randomUUID(), attendanceId: absence.id, playerId: user.id, playerName: user.name,
    absenceDate: absence.isoDate, sessionId: session.id, sessionTitle: session.title,
    date, time, timestamp, createdAt: Date.now(), status: "بانتظار موافقة المشرف"
  };
  data.attendanceExceptions.push(request);
  if (saveData()) { closeModal(); renderView(); showToast("تم إرسال طلب التعويض للمشرف للموافقة."); }
  else data.attendanceExceptions.pop();
}

function reviewMakeupRequest(requestId, approve) {
  if (currentUser?.role !== "coach") { showToast("مراجعة طلبات الاستثناء من صلاحية المشرف فقط."); return; }
  const request = data.attendanceExceptions.find(item => item.id === requestId && item.status === "بانتظار موافقة المشرف");
  if (!request) { showToast("طلب الاستثناء غير متاح للمراجعة."); return; }
  const user = data.users.find(item => item.id === request.playerId && item.role === "member");
  const absence = data.attendance.find(item => item.id === request.attendanceId && item.playerId === request.playerId);
  const session = data.sessions.find(item => item.id === request.sessionId);
  if (!user || !absence || absence.status !== "غائب" || !session || !sessionIncludesMember(session, user)) { showToast("تعذر التحقق من اللاعب أو الغياب أو مجموعة التعويض."); return; }
  if (!approve) {
    request.status = "مرفوض";
    request.reviewedAt = Date.now();
    if (saveData()) { renderView(); showToast("تم رفض طلب الاستثناء."); }
    else { request.status = "بانتظار موافقة المشرف"; delete request.reviewedAt; }
    return;
  }
  const startDate = subscriptionStartDate(user);
  if (!startDate || absence.isoDate < startDate || absence.isoDate >= (user.subscriptionEnd || "") ||
      localDateString() > (user.subscriptionEnd || "") || request.date <= request.absenceDate ||
      request.date > localDateString() || request.date > (user.subscriptionEnd || "")) {
    showToast("انتهت فترة اعتماد الاستثناء أو أن التاريخ خارج مدة الاشتراك.");
    return;
  }
  if (data.attendance.some(record => record.playerId === user.id && record.sessionId === session.id && record.isoDate === request.date)) {
    showToast("يوجد تسجيل حضور لهذه المجموعة واللاعب في يوم التعويض بالفعل.");
    return;
  }
  const previousUser = {
    ...user,
    weeklyDays: [...(user.weeklyDays || [])],
    attendanceLogs: [...(user.attendanceLogs || [])]
  };
  const previousSessionsUsed = user.sessionsUsed;
  const previousSessionsLeft = user.sessionsLeft;
  const previousStatus = request.status;
  const dateTime = new Date(request.timestamp);
  const paid = isPaidMember(user);
  const record = {
    id: crypto.randomUUID(), playerId: user.id, playerName: user.name, sessionId: session.id,
    sessionTitle: session.title, sessionTime: session.time, guardianPhone: user.guardianPhone,
    timestamp: request.timestamp, markedAt: Date.now(), isoDate: request.date,
    date: egyptianDate.format(dateTime), registeredAt: request.time,
    status: attendanceStatus(session, request.date, request.timestamp, user),
    attendedUnpaid: !paid, unpaidException: !paid, makeupException: true,
    makeupForAttendanceId: absence.id, attendanceExceptionId: request.id
  };
  if (paid) consumeTraining(user);
  if (!Array.isArray(user.attendanceLogs)) user.attendanceLogs = [];
  user.attendanceLogs.push(record.id);
  request.status = "تمت الموافقة";
  request.reviewedAt = Date.now();
  data.attendance.push(record);
  if (saveData()) { renderView(); showToast(`تم اعتماد تعويض ${user.name} وتسجيل ${record.status} في ${request.sessionTitle} يوم ${request.date} الساعة ${request.time}.`); }
  else {
    data.attendance.pop();
    user.attendanceLogs = previousUser.attendanceLogs || [];
    request.status = previousStatus;
    delete request.reviewedAt;
    Object.assign(user, previousUser);
    user.sessionsUsed = previousSessionsUsed;
    user.sessionsLeft = previousSessionsLeft;
  }
}

function trainerAttendanceView() {
  const sessions = data.sessions.filter(session => session.coachId === currentUser.id);
  const eligiblePlayers = data.users.filter(user => user.role === "member" && sessions.some(session => sessionIncludesMember(session, user)));
  return `<section class="page-intro"><div><p class="eyebrow">مساحة المدرب</p><h1>تسجيل حضور لاعب</h1><p class="welcome-subtitle">ابحث باسم اللاعب إذا لم يتذكر كود الحضور، ثم اختر مجموعته لتسجيل حضوره.</p></div></section><section class="panel"><label>ابحث باسم اللاعب<input id="trainer-player-search" type="search" autocomplete="off" placeholder="اكتب اسم اللاعب"></label><div id="trainer-player-results" class="roster-list"><div class="empty-state"><p>${eligiblePlayers.length ? "ابدأ بكتابة اسم اللاعب للبحث." : "لا يوجد لاعبون في المجموعات المسندة إليك."}</p></div></div></section>`;
}

function renderTrainerPlayerSearch(query) {
  const results = byId("trainer-player-results");
  if (!results || currentUser?.role !== "trainer") return;
  const normalizedQuery = query.trim().toLocaleLowerCase("ar");
  if (normalizedQuery.length < 2) {
    results.innerHTML = '<div class="empty-state"><p>اكتب حرفين على الأقل لعرض اللاعبين.</p></div>';
    return;
  }
  const sessions = data.sessions.filter(session => session.coachId === currentUser.id);
  const matches = data.users.filter(user => user.role === "member" && user.name.toLocaleLowerCase("ar").includes(normalizedQuery) && sessions.some(session => sessionIncludesMember(session, user)));
  if (!matches.length) {
    results.innerHTML = '<div class="empty-state"><p>لا يوجد لاعب بهذا الاسم ضمن مجموعاتك.</p></div>';
    return;
  }
  results.innerHTML = matches.map(player => {
    const playerSessions = sessions.filter(session => sessionIncludesMember(session, player));
    return playerSessions.map(session => {
      const alreadyRecorded = data.attendance.some(record => record.playerId === player.id && record.sessionId === session.id && record.isoDate === localDateString());
      const state = subscriptionState(player);
      return `<article class="roster-row assistant-player-row"><div><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(readableSessionTitle(session.title))} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))}</small></div><span class="subscription-badge ${state.className}">${escapeHtml(state.label)}</span><button type="button" class="small-action" data-action="trainer-mark-attendance" data-player="${escapeHtml(player.id)}" data-session="${escapeHtml(session.id)}" ${alreadyRecorded ? "disabled" : ""}>${alreadyRecorded ? "تم التسجيل اليوم" : "تسجيل الحضور"}</button></article>`;
    }).join("");
  }).join("");
}

function openSearchedPlayerAttendanceForm(playerId, sessionId) {
  if (currentUser?.role !== "trainer") { showToast("تسجيل الحضور من صلاحية المدرب المسند إليه التدريب."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  const session = data.sessions.find(item => item.id === sessionId && item.coachId === currentUser.id);
  if (!player || !session || !sessionIncludesMember(session, player)) { showToast("اللاعب أو المجموعة غير متاحين لحسابك."); return; }
  const windowError = attendanceWindowError(session, localDateString());
  if (windowError) { showToast(windowError); return; }
  const now = new Date();
  const timeNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal(`تسجيل حضور · ${player.name}`, `<p class="modal-explainer">المجموعة: ${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))}. تسجيل الحضور متاح من نصف ساعة قبل البداية حتى النهاية.</p><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><input type="hidden" name="sessionId" value="${escapeHtml(session.id)}"><label>تاريخ الحضور<input type="date" name="attendanceDate" value="${localDateString()}" required></label><label>وقت حضور اللاعب<input type="time" name="attendanceTime" value="${timeNow}" required></label>`, "تأكيد الحضور", form => saveTrainerAttendanceForPlayer(form), "حضور اللاعبين");
}

function saveTrainerAttendanceForPlayer(form) {
  if (currentUser?.role !== "trainer") { showToast("تسجيل الحضور متاح للمدرب المسند إليه التدريب."); return; }
  const player = data.users.find(user => user.id === form.get("playerId") && user.role === "member");
  const session = data.sessions.find(item => item.id === form.get("sessionId") && item.coachId === currentUser.id);
  if (!player || !session || !sessionIncludesMember(session, player)) { showToast("اللاعب أو المجموعة غير متاحين لحسابك."); return; }
  const isoDate = String(form.get("attendanceDate"));
  const time = String(form.get("attendanceTime"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !/^\d{2}:\d{2}$/.test(time) || Number.isNaN(new Date(`${isoDate}T${time}:00`).getTime())) { showToast("أدخل تاريخًا ووقتًا صحيحين للحضور."); return; }
  if (isoDate > localDateString()) { showToast("لا يمكن تسجيل حضور بتاريخ مستقبلي."); return; }
  registerPlayerAttendance(player, session, new Date(`${isoDate}T${time}:00`));
}

function openCodeAttendanceForm() {
  if (currentUser?.role !== "coach") { showToast("تسجيل الحضور بالكود من صلاحية المشرف فقط."); return; }
  const now = new Date();
  const availableSessions = data.sessions.filter(session =>
    !attendanceWindowError(session, localDateString(now), now)
    && !dayOffExists(attendanceSlotForSession(session)?.id, localDateString(now))
  );
  const slots = attendanceSlots(availableSessions);
  if (!slots.length) { showToast("لا توجد حصة متاحة للحضور في الساعة الحالية. تحقق من وقت الحصص وأيامها في الجدول."); return; }
  const selectedSlotId = slots.length === 1 ? slots[0].id : "";
  const options = slots.map(slot => {
    const session = slot.sessions[0];
    return `<option value="${escapeHtml(slot.id)}" ${slot.id === selectedSlotId ? "selected" : ""}>${escapeHtml(sessionTimeRange(session))}</option>`;
  }).join("");
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal("تسجيل حضور أو غياب بكود اللاعب", `<p class="attendance-current-time" aria-live="polite">الساعة الحالية: <strong id="attendance-current-time">${currentTime}</strong></p><label>ساعة التدريب<select name="slotId" required>${slots.length > 1 ? '<option value="">اختر الساعة</option>' : ""}${options}</select></label><label>كود اللاعب<input name="playerCode" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{6}" minlength="6" maxlength="6" required placeholder="الكود الرقمي المكوّن من ٦ أرقام"></label><label>حالة اللاعب<select name="attendanceStatus" required><option value="حاضر" selected>حاضر</option><option value="غائب">غائب — لا يُخصم تمرين ويمكن طلب تعويض</option></select></label><p class="modal-explainer">تظهر ساعات التدريب المفتوح تسجيل الحضور أو الغياب فيها الآن فقط. عند تسجيل الغياب بالكود يُحفظ في سجل الحضور دون خصم تمرين، ويمكن لولي الأمر أو اللاعب طلب تعويضه في يوم تدريب آخر قبل انتهاء الاشتراك.</p>`, "تسجيل الحالة بالكود", form => saveCodeAttendance(form), "الحضور والغياب");
  if (attendanceClockInterval !== null) clearInterval(attendanceClockInterval);
  attendanceClockInterval = setInterval(() => {
    const clock = byId("attendance-current-time");
    if (!clock || byId("action-modal").getAttribute("aria-hidden") === "true") {
      clearInterval(attendanceClockInterval);
      attendanceClockInterval = null;
      return;
    }
    const current = new Date();
    clock.textContent = `${String(current.getHours()).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}`;
  }, 1000);
}

async function saveCodeAttendance(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الحضور بالكود من صلاحية المشرف فقط."); return; }
  const code = normalizeDigits(String(form.get("playerCode")).trim());
  const player = data.users.find(user => user.role === "member" && user.playerCode === code);
  const status = String(form.get("attendanceStatus") || "حاضر");
  const availableSessions = data.sessions.filter(session => !attendanceWindowError(session, localDateString()));
  const slot = attendanceSlots(availableSessions).find(item => item.id === form.get("slotId"));
  if (!player) { showToast("كود اللاعب غير موجود. راجع الرقم وحاول مرة أخرى."); return; }
  if (!["حاضر", "غائب"].includes(status)) { showToast("اختر حالة حضور أو غياب صحيحة."); return; }
  if (!slot) { showToast("ساعة التدريب المختارة غير متاحة لتسجيل الحضور في الوقت الحالي."); return; }
  if (dayOffExists(slot.id, localDateString())) {
    showToast("تم إعلان إجازة لهذه المجموعة اليوم؛ لا يمكن تسجيل حضور أو غياب.");
    return;
  }
  const session = sessionForPlayerInSlot(player, slot);
  if (!session) { showToast("اللاعب لا ينتمي إلى أي فئة من فئات التمارين المتاحة في هذه الساعة."); return; }
  if (data.attendance.some(record => record.playerId === player.id && slot.sessions.some(item => item.id === record.sessionId) && record.isoDate === localDateString())) {
    showToast(`تم تسجيل حالة ${player.name} لهذه الساعة اليوم بالفعل.`);
    return;
  }
  if (status === "غائب") {
    await registerPlayerAbsenceByCode(player, session);
    return;
  }
  await registerPlayerAttendance(player, session, new Date(), true);
}

async function persistCodeAttendance(player, rollback) {
  if (!saveLocalData()) {
    rollback();
    return false;
  }
  if (cloudProfile) {
    try {
      await cloudWriteQueue;
      const firebase = await window.firebaseReady;
      await firebase.saveAcademyData(JSON.parse(JSON.stringify(data)), cloudProfile);
    } catch (error) {
      rollback();
      saveLocalData();
      console.error("تعذر حفظ تسجيل الحضور بالكود في Firestore.", error);
      showToast(error instanceof Error ? `تعذر تسجيل الحالة سحابيًا: ${error.message}` : "تعذر تسجيل الحالة سحابيًا. سيظل الكود في الحقل.");
      return false;
    }
  }
  const codeInput = byId("action-form").querySelector('input[name="playerCode"]');
  if (codeInput) {
    codeInput.value = "";
    codeInput.focus();
  }
  return true;
}

async function registerPlayerAbsenceByCode(player, session) {
  const now = new Date();
  const isoDate = localDateString(now);
  const windowError = attendanceWindowError(session, isoDate, now);
  if (windowError) { showToast(windowError); return; }
  if (!attendanceTimeIsWithinSession(session, isoDate, now.getTime())) {
    showToast("تسجيل الغياب بالكود متاح خلال وقت الحصة فقط.");
    return;
  }
  if (dayOffExists(attendanceSlotForSession(session)?.id, isoDate)) {
    showToast("تم إعلان إجازة لهذه المجموعة اليوم؛ لا يمكن تسجيل غياب.");
    return;
  }
  const weekday = weekdayForDate(isoDate);
  if (!player.weeklyDays?.includes(weekday) || !sessionDays(session).includes(weekday)) {
    showToast("لا يمكن تسجيل غياب للاعب في يوم غير أيام تدريبه المحددة.");
    return;
  }
  if (!isSubscriptionActiveOn(player, isoDate)) {
    showToast("تسجيل الغياب بالكود يتطلب اشتراكًا ساريًا في تاريخ الحصة.");
    return;
  }
  const timestamp = now.getTime();
  const record = {
    id: crypto.randomUUID(),
    playerId: player.id,
    playerCode: player.playerCode,
    playerName: player.name,
    sessionId: session.id,
    sessionTitle: session.title,
    sessionTime: session.time,
    guardianPhone: player.guardianPhone,
    timestamp,
    markedAt: timestamp,
    isoDate,
    date: egyptianDate.format(now),
    registeredAt: "",
    status: "غائب",
    attendedUnpaid: false,
    unpaidException: false,
    absenceRecordedByCode: true
  };
  const previousAttendanceLogs = [...(player.attendanceLogs || [])];
  if (!Array.isArray(player.attendanceLogs)) player.attendanceLogs = [];
  player.attendanceLogs.push(record.id);
  data.attendance.push(record);
  const saved = await persistCodeAttendance(player, () => {
    data.attendance = data.attendance.filter(item => item.id !== record.id);
    player.attendanceLogs = previousAttendanceLogs;
  });
  if (saved) {
    showToast(`تم تسجيل غياب ${player.name} دون خصم تمرين. يمكنه طلب التعويض من سجل الحضور.`);
  }
}

async function registerPlayerAttendance(player, session, dateTime = new Date(), keepCodeEntryOpen = false) {
  const isoDate = localDateString(dateTime);
  if (dayOffExists(attendanceSlotForSession(session)?.id, isoDate)) {
    showToast("تم إعلان إجازة لهذه المجموعة في التاريخ المحدد؛ لا يمكن تسجيل الحضور.");
    return;
  }
  const windowError = attendanceWindowError(session, isoDate);
  if (windowError) { showToast(windowError); return; }
  if (!attendanceTimeIsWithinSession(session, isoDate, dateTime.getTime())) {
    showToast("وقت الحضور يجب أن يكون بين بداية التسجيل قبل الحصة بنصف ساعة ووقت نهاية الحصة.");
    return;
  }
  if (data.attendance.some(record => record.playerId === player.id && record.sessionId === session.id && record.isoDate === isoDate)) {
    showToast(`تم تسجيل حضور ${player.name} لهذه المجموعة في هذا التاريخ بالفعل.`);
    return;
  }
  const timestamp = dateTime.getTime();
  const weekday = weekdayForDate(isoDate);
  const isScheduled = player.weeklyDays?.includes(weekday) && sessionDays(session).includes(weekday);
  const previousUsed = player.sessionsUsed;
  const previousLeft = player.sessionsLeft;
  const previousSubscription = {
    expectedStartDate: player.expectedStartDate,
    actualStartDate: player.actualStartDate,
    subscriptionStart: player.subscriptionStart,
    subscriptionEnd: player.subscriptionEnd,
    endDate: player.endDate,
    attendanceLogs: [...(player.attendanceLogs || [])]
  };
  const status = !isScheduled ? "معذور" : attendanceStatus(session, isoDate, timestamp, player);
  startSubscriptionFromAttendance(player, isoDate);
  const paid = isPaidMember(player, isoDate);
  const record = {
    id: crypto.randomUUID(), playerId: player.id, playerCode: player.playerCode, playerName: player.name, sessionId: session.id,
    sessionTitle: session.title, sessionTime: session.time, guardianPhone: player.guardianPhone,
    ...(currentUser?.role === "trainer" ? { trainerId: currentUser.id } : {}),
    timestamp, markedAt: Date.now(), isoDate, date: egyptianDate.format(dateTime),
    registeredAt: `${String(dateTime.getHours()).padStart(2, "0")}:${String(dateTime.getMinutes()).padStart(2, "0")}`,
    status, attendedUnpaid: !paid, unpaidException: !paid && status !== "غائب"
  };
  if (paid) consumeTraining(player);
  if (!Array.isArray(player.attendanceLogs)) player.attendanceLogs = [];
  player.attendanceLogs.push(record.id);
  data.attendance.push(record);
  if (keepCodeEntryOpen) {
    const saved = await persistCodeAttendance(player, () => {
      data.attendance = data.attendance.filter(item => item.id !== record.id);
      player.sessionsUsed = previousUsed;
      player.sessionsLeft = previousLeft;
      Object.assign(player, previousSubscription);
    });
    if (saved) {
      showToast(record.unpaidException
        ? `تم تسجيل استثناء حضور ${player.name} دون دفع. سيُخصم التمرين من الاشتراك عند تجديده بعد سداد كامل المبلغ.`
        : `تم تسجيل ${status} للاعب ${player.name}.`);
    }
    return;
  }
  if (saveData()) {
    closeModal();
    renderView();
    showToast(record.unpaidException
      ? `تم تسجيل استثناء حضور ${player.name} دون دفع. سيُخصم التمرين من الاشتراك عند تجديده بعد سداد كامل المبلغ.`
      : `تم تسجيل ${status} للاعب ${player.name}.`);
  } else {
    data.attendance.pop();
    player.sessionsUsed = previousUsed;
    player.sessionsLeft = previousLeft;
    Object.assign(player, previousSubscription);
  }
}

function openAttendanceRoster(sessionId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل حضور اللاعبين من صلاحية المشرف فقط."); return; }
  const selectedSession = data.sessions.find(item => item.id === sessionId);
  const slot = selectedSession && attendanceSlotForSession(selectedSession);
  if (slot && dayOffExists(slot.id, localDateString())) {
    showToast("تم إعلان إجازة لهذه المجموعة اليوم؛ لا يمكن فتح كشف الحضور.");
    return;
  }
  const session = slot?.sessions.find(item => !attendanceWindowError(item, localDateString())) || slot?.sessions[0];
  if (!session) { showToast("لم يتم العثور على حصة التدريب."); return; }
  const windowError = attendanceWindowError(session, localDateString());
  if (windowError) { showToast(windowError); return; }
  const roster = data.users.filter(user => user.role === "member" && sessionForPlayerInSlot(user, slot));
  if (!roster.length) { showToast("لا يوجد لاعبون مسجلون في هذه الفئة."); return; }
  const today = new Date();
  const timeNow = `${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}`;
  const players = roster.map(user => {
    const isScheduled = user.weeklyDays?.includes(weekdayForDate(localDateString())) && sessionDays(session).includes(weekdayForDate(localDateString()));
    const todayDate = localDateString();
    const startDate = subscriptionStartDate(user);
    const endDate = user.endDate || user.subscriptionEnd;
    const beforeStart = !startDate || todayDate < startDate;
    const afterEnd = Boolean(endDate && todayDate > endDate);
    const outsideSubscription = beforeStart || afterEnd;
    const alreadyRecorded = data.attendance.some(record => record.playerId === user.id && slot.sessions.some(item => item.id === record.sessionId) && record.isoDate === localDateString());
    const playerSession = sessionForPlayerInSlot(user, slot);
    const defaultStatus = outsideSubscription || !isScheduled ? "غير مسجل" : "غائب";
    const absenceOption = isScheduled && !outsideSubscription ? '<option value="غائب">غائب</option>' : "";
    const attendanceNote = beforeStart
      ? "قبل بداية الاشتراك، لا يُحتسب غياب"
      : afterEnd
        ? "خارج مدة الاشتراك، لا يُحتسب غياب"
        : isScheduled ? "يوم التدريب المسجل" : "يوم غير مقرر، حضوره معذور";
    const unregisteredLabel = beforeStart ? "قبل بداية الاشتراك" : afterEnd ? "خارج مدة الاشتراك" : "لم يحضر";
    return `<div class="roster-row"><div><strong>${escapeHtml(user.name)}</strong><small>كود اللاعب: ${escapeHtml(user.playerCode)} · ${escapeHtml(playerSession.title)} · ${attendanceNote}${alreadyRecorded ? " · سبق تسجيله اليوم" : ""}</small></div><select name="status-${escapeHtml(user.id)}" ${alreadyRecorded ? "disabled" : ""}><option value="غير مسجل" ${defaultStatus === "غير مسجل" ? "selected" : ""}>${unregisteredLabel}</option><option value="حاضر">حاضر</option>${absenceOption}</select><label>وقت الحضور<input type="time" name="time-${escapeHtml(user.id)}" value="${timeNow}" ${alreadyRecorded ? "disabled" : ""}></label></div>`;
  }).join("");
  const slotCategories = [...new Set(slot.sessions.flatMap(item => sessionCategories(item)))].join("، ");
  openModal(`كشف حضور الساعة ${sessionTimeRange(session)}`, `<p class="modal-explainer">التمارين في هذه الساعة: ${escapeHtml(slot.sessions.map(item => `${item.title} (${sessionCategoryLabel(item)})`).join("، "))}. الفئات المتاحة: ${escapeHtml(slotCategories)}. لا تسجل الغياب للاعب في يوم غير أيامه؛ حضوره في ذلك اليوم يظهر كمعذور.</p><label>تاريخ الحصة<input name="attendanceDate" type="date" value="${localDateString()}" required></label><input type="hidden" name="slotId" value="${escapeHtml(slot.id)}"><div class="roster-list">${players}</div>`, "حفظ كشف الحضور", form => saveAttendanceRoster(form), "الحضور والغياب");
}

function saveAttendanceRoster(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الحضور متاح للمشرف فقط."); return; }
  const slot = attendanceSlots(data.sessions).find(item => item.id === form.get("slotId"));
  const isoDate = String(form.get("attendanceDate"));
  if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || Number.isNaN(new Date(`${isoDate}T12:00:00`).getTime())) { showToast("تحقق من ساعة التدريب وتاريخ كشف الحضور."); return; }
  if (dayOffExists(slot.id, isoDate)) {
    showToast("تم إعلان إجازة لهذه المجموعة في التاريخ المحدد؛ لا يمكن تسجيل حضور أو غياب.");
    return;
  }
  const session = slot.sessions.find(item => !attendanceWindowError(item, isoDate));
  if (!session) { showToast(attendanceWindowError(slot.sessions[0], isoDate)); return; }
  const roster = data.users.filter(user => user.role === "member" && sessionForPlayerInSlot(user, slot, isoDate));
  for (const user of roster) {
    const selected = String(form.get(`status-${user.id}`));
    if (!["حاضر", "متأخر", "غائب"].includes(selected) || selected === "غائب") continue;
    const timeText = String(form.get(`time-${user.id}`) || "");
    const timestamp = new Date(`${isoDate}T${timeText}:00`).getTime();
    if (!/^\d{2}:\d{2}$/.test(timeText) || !Number.isFinite(timestamp) || !slot.sessions.some(item => attendanceTimeIsWithinSession(item, isoDate, timestamp))) {
      showToast(`وقت حضور ${user.name} خارج وقت الحصة أو لاحق للوقت الحالي.`);
      return;
    }
  }
  const addedRecords = [];
  const skipped = [];
  const userAdjustments = [];
  roster.forEach(user => {
    const selected = String(form.get(`status-${user.id}`));
    if (!["حاضر", "متأخر", "غائب"].includes(selected)) return;
    if (selected === "غائب" && !isSubscriptionActiveOn(user, isoDate)) return;
    if (data.attendance.some(record => record.playerId === user.id && slot.sessions.some(item => item.id === record.sessionId) && record.isoDate === isoDate)) { skipped.push(user.name); return; }
    const playerSession = sessionForPlayerInSlot(user, slot, isoDate);
    if (!playerSession) return;
    const timeText = String(form.get(`time-${user.id}`) || "");
    const [hours, minutes] = timeText.split(":").map(Number);
    const timestamp = timeText && Number.isInteger(hours) && Number.isInteger(minutes)
      ? new Date(`${isoDate}T${timeText}:00`).getTime()
      : Date.now();
    const weekday = weekdayForDate(isoDate);
    const isScheduled = user.weeklyDays?.includes(weekday) && sessionDays(playerSession).includes(weekday);
    const previousUserState = {
      sessionsUsed: user.sessionsUsed,
      sessionsLeft: user.sessionsLeft,
      expectedStartDate: user.expectedStartDate,
      actualStartDate: user.actualStartDate,
      subscriptionStart: user.subscriptionStart,
      subscriptionEnd: user.subscriptionEnd,
      endDate: user.endDate,
      attendanceLogs: [...(user.attendanceLogs || [])]
    };
    if (selected !== "غائب") startSubscriptionFromAttendance(user, isoDate);
    const status = selected === "غائب" && isScheduled ? "غائب" : !isScheduled ? "معذور" : attendanceStatus(playerSession, isoDate, timestamp, user);
    const paid = status !== "غائب" && isPaidMember(user, isoDate);
    const record = {
      id: crypto.randomUUID(), playerId: user.id, playerCode: user.playerCode, playerName: user.name, sessionId: playerSession.id,
      sessionTitle: playerSession.title, sessionTime: playerSession.time, guardianPhone: user.guardianPhone,
      ...(currentUser?.role === "trainer" ? { trainerId: currentUser.id } : {}),
      timestamp, markedAt: Date.now(), isoDate, date: egyptianDate.format(new Date(`${isoDate}T12:00:00`)),
      registeredAt: status === "غائب" ? "" : timeText, status, attendedUnpaid: status !== "غائب" && !paid,
      unpaidException: status !== "غائب" && !paid
    };
    addedRecords.push(record);
    if (!Array.isArray(user.attendanceLogs)) user.attendanceLogs = [];
    user.attendanceLogs.push(record.id);
    userAdjustments.push({ user, ...previousUserState });
    if (paid) {
      consumeTraining(user);
    }
  });
  if (!addedRecords.length) { showToast(skipped.length ? "تم تسجيل كشف هذه الحصة مسبقًا في هذا التاريخ." : "اختر حالة واحدة على الأقل لتسجيلها."); return; }
  data.attendance.push(...addedRecords);
  if (saveData()) {
    closeModal();
    renderView();
    const exceptions = addedRecords.filter(record => record.unpaidException).length;
    showToast(`تم تسجيل ${arabicDigits(addedRecords.length)} حالة، منها ${arabicDigits(exceptions)} استثناء غير مدفوع سيُخصم عند التجديد.`);
  } else {
    data.attendance.splice(-addedRecords.length, addedRecords.length);
    userAdjustments.forEach(item => {
      item.user.sessionsUsed = item.sessionsUsed;
      item.user.sessionsLeft = item.sessionsLeft;
      item.user.expectedStartDate = item.expectedStartDate;
      item.user.actualStartDate = item.actualStartDate;
      item.user.subscriptionStart = item.subscriptionStart;
      item.user.subscriptionEnd = item.subscriptionEnd;
      item.user.endDate = item.endDate;
      item.user.attendanceLogs = item.attendanceLogs;
    });
  }
}

function reportDateTime(value, fallbackDate = "", fallbackTime = "") {
  let date = value?.toDate ? value.toDate() : value instanceof Date ? value : value ? new Date(value) : new Date(Number.NaN);
  if ((!Number.isFinite(date.getTime()) || date.getTime() === 0) && fallbackDate) date = new Date(`${fallbackDate}T${fallbackTime || "12:00"}:00`);
  if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return "غير مسجل";
  return date.toLocaleString("ar-EG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function reportDateOnly(value) {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? egyptianDate.format(date) : "غير مسجل";
}

function reportTimestampValue(value) {
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : new Date(value || 0).getTime();
}

function guardianReportSearchResults() {
  const query = normalizeDigits(guardianReportSearch.trim()).toLocaleLowerCase("ar");
  if (!query) return '<p class="guardian-report-empty">اكتب اسم ولي الأمر أو بريده الإلكتروني أو رقم هاتفه لبدء البحث.</p>';
  const digitsQuery = query.replace(/\D/g, "");
  const guardians = data.users.filter(user => user.role === "guardian" && (
    !query
    || `${user.name || ""} ${user.email || ""} ${user.guardianPhone || ""} ${user.whatsappPhone || ""}`
      .toLocaleLowerCase("ar").includes(query)
    || (digitsQuery && normalizeDigits(`${user.guardianPhone || ""} ${user.whatsappPhone || ""}`).replace(/\D/g, "").includes(digitsQuery))
  ));
  if (!guardians.length) return '<p class="guardian-report-empty">لا توجد نتائج مطابقة. ابحث بالاسم أو البريد الإلكتروني أو رقم الهاتف.</p>';
  return guardians.map(guardian => `<button type="button" class="guardian-report-result ${selectedReportGuardianId === guardian.id ? "selected" : ""}" data-action="select-guardian-report" data-guardian="${escapeHtml(guardian.id)}"><strong>${escapeHtml(guardian.name || "ولي أمر")}</strong><span>${escapeHtml(guardian.email || "بلا بريد إلكتروني")}</span><small>${escapeHtml(guardian.guardianPhone || guardian.whatsappPhone || "بلا رقم هاتف")} · ${arabicDigits(childrenForGuardian(guardian.id).length)} لاعب</small></button>`).join("");
}

function guardianReportDetails() {
  if (guardianReportLoading) return '<section class="panel guardian-report-placeholder" role="status">جارٍ تحميل تقرير ولي الأمر وسجلات اللاعبين...</section>';
  if (guardianReportError) return `<section class="panel guardian-report-placeholder" role="alert">${escapeHtml(guardianReportError)}</section>`;
  if (!guardianReport) return '<section class="panel guardian-report-placeholder">ابحث عن ولي الأمر ثم اختره لعرض التقرير الشامل.</section>';

  const { guardian, players, attendance, payments } = guardianReport;
  const registrationDate = reportDateTime(guardian.createdAt || guardian.joinedAt);
  const playerReports = players.length ? players.map(player => {
    const records = attendance.filter(record => record.playerId === player.id).sort((left, right) => {
      return reportTimestampValue(right.timestamp || right.markedAt) - reportTimestampValue(left.timestamp || left.markedAt);
    });
    const playerPayments = payments.filter(payment => payment.playerId === player.id).sort((left, right) =>
      reportTimestampValue(right.confirmedAt || right.createdAt) - reportTimestampValue(left.confirmedAt || left.createdAt)
    );
    const hasPartialPayment = playerPayments.some(payment => payment.status === "دفع جزئي نقدًا");
    const state = hasPartialPayment ? { label: "دفع جزئي", className: "status-soon" } : subscriptionState(player);
    const subscriptionStart = player.actualStartDate || player.subscriptionStart || player.expectedStartDate;
    const subscriptionEnd = player.endDate || player.subscriptionEnd;
    const attendanceHistory = records.length
      ? `<ol class="guardian-report-timeline">${records.map(record => `<li><time>${escapeHtml(reportDateTime(record.timestamp || record.markedAt, record.isoDate, record.registeredAt))}</time><strong>${escapeHtml(record.sessionTitle || "تدريب الأكاديمية")}</strong><span>${escapeHtml(record.status || "حاضر")}${record.registeredAt ? ` · وقت الحضور ${escapeHtml(record.registeredAt)}` : ""}</span></li>`).join("")}</ol>`
      : '<p class="guardian-report-muted">لا توجد سجلات حضور لهذا اللاعب.</p>';
    const paymentHistory = playerPayments.length
      ? `<ol class="guardian-report-timeline">${playerPayments.map(payment => `<li><time>${escapeHtml(reportDateTime(payment.confirmedAt || payment.createdAt, payment.date, payment.paidTime))}</time><strong>${escapeHtml(paymentMethodLabel(payment))} · ${arabicDigits(Number(payment.amount) || 0)} ج.م</strong><span>${escapeHtml(payment.status || "حالة غير محددة")}${payment.reference ? ` · مرجع ${escapeHtml(payment.reference)}` : ""}</span></li>`).join("")}</ol>`
      : '<p class="guardian-report-muted">لا توجد دفعات مسجلة لهذا اللاعب.</p>';
    return `<article class="guardian-report-player"><header class="guardian-report-player-heading"><div><p class="eyebrow">ملف اللاعب</p><h3>${escapeHtml(player.name || "لاعب")}</h3></div><div class="guardian-report-code"><span>كود الحضور</span><strong>${escapeHtml(player.playerCode || "—")}</strong></div></header><div class="guardian-report-facts"><div><span>أيام التدريب</span><strong>${escapeHtml((player.weeklyDays || []).join("، ") || "غير محددة")}</strong></div><div><span>حالة الاشتراك</span><strong><span class="subscription-badge ${state.className}">${escapeHtml(state.label)}</span></strong></div><div><span>بداية الاشتراك</span><strong>${escapeHtml(subscriptionStart ? reportDateOnly(subscriptionStart) : "غير مسجل")}</strong></div><div><span>انتهاء الاشتراك</span><strong>${escapeHtml(subscriptionEnd ? reportDateOnly(subscriptionEnd) : "غير مفعل")}</strong></div><div><span>التدريبات المتبقية</span><strong>${arabicDigits(Number(player.sessionsLeft) || 0)}</strong></div></div><div class="guardian-report-history-grid"><section><h4>سجل الحضور</h4>${attendanceHistory}</section><section><h4>سجل المدفوعات</h4>${paymentHistory}</section></div></article>`;
  }).join("") : '<div class="guardian-report-placeholder">لا يوجد لاعبون مرتبطون بحساب ولي الأمر.</div>';
  return `<section class="panel guardian-report-profile"><header class="guardian-report-profile-heading"><div><p class="eyebrow">بيانات ولي الأمر</p><h2>${escapeHtml(guardian.name || "ولي أمر")}</h2></div><span class="guardian-report-registration">تاريخ التسجيل على المنصة<strong>${escapeHtml(registrationDate)}</strong></span></header><div class="guardian-report-guardian-facts"><div><span>البريد الإلكتروني</span><strong>${escapeHtml(guardian.email || "—")}</strong></div><div><span>الهاتف</span><strong>${escapeHtml(guardian.guardianPhone || "—")}</strong></div><div><span>واتساب</span><strong>${escapeHtml(guardian.whatsappPhone || "—")}</strong></div><div><span>عدد اللاعبين</span><strong>${arabicDigits(players.length)}</strong></div></div></section><section class="guardian-report-player-list"><h2>الأبناء وسجلاتهم</h2>${playerReports}</section>`;
}

function coachGuardianReportView() {
  if (currentUser?.role !== "coach") return "";
  return `<section class="page-intro"><div><p class="eyebrow">متابعة شاملة لحسابات الأسر</p><h1>لوحة تحكم المشرف - تقرير ولي الأمر الشامل</h1><p class="welcome-subtitle">ابحث عن ولي الأمر لعرض بياناته وأطفاله وسجل الحضور والمدفوعات والاشتراكات بترتيب زمني.</p></div></section><section class="panel guardian-report-search-panel"><label for="guardian-report-search">البحث عن ولي الأمر</label><input id="guardian-report-search" type="search" autocomplete="off" value="${escapeHtml(guardianReportSearch)}" placeholder="الاسم أو البريد الإلكتروني أو رقم الهاتف"><div id="guardian-report-results" class="guardian-report-results" aria-live="polite">${guardianReportSearchResults()}</div></section><div id="guardian-report-details">${guardianReportDetails()}</div>`;
}

function coachPlayersView() {
  const users = data.users.filter(user => user.role === "member");
  users.filter(user => user.legacyAttendanceAuto).forEach(user => {
    const balance = playerTrainingBalance(user);
    user.sessionsUsed = balance.used;
    user.sessionsLeft = balance.remaining;
  });
  const guardians = data.users.filter(user => user.role === "guardian");
  const guardianRows = guardians.map(guardian => {
    const children = childrenForGuardian(guardian.id);
    return `<tr data-coach-search-row data-search-parent="${escapeHtml(guardian.name)}"><td>${escapeHtml(guardian.name)}</td><td>${escapeHtml(guardian.guardianPhone || "—")}<br>${escapeHtml(guardian.whatsappPhone || "—")}</td><td>${escapeHtml(guardian.email || "—")}</td><td>${children.map(child => `${escapeHtml(child.name)} · ${escapeHtml(child.birthDate || "—")} · كود ${escapeHtml(child.playerCode)}`).join("<br>") || "لا يوجد لاعبون"}</td><td><button class="small-action danger-action" data-action="delete-guardian" data-guardian="${escapeHtml(guardian.id)}">حذف ولي الأمر وأبنائه</button></td></tr>`;
  }).join("");
  const playerRows = users.map(user => {
    const state = subscriptionState(user);
    const expiredMessage = `تنبيه من الأكاديمية: انتهى اشتراك اللاعب ${user.name}. يرجى التواصل معنا لتجديده.`;
    const playerPayments = data.payments.filter(payment => payment.playerId === user.id);
    const paidPayments = playerPayments.filter(isRecordedPayment);
    const totalPaid = paidPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0);
    const latestPayment = [...paidPayments].sort((a, b) => (b.confirmedAt || b.createdAt) - (a.confirmedAt || a.createdAt))[0];
    const guardian = data.users.find(parent => parent.id === user.guardianId);
    const playerSessions = sessionsForMember(user);
    const sessions = playerSessions.filter(session => sessionMatchesMemberDays(session, user));
    const unpaidSessions = playerSessions.filter(session => !sessionMatchesMemberDays(session, user));
    const schedules = [...sessions, ...unpaidSessions].map(session => `${escapeHtml(session.title)}: ${escapeHtml(sessionDays(session).join("، "))} ${escapeHtml(session.time)}${sessionMatchesMemberDays(session, user) ? "" : " (موعد متاح لفئتك)"}`).join("<br>");
    const cashPartial = playerPayments.filter(payment => payment.status === "دفع جزئي نقدًا").reduce((total, payment) => total + Number(payment.amount || 0), 0);
    const partialDuration = cashPartialDuration(user);
    const cashRemaining = Math.max(0,
      subscriptionPrice(user.weeklyDays?.length || user.weeklyDaysCount, partialDuration) - cashPartial
    );
    const cashDebt = Math.max(0, Number(user.cashDebt || 0));
    const walletBalance = memberWalletBalance(user);
    const nextCategory = pendingPlayerCategory(user);
    const legacyUsage = user.subscriptionOverride
      ? `<small class="table-subtext">تمارين قبل المنصة: ${arabicDigits(user.subscriptionOverride.attendedBeforePlatform || 0)}</small>`
      : "";
    return `<tr data-coach-search-row data-search-code="${escapeHtml(user.playerCode || "")}" data-search-parent="${escapeHtml(guardian?.name || user.guardian || "")}"><td class="player-code">${escapeHtml(user.playerCode)}</td><td>${escapeHtml(user.name)}<small class="table-subtext">${escapeHtml(guardian?.name || user.guardian || "")}</small></td><td>${escapeHtml(user.birthDate || "—")}<br>${escapeHtml(genderLabel(user.gender))}<br>${escapeHtml(user.category)}${nextCategory ? `<small class="table-subtext">الفئة التالية: ${escapeHtml(nextCategory)}</small>` : ""}</td><td>${escapeHtml((user.weeklyDays || []).join("، ") || "لم يختر")}<br>${schedules || "لا توجد مجموعة مرشحة"}</td><td>${arabicDigits(totalPaid)} ج.م${walletBalance ? `<small class="table-subtext">رصيد دائن بالمحفظة: ${arabicDigits(walletBalance)} ج.م</small>` : ""}${cashPartial ? `<small class="table-subtext">دفع نقدًا ${arabicDigits(cashPartial)} ج.م · المتبقي ${arabicDigits(cashRemaining)} ج.م لإكمال الاشتراك</small>` : ""}${cashDebt ? `<small class="table-subtext">رصيد متبقٍ مستحق: ${arabicDigits(cashDebt)} ج.م</small>` : ""}</td><td>${latestPayment ? `${escapeHtml(paymentMethodLabel(latestPayment))} · ${escapeHtml(latestPayment.date || "—")} · ${escapeHtml(latestPayment.paidTime || "—")}` : "لا توجد دفعات مؤكدة"}</td><td>${user.subscriptionEnd ? egyptianDate.format(new Date(`${user.subscriptionEnd}T12:00:00`)) : "غير مفعّل"}<br><span class="subscription-badge ${state.className}">${state.label}</span><br>متبقي ${arabicDigits(user.sessionsLeft || 0)} تمرين${legacyUsage}</td><td>${nextCategory ? `<button class="small-action" data-action="approve-player-category" data-player="${escapeHtml(user.id)}">اعتماد ${escapeHtml(nextCategory)}</button>` : ""}<button class="small-action" data-action="subscription-override" data-player="${escapeHtml(user.id)}">تعديل إداري للاشتراك</button><button class="small-action" data-action="cash-payment" data-player="${escapeHtml(user.id)}" ${canRequestPayment(user) ? "" : "disabled"}>تسجيل دفع نقدي</button>${cashDebt ? `<button class="small-action" data-action="cash-debt-payment" data-player="${escapeHtml(user.id)}">تحصيل الرصيد المستحق</button>` : ""}${state.label === "منتهي" ? guardianWhatsApp(user, expiredMessage, "إشعار انتهاء الاشتراك") : ""}</td></tr>`;
  }).join("");
  return `<section class="page-intro coach-players-intro"><div><p class="eyebrow">متابعة الحسابات والاشتراكات</p><h1>أولياء الأمور واللاعبون</h1><p class="welcome-subtitle">تظهر بيانات اللاعب ونوعه وتاريخ ميلاده وفئته ومواعيده. تغيّر الفئة عند بلوغ الحد ينتظر موافقة المشرف.</p></div><label class="coach-player-search"><span aria-hidden="true">⌕</span><input id="coach-player-search" type="search" autocomplete="off" placeholder="ابحث باسم ولي الأمر أو كود اللاعب" aria-label="ابحث باسم ولي الأمر أو كود اللاعب"></label></section><section class="panel"><div class="panel-heading"><div><h2>حسابات أولياء الأمور</h2><p>${arabicDigits(guardians.length)} ولي أمر · الحذف يزيل ولي الأمر وأطفاله فقط، وتبقى السجلات المالية محفوظة.</p></div></div>${guardians.length ? `<div class="table-wrap"><table><thead><tr><th>ولي الأمر</th><th>الهاتف / واتساب</th><th>البريد الإلكتروني</th><th>اللاعبون</th><th>إجراء الحساب</th></tr></thead><tbody>${guardianRows}<tr data-search-empty hidden><td colspan="5">لا توجد نتائج مطابقة.</td></tr></tbody></table></div>` : '<div class="empty-state"><p>لا توجد حسابات أولياء أمور بعد.</p></div>'}</section><section class="panel"><div class="panel-heading"><div><h2>سجل اللاعبين والاشتراكات</h2><p>كل الدفعات تبقى مسجلة ولا يمكن حذفها من سجل الدفع.</p></div></div>${users.length ? `<div class="table-wrap"><table><thead><tr><th>كود اللاعب</th><th>اللاعب / ولي الأمر</th><th>النوع وتاريخ الميلاد والفئة</th><th>أيام التدريب والمواعيد</th><th>إجمالي ما دفع</th><th>آخر دفعة: الطريقة والتاريخ والوقت</th><th>الانتهاء والحالة</th><th>إجراء</th></tr></thead><tbody>${playerRows}<tr data-search-empty hidden><td colspan="8">لا توجد نتائج مطابقة.</td></tr></tbody></table></div>` : '<div class="empty-state"><p>لا يوجد لاعبون مسجلون بعد.</p></div>'}</section>${coachAdministrativeAbsencesView()}`;
}

function playerAgeInYears(player) {
  if (!isValidIsoDate(player?.birthDate) || player.birthDate > localDateString()) return null;
  const birth = new Date(`${player.birthDate}T12:00:00`);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth()
    || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age -= 1;
  return age;
}

function legacyDateFields(prefix, initialDate = "", optional = false) {
  const now = new Date();
  const initialParts = isValidIsoDate(initialDate) ? initialDate.split("-").map(Number) : [];
  const initialYear = initialParts[0] || (optional ? 0 : now.getFullYear());
  const initialMonth = initialParts[1] || (optional ? 0 : now.getMonth() + 1);
  const initialDay = initialParts[2] || "";
  const monthOptions = Array.from({ length: 12 }, (_, index) => {
    const value = index + 1;
    const label = new Intl.DateTimeFormat("ar-EG", { month: "long" }).format(new Date(2024, index, 1));
    return `<option value="${value}" ${value === initialMonth ? "selected" : ""}>${label}</option>`;
  }).join("");
  const yearOptions = Array.from({ length: Math.max(1, now.getFullYear() + 2 - 1969) }, (_, index) => now.getFullYear() + 2 - index)
    .map(year => `<option value="${year}" ${year === initialYear ? "selected" : ""}>${arabicDigits(year)}</option>`)
    .join("");
  const optionalOptions = optional ? `<option value="" ${initialParts.length ? "" : "selected"}>بدون تغيير</option>` : "";
  return `<div class="form-row"><label>اليوم — إدخال يدوي<input name="${prefix}Day" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{1,2}" maxlength="2" ${optional ? "" : "required"} value="${initialDay}" placeholder="اليوم"></label><label>الشهر<select name="${prefix}Month" ${optional ? "" : "required"}>${optionalOptions}${monthOptions}</select></label><label>السنة<select name="${prefix}Year" ${optional ? "" : "required"}>${optionalOptions}${yearOptions}</select></label></div>`;
}

function legacyDateFromForm(form, prefix, optional = false) {
  const dayText = normalizeDigits(String(form.get(`${prefix}Day`) || "").trim());
  const monthText = String(form.get(`${prefix}Month`) || "");
  const yearText = String(form.get(`${prefix}Year`) || "");
  if (optional && !dayText && !monthText && !yearText) return "";
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!/^\d{1,2}$/.test(dayText) || !Number.isInteger(day) || !Number.isInteger(month)
    || !Number.isInteger(year) || !isValidIsoDate(isoDate)) return null;
  return isoDate;
}

function coachLegacyPlayersView() {
  if (currentUser?.role !== "coach") return "";
  const query = normalizeDigits(legacyPlayerSearch.trim()).toLocaleLowerCase("ar");
  const players = data.users.filter(player => player.role === "member")
    .sort((left, right) => {
      if (left.birthDate && right.birthDate && left.birthDate !== right.birthDate) return right.birthDate.localeCompare(left.birthDate);
      if (left.birthDate) return -1;
      if (right.birthDate) return 1;
      return String(left.name || "").localeCompare(String(right.name || ""), "ar");
    });
  const selected = players.find(player => player.id === selectedLegacyPlayerId) || null;
  const roster = players.length
    ? players.map(player => {
      const age = playerAgeInYears(player);
      const selectedClass = player.id === selected?.id ? "selected" : "";
      const name = String(player.name || "").toLocaleLowerCase("ar");
      const code = normalizeDigits(String(player.playerCode || ""));
      const hidden = Boolean(query) && !name.includes(query) && !code.includes(query);
      return `<button type="button" class="legacy-player-result ${selectedClass}" data-action="select-legacy-player" data-player="${escapeHtml(player.id)}" ${hidden ? "hidden" : ""}><span class="legacy-player-age">${age === null ? "—" : `${arabicDigits(age)} سنة`}</span><span><strong>${escapeHtml(player.name || "لاعب")}</strong><small>كود ${escapeHtml(player.playerCode || "—")}</small></span></button>`;
    }).join("")
    : '<div class="empty-state"><p>لا يوجد لاعبون مسجلون بعد.</p></div>';
  const hasSearchMatches = players.some(player => {
    const name = String(player.name || "").toLocaleLowerCase("ar");
    const code = normalizeDigits(String(player.playerCode || ""));
    return !query || name.includes(query) || code.includes(query);
  });
  return `<section class="page-intro"><div><p class="eyebrow">إدخال بيانات الأكاديمية القائمة</p><h1>ملفات اللاعبين الحاليين</h1><p class="welcome-subtitle">اختر اللاعب من القائمة المرتبة من الأصغر عمرًا إلى الأكبر لتسجيل اشتراكه وحضوره وغيابه ومدفوعاته السابقة.</p></div></section><div class="legacy-player-layout"><section class="panel legacy-player-list-panel"><div class="panel-heading"><div><h2>جميع اللاعبين</h2><p>${arabicDigits(players.length)} لاعب · ترتيب تصاعدي حسب العمر</p></div></div><label class="legacy-player-search">بحث بالاسم أو الكود<input id="legacy-player-search" type="search" autocomplete="off" value="${escapeHtml(legacyPlayerSearch)}" placeholder="ابحث عن لاعب"></label><div id="legacy-player-results" class="legacy-player-results">${roster}<p class="legacy-player-no-results" ${(hasSearchMatches || !query) ? "hidden" : ""}>لا توجد نتائج مطابقة.</p></div></section>${selected ? legacyPlayerDetailsView(selected) : '<section class="panel legacy-player-placeholder"><h2>اختر لاعبًا لعرض ملفه</h2><p>يمكنك تسجيل أيام التدريب، الحضور والغياب، الرصيد الحالي، وسجل المدفوعات السابقة.</p></section>'}</div>`;
}

function legacyPlayerDetailsViewManual(player) {
  const age = playerAgeInYears(player);
  const autoAttendance = legacyAutoAttendanceRecords(player).filter(record => record.legacyAuto);
  const attendance = [
    ...data.attendance.filter(record => record.playerId === player.id),
    ...autoAttendance
  ].sort((left, right) => String(right.isoDate || "").localeCompare(String(left.isoDate || "")));
  const payments = data.payments.filter(payment => payment.playerId === player.id)
    .sort((left, right) => Number(right.confirmedAt || right.createdAt || 0) - Number(left.confirmedAt || left.createdAt || 0));
  const presences = attendance.filter(record => ["حاضر", "متأخر"].includes(record.status));
  const absences = attendance.filter(record => record.status === "غائب");
  const firstPracticeDate = player.legacyAttendanceStartDate || presences.map(record => record.isoDate).filter(isValidIsoDate).sort()[0] || null;
  const subscriptionStart = player.subscriptionStart || player.actualStartDate || player.expectedStartDate || firstPracticeDate;
  const subscriptionEnd = player.endDate || player.subscriptionEnd || (subscriptionStart ? addCalendarDays(subscriptionStart, 30) : null);
  const balance = playerTrainingBalance(player);
  const selectedDays = new Set(player.weeklyDays || []);
  const dayChoices = WEEK_DAYS.map(day =>
    `<label class="day-choice"><input type="checkbox" name="legacyWeeklyDays" value="${day}" ${selectedDays.has(day) ? "checked" : ""}><span>${day}</span></label>`
  ).join("");
  const sessions = selectedSessionsForMember(player).length
    ? selectedSessionsForMember(player)
    : data.sessions.filter(session => sessionIncludesMember(session, player));
  const sessionOptions = sessions.map(session =>
    `<option value="${escapeHtml(session.id)}">${escapeHtml(readableSessionTitle(session.title))} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))}</option>`
  ).join("");
  const attendanceRows = attendance.length ? attendance.map(record =>
    `<tr><td>${escapeHtml(record.isoDate || record.date || "—")}</td><td>${escapeHtml(readableSessionTitle(record.sessionTitle || "تدريب"))}</td><td><span class="subscription-badge ${record.status === "غائب" ? "status-expired" : "status-active"}">${escapeHtml(record.status || "حاضر")}</span>${record.legacyAuto ? '<small class="table-subtext">حضور محسوب تلقائيًا</small>' : ""}</td></tr>`
  ).join("") : '<tr><td colspan="3">لا توجد سجلات حضور أو غياب.</td></tr>';
  const paymentRows = payments.length ? payments.map(payment =>
    `<tr><td>${escapeHtml(payment.date || "—")}</td><td>${escapeHtml(payment.methodLabel || paymentMethodLabel(payment))}</td><td>${arabicDigits(Number(payment.amount) || 0)} ج.م</td><td>${escapeHtml(payment.status || "—")}</td></tr>`
  ).join("") : '<tr><td colspan="4">لا توجد دفعات مسجلة.</td></tr>';
  const history = (Array.isArray(player.supervisorChangeHistory) ? player.supervisorChangeHistory : [])
    .slice().sort((left, right) => right.changedAt - left.changedAt);
  const historyRows = history.length ? history.map(entry =>
    `<tr><td>${escapeHtml(legacyChangeTimestamp(entry.changedAt))}</td><td>${escapeHtml(entry.title)}</td><td>${escapeHtml(entry.before)}</td><td>${escapeHtml(entry.after)}</td></tr>`
  ).join("") : '<tr><td colspan="4">لا توجد تعديلات إدارية محفوظة بعد.</td></tr>';
  return `<section class="panel legacy-player-details"><header class="legacy-player-heading"><div><p class="eyebrow">ملف لاعب قائم</p><h2>${escapeHtml(player.name)}</h2><p>كود الحضور: <strong>${escapeHtml(player.playerCode || "—")}</strong> · العمر: ${age === null ? "غير معروف" : `${arabicDigits(age)} سنة`}</p></div></header><div class="member-stats legacy-player-stats"><article class="member-stat"><p>أيام التدريب المحددة</p><strong>${escapeHtml((player.weeklyDays || []).join("، ") || "غير محددة")}</strong></article><article class="member-stat"><p>حاضر / غائب مسجل</p><strong>${arabicDigits(presences.length)} / ${arabicDigits(absences.length)}</strong></article><article class="member-stat"><p>التمارين المتبقية</p><strong>${arabicDigits(Math.max(0, remaining))} تمرين</strong></article><article class="member-stat"><p>الاشتراك من / إلى</p><strong>${subscriptionStart ? escapeHtml(subscriptionStart) : "غير محدد"} – ${subscriptionEnd ? escapeHtml(subscriptionEnd) : "غير محدد"}</strong></article></div><p class="legacy-player-note">سجلات الحضور والغياب التاريخية لا تخصم من الرصيد. إذا لم يُدخل تاريخ البداية، يظهر أول حضور تاريخي كبداية تقديرية؛ ويمكن للمشرف ضبط البداية والانتهاء بدقة من النموذج.</p><form id="legacy-player-days-form" class="panel legacy-player-form"><h3>أيام الاشتراك</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><fieldset class="registration-days"><legend>اختر أيام التدريب الأسبوعية</legend><div class="day-choice-grid">${dayChoices}</div></fieldset><button class="primary-button" type="submit">حفظ أيام التدريب</button></form><form id="legacy-player-balance-form" class="panel legacy-player-form"><h3>الرصيد وتواريخ الاشتراك الحالية</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><label>عدد التمارين المتبقية الآن<input name="remainingSessions" type="number" min="0" max="500" step="1" value="${Math.max(0, remaining)}" required></label><fieldset class="legacy-subscription-date"><legend>تاريخ بداية الاشتراك — اتركه بدون تغيير إذا لم يتغير</legend>${legacyDateFields("legacySubscriptionStart", subscriptionStart || "", true)}</fieldset><fieldset class="legacy-subscription-date"><legend>تاريخ انتهاء الاشتراك — اتركه بدون تغيير إذا لم يتغير</legend>${legacyDateFields("legacySubscriptionEnd", subscriptionEnd || "", true)}</fieldset><button class="primary-button" type="submit">حفظ الرصيد والتواريخ</button></form><form id="legacy-player-attendance-form" class="panel legacy-player-form"><h3>إضافة حضور أو غياب سابق</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><label>حصة التدريب<select name="sessionId" required><option value="">اختر الحصة</option>${sessionOptions}</select></label>${legacyDateFields("legacyAttendance")}<label>الحالة<select name="status" required><option value="حاضر">حاضر</option><option value="غائب">غائب — دون خصم تمرين</option></select></label><button class="primary-button" type="submit">حفظ سجل الحضور / الغياب</button></form><form id="legacy-player-payment-form" class="panel legacy-player-form"><h3>إضافة دفعة سابقة</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><div class="form-row"><label>تاريخ الدفع<input name="paymentDate" type="date" max="${localDateString()}" required></label><label>المبلغ بالجنيه<input name="paymentAmount" type="number" min="1" max="1000000" step="1" required></label></div><label>طريقة الدفع<select name="paymentMethod" required><option value="cash">كاش</option><option value="instapay">إنستا باي</option></select></label><button class="primary-button" type="submit">حفظ الدفعة السابقة</button></form><section class="panel legacy-history-panel"><h3>سجل الحضور والغياب</h3><div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>الحصة</th><th>الحالة</th></tr></thead><tbody>${attendanceRows}</tbody></table></div></section><section class="panel legacy-history-panel"><h3>سجل المدفوعات</h3><div class="table-wrap"><table><thead><tr><th>تاريخ الدفع</th><th>الطريقة</th><th>المبلغ</th><th>الحالة</th></tr></thead><tbody>${paymentRows}</tbody></table></div></section></section>`;
}

function legacyPlayerDetailsView(player) {
  const age = playerAgeInYears(player);
  const balance = playerTrainingBalance(player);
  const attendance = [
    ...data.attendance.filter(record => record.playerId === player.id),
    ...legacyAutoAttendanceRecords(player).filter(record => record.legacyAuto)
  ].sort((left, right) => String(right.isoDate || "").localeCompare(String(left.isoDate || "")));
  const payments = data.payments.filter(payment => payment.playerId === player.id)
    .sort((left, right) => Number(right.confirmedAt || right.createdAt || 0) - Number(left.confirmedAt || left.createdAt || 0));
  const startDate = player.legacyAttendanceStartDate || player.subscriptionStart || player.actualStartDate || "";
  const endDate = legacyProjectedEndDate(player, startDate);
  const selectedDays = new Set(player.weeklyDays || []);
  const dayChoices = WEEK_DAYS.map(day =>
    `<label class="day-choice"><input type="checkbox" name="legacyWeeklyDays" value="${day}" ${selectedDays.has(day) ? "checked" : ""}><span>${day}</span></label>`
  ).join("");
  const sessions = selectedSessionsForMember(player).length
    ? selectedSessionsForMember(player)
    : data.sessions.filter(session => sessionIncludesMember(session, player));
  const sessionOptions = sessions.map(session =>
    `<option value="${escapeHtml(session.id)}">${escapeHtml(readableSessionTitle(session.title))} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))}</option>`
  ).join("");
  const attendanceRows = attendance.length ? attendance.map(record =>
    `<tr><td>${escapeHtml(record.isoDate || record.date || "—")}</td><td>${escapeHtml(readableSessionTitle(record.sessionTitle || "تدريب"))}</td><td><span class="subscription-badge ${record.status === "غائب" ? "status-expired" : "status-active"}">${escapeHtml(record.status || "حاضر")}</span>${record.legacyAuto ? '<small class="table-subtext">حضور محسوب تلقائيًا</small>' : ""}</td></tr>`
  ).join("") : '<tr><td colspan="3">لا توجد سجلات حضور أو غياب.</td></tr>';
  const paymentRows = payments.length ? payments.map(payment =>
    `<tr><td>${escapeHtml(payment.date || "—")}</td><td>${escapeHtml(payment.methodLabel || paymentMethodLabel(payment))}</td><td>${arabicDigits(Number(payment.amount) || 0)} ج.م</td><td>${escapeHtml(payment.status || "—")}</td></tr>`
  ).join("") : '<tr><td colspan="4">لا توجد دفعات مسجلة.</td></tr>';
  const history = (Array.isArray(player.supervisorChangeHistory) ? player.supervisorChangeHistory : [])
    .slice().sort((left, right) => right.changedAt - left.changedAt);
  const historyRows = history.length ? history.map(entry =>
    `<tr><td>${escapeHtml(legacyChangeTimestamp(entry.changedAt))}</td><td>${escapeHtml(entry.title)}</td><td>${escapeHtml(entry.before)}</td><td>${escapeHtml(entry.after)}</td></tr>`
  ).join("") : '<tr><td colspan="4">لا توجد تعديلات إدارية محفوظة بعد.</td></tr>';
  return `<section class="panel legacy-player-details">
    <header class="legacy-player-heading"><div><p class="eyebrow">ملف لاعب قائم</p><h2>${escapeHtml(player.name)}</h2><p>كود الحضور: <strong>${escapeHtml(player.playerCode || "—")}</strong> · العمر: ${age === null ? "غير معروف" : `${arabicDigits(age)} سنة`}</p></div></header>
    <div class="member-stats legacy-player-stats">
      <article class="member-stat"><p>أيام التدريب المحددة</p><strong>${escapeHtml((player.weeklyDays || []).join("، ") || "غير محددة")}</strong></article>
      <article class="member-stat"><p>حضور محسوب / غياب</p><strong>${arabicDigits(balance.used)} / ${arabicDigits(attendance.filter(record => record.status === "غائب").length)}</strong></article>
      <article class="member-stat"><p>التمارين المتبقية</p><strong>${arabicDigits(balance.remaining)} من ${arabicDigits(balance.allowance)}</strong></article>
      <article class="member-stat"><p>الاشتراك من / إلى</p><strong>${startDate ? escapeHtml(startDate) : "غير محدد"} – ${endDate ? escapeHtml(endDate) : "غير محدد"}</strong></article>
    </div>
    <p class="legacy-player-note">من تاريخ أول تمرين، تُحتسب الحصص المجدولة المنتهية كحضور تلقائيًا ما لم يسجل المشرف غياب اللاعب بتاريخ الحصة. لا تُخصم حصة الغياب من الرصيد، ويظهر كل تعديل لولي الأمر.</p>
    <form id="legacy-player-days-form" class="panel legacy-player-form"><h3>أيام الاشتراك</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><fieldset class="registration-days"><legend>اختر أيام التدريب الأسبوعية</legend><div class="day-choice-grid">${dayChoices}</div></fieldset><button class="primary-button" type="submit">حفظ أيام التدريب</button></form>
    <form id="legacy-player-balance-form" class="panel legacy-player-form"><h3>أول تمرين ومدة الاشتراك</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><fieldset class="legacy-subscription-date"><legend>تاريخ أول تمرين</legend>${legacyDateFields("legacySubscriptionStart", startDate, false)}</fieldset><label>تاريخ انتهاء الاشتراك — يُحسب تلقائيًا<input id="legacy-projected-end-date" type="date" value="${escapeHtml(endDate)}" readonly></label><p class="form-note">يُحسب تاريخ الانتهاء من أول تمرين وأيام التدريب وعدد تمارين الباقة. يتم تمديده عند تسجيل غياب، ولا يخصم الغياب من الرصيد.</p><p class="form-note">الرصيد يُحسب تلقائيًا: ${arabicDigits(balance.allowance)} تمارين في الباقة − ${arabicDigits(balance.used)} حضور محسوب = ${arabicDigits(balance.remaining)} متبقي.</p><button class="primary-button" type="submit">حفظ البداية والتواريخ</button></form>
    <form id="legacy-player-attendance-form" class="panel legacy-player-form"><h3>تسجيل حضور أو غياب بتاريخ محدد</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><label>حصة التدريب<select name="sessionId" required><option value="">اختر الحصة</option>${sessionOptions}</select></label>${legacyDateFields("legacyAttendance")}<label>الحالة<select name="status" required><option value="حاضر">حاضر</option><option value="غائب">غائب — لا يخصم من الرصيد</option></select></label><button class="primary-button" type="submit">حفظ السجل</button></form>
    <form id="legacy-player-payment-form" class="panel legacy-player-form"><h3>إضافة دفعة سابقة</h3><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><div class="form-row"><label>تاريخ الدفع<input name="paymentDate" type="date" max="${localDateString()}" required></label><label>المبلغ بالجنيه<input name="paymentAmount" type="number" min="1" max="1000000" step="1" required></label></div><label>طريقة الدفع<select name="paymentMethod" required><option value="cash">كاش</option><option value="instapay">إنستا باي</option></select></label><button class="primary-button" type="submit">حفظ الدفعة السابقة</button></form>
    <section class="panel legacy-history-panel"><h3>سجل الحضور والغياب</h3><div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>الحصة</th><th>الحالة</th></tr></thead><tbody>${attendanceRows}</tbody></table></div></section>
    <section class="panel legacy-history-panel"><h3>سجل المدفوعات</h3><div class="table-wrap"><table><thead><tr><th>تاريخ الدفع</th><th>الطريقة</th><th>المبلغ</th><th>الحالة</th></tr></thead><tbody>${paymentRows}</tbody></table></div></section>
    <section class="panel legacy-history-panel"><h3>تعديلات المشرف</h3><div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>التعديل</th><th>قبل</th><th>بعد</th></tr></thead><tbody>${historyRows}</tbody></table></div></section>
  </section>`;
}

function legacyPlayerSnapshot() {
  return JSON.parse(JSON.stringify(data));
}

async function persistLegacyPlayerChanges(previousData, successMessage) {
  if (currentUser?.role !== "coach" || cloudProfile?.role !== "coach") {
    data = previousData;
    showToast("حفظ ملفات اللاعبين الحاليين متاح للمشرف المتصل بقاعدة البيانات فقط.");
    return false;
  }
  if (!saveLocalData()) {
    data = previousData;
    return false;
  }
  try {
    await cloudWriteQueue;
    const firebase = await window.firebaseReady;
    await firebase.saveAcademyData(JSON.parse(JSON.stringify(data)), cloudProfile);
    renderView();
    showToast(successMessage);
    return true;
  } catch (error) {
    data = previousData;
    saveLocalData();
    console.error("تعذر حفظ بيانات اللاعب القائم في Firestore.", error);
    if (error?.code === "permission-denied") {
      showToast("رفضت قواعد Firestore الحفظ. انشر تحديث firestore.rules إلى مشروع Firebase المستخدم ثم أعد المحاولة.");
    } else {
      showToast(error instanceof Error ? `تعذر الحفظ: ${error.message}` : "تعذر حفظ بيانات اللاعب.");
    }
    return false;
  }
}

function updateLegacyProjectedEndDate(form) {
  const preview = form.querySelector("#legacy-projected-end-date");
  const playerId = new FormData(form).get("playerId");
  const player = data.users.find(item => item.id === playerId && item.role === "member");
  if (!preview || !player) return;
  const startDate = legacyDateFromForm(new FormData(form), "legacySubscriptionStart");
  preview.value = startDate ? legacyProjectedEndDate(player, startDate) : "";
}

async function saveLegacyPlayerDays(form) {
  const player = data.users.find(item => item.id === form.get("playerId") && item.role === "member");
  if (currentUser?.role !== "coach" || !player) { showToast("اللاعب أو صلاحية المشرف غير متاحة."); return; }
  const days = [...new Set(form.getAll("legacyWeeklyDays").map(String))]
    .filter(day => WEEK_DAYS.includes(day) && data.workDays.includes(day));
  if (!days.length) { showToast("اختر يوم تدريب واحدًا على الأقل من أيام عمل الأكاديمية."); return; }
  const matchingSessions = data.sessions.filter(session =>
    sessionIncludesMember(session, player) && sessionDays(session).some(day => days.includes(day))
  );
  if (!matchingSessions.length) { showToast("لا توجد حصة مناسبة لأيام التدريب المحددة لهذا اللاعب."); return; }
  const previous = legacyPlayerSnapshot();
  const previousDays = (player.weeklyDays || []).join("، ") || "غير محددة";
  player.weeklyDays = days;
  player.weeklyDaysCount = days.length;
  player.plan = days.length;
  player.selectedSessionIds = [...new Set([
    ...(player.selectedSessionIds || []).filter(id => matchingSessions.some(session => session.id === id)),
    ...matchingSessions.filter(session => sessionDays(session).some(day => days.includes(day))).map(session => session.id)
  ])];
  const startDate = player.legacyAttendanceStartDate || player.subscriptionStart || player.actualStartDate;
  if (player.legacyAttendanceAuto && startDate && days.includes(weekdayForDate(startDate))) {
    const projectedEnd = legacyProjectedEndDate(player, startDate, days);
    if (projectedEnd) {
      const previousEnd = player.endDate || player.subscriptionEnd || "غير محدد";
      player.endDate = projectedEnd;
      player.subscriptionEnd = projectedEnd;
      appendLegacyPlayerChange(player, "إعادة حساب تاريخ انتهاء الاشتراك", previousEnd, projectedEnd);
    }
  }
  const balance = playerTrainingBalance(player);
  player.sessionsUsed = balance.used;
  player.sessionsLeft = balance.remaining;
  appendLegacyPlayerChange(player, "تعديل أيام التدريب", previousDays, days.join("، "));
  await persistLegacyPlayerChanges(previous, `تم تحديث أيام تدريب ${player.name}.`);
}

async function saveLegacyPlayerBalance(form) {
  const player = data.users.find(item => item.id === form.get("playerId") && item.role === "member");
  const startDate = legacyDateFromForm(form, "legacySubscriptionStart");
  if (currentUser?.role !== "coach" || !player || !startDate) {
    showToast("أدخل تاريخ أول تمرين صحيحًا.");
    return;
  }
  if (startDate > localDateString()) {
    showToast("تاريخ أول تمرين لا يكون في المستقبل.");
    return;
  }
  if (!player.weeklyDays.includes(weekdayForDate(startDate))) {
    showToast("يجب أن يوافق تاريخ أول تمرين أحد أيام التدريب المحددة للاعب.");
    return;
  }
  if (!player.weeklyDays?.length || !selectedSessionsForMember(player).length) {
    showToast("احفظ أيام التدريب والحصص المناسبة للاعب أولًا.");
    return;
  }
  const endDate = legacyProjectedEndDate(player, startDate);
  if (!endDate) {
    showToast("تعذر حساب الانتهاء. تحقق من أيام التدريب والحصص المختارة.");
    return;
  }
  const previous = legacyPlayerSnapshot();
  const previousStart = player.legacyAttendanceStartDate || player.subscriptionStart || player.actualStartDate || "غير محدد";
  const previousEnd = player.endDate || player.subscriptionEnd || "غير محدد";
  const previousBalance = playerTrainingBalance(player);
  player.subscriptionStart = startDate;
  player.actualStartDate = startDate;
  player.expectedStartDate = startDate;
  player.legacyAttendanceStartDate = startDate;
  player.legacyAttendanceAuto = true;
  player.endDate = endDate;
  player.subscriptionEnd = endDate;
  const balance = playerTrainingBalance(player);
  player.sessionsUsed = balance.used;
  player.sessionsLeft = balance.remaining;
  appendLegacyPlayerChange(player, "تعديل تاريخ بداية الاشتراك", previousStart, startDate);
  appendLegacyPlayerChange(player, "تعديل تاريخ انتهاء الاشتراك", previousEnd, endDate);
  appendLegacyPlayerChange(
    player,
    "إعادة احتساب الحضور والرصيد",
    `${previousBalance.used} حاضر · ${previousBalance.remaining} متبقي`,
    `${balance.used} حاضر · ${balance.remaining} متبقي`
  );
  await persistLegacyPlayerChanges(previous, `تم حفظ التواريخ واحتساب ${arabicDigits(balance.used)} حضور و${arabicDigits(balance.remaining)} تمرين متبقٍ للاعب ${player.name}.`);
}

async function saveLegacyPlayerAttendance(form) {
  const player = data.users.find(item => item.id === form.get("playerId") && item.role === "member");
  const session = data.sessions.find(item => item.id === form.get("sessionId"));
  const isoDate = legacyDateFromForm(form, "legacyAttendance");
  const status = String(form.get("status") || "");
  if (currentUser?.role !== "coach" || !player || !session || !isoDate || !["حاضر", "غائب"].includes(status)) {
    showToast("تحقق من اللاعب والحصة والتاريخ والحالة.");
    return;
  }
  if (isoDate > localDateString()) { showToast("لا يمكن إدخال سجل بتاريخ مستقبلي."); return; }
  const firstPracticeDate = player.legacyAttendanceStartDate || player.subscriptionStart || player.actualStartDate;
  const lastPracticeDate = player.endDate || player.subscriptionEnd;
  if (player.legacyAttendanceAuto && (isoDate < firstPracticeDate || (lastPracticeDate && isoDate > lastPracticeDate))) {
    showToast("تاريخ السجل يجب أن يقع ضمن مدة الاشتراك المحددة للاعب.");
    return;
  }
  const weekday = weekdayForDate(isoDate);
  if (!player.weeklyDays?.includes(weekday) || !sessionDays(session).includes(weekday) || !sessionIncludesMember(session, player)) {
    showToast(`الحصة المحددة لا تطابق أيام تدريب اللاعب يوم ${weekday}.`);
    return;
  }
  if (data.attendance.some(record => record.playerId === player.id && record.sessionId === session.id && record.isoDate === isoDate)) {
    showToast("يوجد سجل لهذا اللاعب والحصة في التاريخ نفسه.");
    return;
  }
  if (dayOffExists(attendanceSlotForSession(session)?.id, isoDate)) {
    showToast("هذا اليوم مسجل كإجازة للحصة.");
    return;
  }
  const previous = legacyPlayerSnapshot();
  const timestamp = new Date(`${isoDate}T12:00:00`).getTime();
  const record = {
    id: crypto.randomUUID(),
    playerId: player.id,
    playerCode: player.playerCode,
    guardianId: player.guardianId,
    playerName: player.name,
    sessionId: session.id,
    sessionTitle: session.title,
    sessionTime: session.time,
    guardianPhone: player.guardianPhone || "",
    timestamp,
    markedAt: Date.now(),
    isoDate,
    date: egyptianDate.format(new Date(`${isoDate}T12:00:00`)),
    registeredAt: status === "حاضر" ? session.time || "" : "",
    status,
    attendedUnpaid: false,
    unpaidException: false,
    legacyImport: true
  };
  const priorBalance = playerTrainingBalance(player);
  data.attendance.push(record);
  player.attendanceLogs = [...new Set([...(player.attendanceLogs || []), record.id])];
  appendLegacyPlayerChange(player, status === "غائب" ? "تسجيل غياب" : "تسجيل حضور", "غير مسجل", `${isoDate} · ${session.title}`);
  if (status === "حاضر") {
    const earliestLegacyAttendance = data.attendance
      .filter(item => item.playerId === player.id && item.legacyImport && ["حاضر", "متأخر"].includes(item.status))
      .map(item => item.isoDate)
      .filter(isValidIsoDate)
      .sort()[0];
    if (earliestLegacyAttendance) {
      player.legacyAttendanceStartDate = earliestLegacyAttendance;
      if (!player.subscriptionStart && !player.actualStartDate && !player.expectedStartDate) {
        player.subscriptionStart = earliestLegacyAttendance;
        player.actualStartDate = earliestLegacyAttendance;
        player.expectedStartDate = earliestLegacyAttendance;
      }
    }
  }
  const updatedBalance = playerTrainingBalance(player);
  player.sessionsUsed = updatedBalance.used;
  player.sessionsLeft = updatedBalance.remaining;
  const projectedEnd = legacyProjectedEndDate(player, player.legacyAttendanceStartDate);
  if (projectedEnd) {
    const previousEnd = player.endDate || player.subscriptionEnd || "غير محدد";
    player.endDate = projectedEnd;
    player.subscriptionEnd = projectedEnd;
    appendLegacyPlayerChange(player, "إعادة حساب تاريخ انتهاء الاشتراك", previousEnd, projectedEnd);
  }
  appendLegacyPlayerChange(
    player,
    "تحديث رصيد التمارين بعد سجل الحضور",
    `${priorBalance.used} حاضر · ${priorBalance.remaining} متبقي`,
    `${updatedBalance.used} حاضر · ${updatedBalance.remaining} متبقي`
  );
  await persistLegacyPlayerChanges(previous, `تم تسجيل ${status} للاعب ${player.name}. المتبقي ${arabicDigits(updatedBalance.remaining)} تمرين.`);
}

async function saveLegacyPlayerPayment(form) {
  const player = data.users.find(item => item.id === form.get("playerId") && item.role === "member");
  const amountText = String(form.get("paymentAmount") || "");
  const amount = Number(amountText);
  const paymentDate = String(form.get("paymentDate") || "");
  const method = String(form.get("paymentMethod") || "");
  if (currentUser?.role !== "coach" || !player || !Number.isInteger(amount) || amount < 1 || amount > 1000000
    || !isValidIsoDate(paymentDate) || paymentDate > localDateString() || !["cash", "instapay"].includes(method)) {
    showToast("تحقق من مبلغ الدفع وتاريخه وطريقته.");
    return;
  }
  const previous = legacyPlayerSnapshot();
  const timestamp = new Date(`${paymentDate}T12:00:00`).getTime();
  data.payments.push({
    id: crypto.randomUUID(),
    guardianId: player.guardianId,
    playerId: player.id,
    playerName: player.name,
    planId: Number(player.weeklyDaysCount || player.weeklyDays?.length || 1),
    planName: `${arabicDigits(player.weeklyDaysCount || player.weeklyDays?.length || 1)} أيام أسبوعيًا`,
    amount,
    method,
    methodLabel: method === "cash" ? "نقدي" : "إنستا باي / محفظة بنكية",
    status: method === "cash" ? "تم الدفع نقدًا" : "تم التأكيد",
    date: egyptianDate.format(new Date(`${paymentDate}T12:00:00`)),
    createdAt: timestamp,
    confirmedAt: timestamp,
    legacyImport: true
  });
  appendLegacyPlayerChange(player, "إضافة دفعة سابقة", "غير مسجلة", `${paymentDate} · ${amount} ج.م · ${method === "cash" ? "كاش" : "إنستا باي"}`);
  await persistLegacyPlayerChanges(previous, `تم حفظ دفعة ${arabicDigits(amount)} ج.م للاعب ${player.name}.`);
}

function coachAdministrativeAbsencesView() {
  if (currentUser?.role !== "coach") return "";
  const players = data.users.filter(user => user.role === "member").sort((left, right) => left.name.localeCompare(right.name, "ar"));
  const records = [...data.administrativeAbsences].sort((left, right) => right.isoDate.localeCompare(left.isoDate));
  const playerOptions = players.map(player =>
    `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)} · كود ${escapeHtml(player.playerCode)}</option>`
  ).join("");
  const rows = records.map(record =>
    `<tr><td>${escapeHtml(record.playerName || "لاعب")}</td><td>${escapeHtml(record.playerCode || "—")}</td><td>${escapeHtml(record.dateLabel || record.isoDate)}</td><td>${escapeHtml(record.createdByName || "المشرف")}</td></tr>`
  ).join("");
  return `<section class="panel"><div class="panel-heading"><div><h2>سجل الغياب الإداري</h2><p>سجل منفصل لا يتطلب اشتراكًا مفعّلًا ولا يخصم تدريبات من رصيد اللاعب. يُمنع تكرار اللاعب في التاريخ نفسه.</p></div></div><div class="form-row"><label>اللاعب<select id="administrative-absence-player" ${players.length ? "" : "disabled"} required><option value="">اختر اللاعب</option>${playerOptions}</select></label><button type="button" class="primary-button" data-action="record-administrative-absence" ${players.length ? "" : "disabled"}>＋ تسجيل يوم غياب</button></div>${records.length ? `<div class="table-wrap"><table><thead><tr><th>اللاعب</th><th>كود اللاعب</th><th>تاريخ الغياب</th><th>سُجل بواسطة</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد أيام غياب إدارية مسجلة.</p></div>'}</section>`;
}

function openAdministrativeAbsenceForm(playerId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الغياب الإداري متاح للمشرف فقط."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  if (!player) { showToast("اختر لاعبًا صحيحًا لتسجيل الغياب."); return; }
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const monthOptions = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const label = new Intl.DateTimeFormat("ar-EG", { month: "long" }).format(new Date(2024, index, 1));
    return `<option value="${month}" ${month === currentMonth ? "selected" : ""}>${label}</option>`;
  }).join("");
  const yearOptions = Array.from({ length: Math.max(1, currentYear - 1969) }, (_, index) => currentYear - index)
    .map(year => `<option value="${year}" ${year === currentYear ? "selected" : ""}>${arabicDigits(year)}</option>`)
    .join("");
  openModal(
    `تسجيل غياب إداري · ${player.name}`,
    `<p class="modal-explainer">يسجل هذا الإجراء يوم الغياب في خانة إدارية مستقلة، دون اشتراط اشتراك مفعّل ودون خصم تمرين من الرصيد.</p><div class="form-row"><label>اليوم — أدخله يدويًا<input name="absenceDay" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{1,2}" maxlength="2" required placeholder="اليوم"></label><label>الشهر<select name="absenceMonth" required>${monthOptions}</select></label><label>السنة<select name="absenceYear" required>${yearOptions}</select></label></div>`,
    "حفظ يوم الغياب",
    form => saveAdministrativeAbsence(form, player.id),
    "سجل الغياب الإداري"
  );
}

async function saveAdministrativeAbsence(form, playerId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الغياب الإداري متاح للمشرف فقط."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  if (!player) { showToast("لم يتم العثور على اللاعب."); return; }
  const dayText = normalizeDigits(String(form.get("absenceDay") || "").trim());
  const day = Number(dayText);
  const month = Number(form.get("absenceMonth"));
  const year = Number(form.get("absenceYear"));
  const date = new Date(year, month - 1, day, 12);
  const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!/^\d{1,2}$/.test(dayText) || !Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(year) || !isValidIsoDate(isoDate) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    showToast("أدخل يومًا صحيحًا واختر شهرًا وسنة صالحين.");
    return;
  }
  if (isoDate > localDateString()) { showToast("لا يمكن تسجيل غياب بتاريخ مستقبلي."); return; }
  if (data.administrativeAbsences.some(record => record.playerId === player.id && record.isoDate === isoDate)) {
    showToast("تم تسجيل غياب هذا اللاعب في التاريخ نفسه من قبل.");
    return;
  }
  const dateLabel = egyptianDate.format(date);
  try {
    const firebase = await window.firebaseReady;
    const record = await firebase.createAdministrativeAbsence({
      playerId: player.id,
      playerCode: player.playerCode,
      playerName: player.name,
      isoDate,
      dateLabel,
      createdBy: currentUser.id
    });
    data.administrativeAbsences = [
      record,
      ...data.administrativeAbsences.filter(item => item.id !== record.id)
    ];
    saveLocalData();
    closeModal();
    renderView();
    showToast(`تم تسجيل غياب ${player.name} بتاريخ ${dateLabel} دون خصم تدريبات.`);
  } catch (error) {
    console.error("تعذر حفظ سجل الغياب الإداري.", error);
    showToast(error instanceof Error ? error.message : "تعذر حفظ سجل الغياب الإداري.");
  }
}

async function deleteGuardian(guardianId) {
  if (currentUser?.role !== "coach") { showToast("حذف الحسابات متاح للمشرف فقط."); return; }
  const guardian = data.users.find(user => user.id === guardianId && user.role === "guardian");
  if (!guardian) { showToast("لم يتم العثور على حساب ولي الأمر."); return; }
  const children = childrenForGuardian(guardian.id);
  if (!window.confirm(`حذف حساب ${guardian.name} و${children.length} من أبنائه؟ سيبقى سجل الحضور والمدفوعات محفوظًا.`)) return;
  const deletedUsers = data.users.filter(user => user.id === guardian.id || user.guardianId === guardian.id);
  data.users = data.users.filter(user => user.id !== guardian.id && user.guardianId !== guardian.id);
  if (!saveData()) { data.users.push(...deletedUsers); return; }
  try {
    const firebase = await window.firebaseReady;
    await firebase.deleteGuardian(guardian, children);
  } catch (error) {
    data.users.push(...deletedUsers);
    saveData();
    console.error("تعذر حذف حساب ولي الأمر من Firestore.", error);
    showToast(error instanceof Error ? error.message : "تعذر حذف الحساب من Firestore.");
    return;
  }
  renderView();
  showToast("تم حذف الحساب واللاعبين من Firestore مع الإبقاء على سجلات الحضور والمدفوعات.");
}

function coachPaymentsView() {
  const newestFirst = (a, b) => Number(b.confirmedAt || b.createdAt || 0) - Number(a.confirmedAt || a.createdAt || 0);
  const pendingPayments = data.payments.filter(payment => payment.status === "بانتظار المراجعة").sort(newestFirst);
  const confirmedPayments = data.payments.filter(payment => isRecordedPayment(payment) && payment.status !== "دفع جزئي نقدًا").sort(newestFirst);
  const pendingPlayerIds = new Set(pendingPayments.map(payment => payment.playerId));
  const latestPaymentByPlayer = new Map();
  [...data.payments].sort(newestFirst).forEach(payment => {
    if (!latestPaymentByPlayer.has(payment.playerId)) latestPaymentByPlayer.set(payment.playerId, payment);
  });
  const unpaidPlayers = data.users
    .filter(user => {
      const latestPayment = latestPaymentByPlayer.get(user.id);
      const latestPaymentConfirmed = latestPayment
        && isRecordedPayment(latestPayment)
        && latestPayment.status !== "دفع جزئي نقدًا";
      return user.role === "member" && !pendingPlayerIds.has(user.id) && !latestPaymentConfirmed;
    })
    .map(user => ({
      user,
      payment: latestPaymentByPlayer.get(user.id) || null
    }))
    .sort((a, b) => newestFirst(
      a.payment || { createdAt: a.user.updatedAt || a.user.createdAt || 0 },
      b.payment || { createdAt: b.user.updatedAt || b.user.createdAt || 0 }
    ) || String(a.user.name || "").localeCompare(String(b.user.name || ""), "ar"));
  const paymentRow = payment => {
    const user = data.users.find(item => item.id === payment.playerId);
    const paid = isRecordedPayment(payment);
    const paidMessage = payment.status === "سداد مديونية نقدية"
      ? `تم تسجيل سداد مديونية اللاعب ${payment.playerName} بقيمة ${payment.amount} ج.م.`
      : `تم تأكيد دفع اشتراك اللاعب ${payment.playerName} بقيمة ${payment.amount} ج.م وتفعيل الاشتراك.`;
    const timestamp = Number(payment.confirmedAt || payment.createdAt);
    const paymentTime = payment.paidTime || (Number.isFinite(timestamp) && timestamp
      ? new Date(timestamp).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })
      : "—");
    const requiresResubmission = payment.status === "بانتظار المراجعة"
      && (payment.method !== "instapay"
        || !Number.isInteger(Number(payment.planId))
        || Number(payment.planId) < 1
        || Number(payment.planId) > 7
        || !isValidCurrencyAmount(Number(payment.amount))
        || Number(payment.amount) < 0);
    const action = payment.status !== "بانتظار المراجعة"
      ? `<span class="subscription-badge ${paid ? "status-active" : "status-soon"}">${escapeHtml(payment.status)}</span>${paid && user ? guardianWhatsApp(user, paidMessage, "إشعار الدفع") : ""}`
      : requiresResubmission
        ? `<button class="small-action" data-action="reject-payment" data-payment="${escapeHtml(payment.id)}">رفض لإعادة تقديمه بالمبلغ الصحيح</button>`
        : `<button class="small-action" data-action="confirm-payment" data-payment="${escapeHtml(payment.id)}" ${user && canRequestPayment(user) ? "" : "disabled"}>مراجعة المبلغ وتأكيده</button>`;
    return `<tr><td>${escapeHtml(payment.playerName)}</td><td>${escapeHtml(payment.planName)}<small class="table-subtext">${escapeHtml(subscriptionDurationLabel(payment.subscriptionDuration))}</small>${payment.originalPlanName && payment.originalPlanName !== payment.planName ? `<small class="table-subtext">الباقة المطلوبة: ${escapeHtml(payment.originalPlanName)}</small>` : ""}<br><strong>${arabicDigits(payment.amount)} ج.م</strong>${payment.walletCreditReserved ? `<small class="table-subtext">رصيد محفظة مستخدم/محجوز: ${arabicDigits(payment.walletCreditReserved)} ج.م</small>` : ""}${payment.walletCreditAddedAmount ? `<small class="table-subtext">رصيد دائن مضاف: ${arabicDigits(payment.walletCreditAddedAmount)} ج.م</small>` : ""}${payment.walletCreditUsedAmount ? `<small class="table-subtext">رصيد مخصوم: ${arabicDigits(payment.walletCreditUsedAmount)} ج.م</small>` : ""}${payment.siblingDiscount ? `<small class="table-subtext">خصم إخوة ${arabicDigits(payment.siblingDiscount)} ج.م</small>` : ""}${payment.specialDiscountAmount ? `<small class="table-subtext">خصم استثنائي ${arabicDigits(payment.specialDiscountAmount)} ج.م</small>` : ""}${payment.debtAddedAmount ? `<small class="table-subtext">مديونية مضافة ${arabicDigits(payment.debtAddedAmount)} ج.م</small>` : ""}</td><td>${escapeHtml(payment.method === "cash" ? "نقدي" : payment.methodLabel || "تحويل")}</td><td><strong class="payment-reference">${escapeHtml(payment.reference || "—")}</strong>${payment.reference && payment.method !== "cash" ? `<button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(payment.reference)}">نسخ كود الدفع</button>` : ""}</td><td>${payment.receiptImage ? `<button type="button" class="receipt-preview" data-action="receipt-preview" data-receipt="${escapeHtml(payment.receiptImage)}" data-player="${escapeHtml(payment.playerName)}"><img class="receipt-thumbnail" src="${escapeHtml(payment.receiptImage)}" alt="إيصال تحويل ${escapeHtml(payment.playerName)}"><span>اضغط لتكبير الإيصال</span></button>` : "—"}</td><td>${escapeHtml(payment.date)}<br>${escapeHtml(paymentTime)}</td><td>${action}</td></tr>`;
  };
  const unpaidRow = ({ user, payment }) => payment
    ? paymentRow(payment)
    : `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(priceSummary(user.weeklyDays?.length || user.weeklyDaysCount).plan.name)}<small class="table-subtext">لا يوجد اشتراك مدفوع مسجل</small></td><td>—</td><td>—</td><td>—</td><td>—</td><td><span class="subscription-badge status-soon">لم يسدد بعد</span></td></tr>`;
  const columns = "<thead><tr><th>اللاعب</th><th>الباقة والمبلغ</th><th>طريقة الدفع</th><th>مرجع / كود الدفع</th><th>الإيصال</th><th>تاريخ وساعة الدفع</th><th>الحالة والإجراء</th></tr></thead>";
  const paymentTable = rows => `<div class="table-wrap"><table>${columns}<tbody>${rows}</tbody></table></div>`;
  const paymentSection = (title, count, content) => `<section class="panel"><div class="panel-heading"><h2>${title} <small>(${arabicDigits(count)})</small></h2></div>${content}</section>`;
  return `<section class="page-intro"><div><p class="eyebrow">التحصيل المالي</p><h1>طلبات الدفع</h1><p class="welcome-subtitle">راجع كود التحويل والرسالة الواردة عبر واتساب قبل تأكيد أي دفعة.</p></div><button class="primary-button" data-action="instapay-settings">بيانات التحويل</button></section>
    <section class="instapay-panel coach-instapay"><span class="instapay-brand">⇄</span><div><h2>بيانات التحويل الحالية</h2><p>${data.instaPayAddress ? escapeHtml(data.instaPayAddress) : "لم تتم إضافة بيانات الدفع بعد."}</p></div></section>
    ${paymentSection("طلبات الدفع المرسلة", pendingPayments.length, pendingPayments.length
      ? paymentTable(pendingPayments.map(paymentRow).join(""))
      : '<div class="empty-state"><p>لا توجد طلبات دفع مرسلة بانتظار المراجعة.</p></div>')}
    ${paymentSection("لاعبون لم يسددوا بعد", unpaidPlayers.length, unpaidPlayers.length
      ? paymentTable(unpaidPlayers.map(unpaidRow).join(""))
      : '<div class="empty-state"><p>لا يوجد لاعبون غير مسددين.</p></div>')}
    ${paymentSection("مدفوعات مؤكدة", confirmedPayments.length, confirmedPayments.length
      ? paymentTable(confirmedPayments.map(paymentRow).join(""))
      : '<div class="empty-state"><p>لا توجد مدفوعات مؤكدة.</p></div>')}`;
}

function openModal(title, fields, submitLabel, submitAction, kicker = "الاتحاد أكادمي") {
  byId("modal-kicker").textContent = kicker;
  byId("modal-title").textContent = title;
  byId("action-form").innerHTML = `${fields}<div class="modal-actions"><button type="button" class="cancel-button" id="cancel-action">إلغاء</button><button type="submit" class="primary-button">${submitLabel} <span>←</span></button></div>`;
  byId("action-modal").classList.add("open");
  byId("action-modal").setAttribute("aria-hidden", "false");
  byId("cancel-action").addEventListener("click", closeModal);
  byId("action-form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    authFlowInProgress = true;
    try {
      await submitAction(new FormData(form));
    } catch (error) {
      console.error("تعذر إتمام الإجراء.", error);
      showToast(error instanceof Error ? error.message : "تعذر إتمام الإجراء. حاول مرة أخرى.");
    } finally {
      if (submitButton.isConnected) submitButton.disabled = false;
    }
  };
  byId("action-form").querySelector("input, select")?.focus();
}

function closeModal() {
  if (attendanceClockInterval !== null) {
    clearInterval(attendanceClockInterval);
    attendanceClockInterval = null;
  }
  byId("action-modal").classList.remove("open");
  byId("action-modal").setAttribute("aria-hidden", "true");
}

async function requestPlayerPayment(player, planId) {
  if (!selectedSessionsForMember(player).length) { showToast("اختر مواعيد التدريب أولًا من صفحة جدول التدريبات."); return; }
  const playerDayCount = player.weeklyDays?.length || player.weeklyDaysCount;
  if (Number(planId) !== Number(playerDayCount)) { showToast("تغيرت أيام تدريب اللاعب. حدّث الصفحة وحاول مجددًا."); return; }
  if (hasPartialCashPayment(player)) { showToast("أكمل المبلغ النقدي المتبقي لدى الأكاديمية قبل تسجيل تحويل إلكتروني."); return; }
  if (!canRequestPayment(player)) { showToast(`يمكن تجديد اشتراك ${player.name} عند تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  if (hasPendingPayment(player)) { showToast("لدى هذا اللاعب طلب دفع قيد المراجعة بالفعل."); return; }
  try {
    const firebase = await window.firebaseReady;
    const quote = await firebase.quotePlayerPayment(Number(planId));
    if (quote.playerId !== player.id || Number(quote.planId) !== Number(planId)
      || !Number.isFinite(Number(quote.monthlyPrice))
      || !Number.isFinite(Number(quote.walletCreditReserved))
      || !Number.isFinite(Number(quote.fullSiblingDiscount))
      || !Number.isFinite(Number(quote.fullAmount))
      || !Number.isFinite(Number(quote.halfAmount))) {
      throw new Error("تعذر التحقق من تسعير اشتراك اللاعب. حدّث الصفحة وحاول مجددًا.");
    }
    if ((quote.fullAmount || quote.halfAmount) && !data.instaPayAddress) {
      showToast("لم تضف الأكاديمية بيانات التحويل بعد. تواصل مع المدرب.");
      return;
    }
    const amountForDuration = duration => Number(duration === "half" ? quote.halfAmount : quote.fullAmount);
    const summaryForDuration = duration => {
      const price = duration === "half" ? Number(quote.monthlyPrice) / 2 : Number(quote.monthlyPrice);
      const discount = duration === "half" ? 0 : Number(quote.fullSiblingDiscount);
      return `${escapeHtml(player.name)}: ${subscriptionDurationLabel(duration)} · سعر ${arabicDigits(price)} ج.م − رصيد ${arabicDigits(quote.walletCreditReserved)} ج.م${discount ? ` − خصم إخوة ${arabicDigits(discount)} ج.م` : ""} = تحويل ${arabicDigits(amountForDuration(duration))} ج.م.`;
    };
    openModal("طلب اشتراك اللاعب عبر إنستا باي", `<label>مدة الاشتراك<select name="subscriptionDuration" required><option value="full">شهر كامل — السعر الشهري</option><option value="half">نصف شهر — ٥٠٪ من السعر، دون خصومات</option></select></label><p class="modal-explainer" id="player-payment-summary">${summaryForDuration("full")}</p><p class="payment-warning" id="player-transfer-guidance">${quote.fullAmount ? "حوّل المبلغ المستحق إلى بيانات الأكاديمية. أرفق صورة الإيصال في رسالة واتساب؛ لا تُرفع الصورة إلى الموقع." : "رصيد المحفظة يغطي قيمة الاشتراك بالكامل؛ سيتم إرسال طلب التفعيل للمشرف دون تحويل جديد."}</p><label id="player-reference-field" ${quote.fullAmount ? "" : "hidden"}>كود التحويل / رقم العملية<input name="reference" ${quote.fullAmount ? 'required minlength="4"' : ""} maxlength="120" placeholder="رقم العملية كما يظهر في التطبيق"></label><div class="payment-destination" ${quote.fullAmount ? "" : "hidden"}><span>رقم التحويل إلى الأكاديمية</span><strong>${escapeHtml(data.instaPayAddress)}</strong></div><label>إجمالي المبلغ المطلوب تحويله<input name="amount" type="number" step="0.01" value="${quote.fullAmount}" readonly></label>`, "إرسال الطلب", async form => {
      if (currentUser?.role !== "member" || currentUser.id !== player.id) {
        showToast("أرسل طلب الدفع من حساب اللاعب نفسه.");
        return;
      }
      if (hasPendingPayment(player) || hasPartialCashPayment(player) || !canRequestPayment(player)) {
        showToast("تغيرت حالة الاشتراك. حدّث الصفحة وتحقق من المدفوعات.");
        return;
      }
      const subscriptionDuration = normalizeSubscriptionDuration(form.get("subscriptionDuration"));
      const amount = amountForDuration(subscriptionDuration);
      const reference = String(form.get("reference") || "").trim();
      if (Number(form.get("amount")) !== amount
        || (amount > 0 && (reference.length < 4 || reference.length > 120 || hasDuplicatePaymentReference(reference)))) {
        showToast(amount > 0
          ? "تحقق من المبلغ ورقم العملية بعد خصم رصيد المحفظة وخصم الإخوة."
          : "تعذر التحقق من المبلغ. حدّث الصفحة وحاول مجددًا.");
        return;
      }
      const expectedStartDate = automaticSubscriptionStartDate(player);
      const whatsappTab = amount > 0 ? window.open("about:blank", "_blank") : null;
      try {
        const payment = await firebase.createPlayerPaymentRequest({
          planId: Number(planId),
          subscriptionDuration,
          expectedStartDate,
          reference,
          quotedAmount: amount,
          quotedMonthlyPrice: Number(quote.monthlyPrice),
          quotedWalletCredit: Number(quote.walletCreditReserved),
          quotedSiblingDiscount: subscriptionDuration === "half" ? 0 : Number(quote.fullSiblingDiscount)
        });
        if (!payment || payment.playerId !== player.id || payment.status !== "بانتظار المراجعة") {
          throw new Error("لم يتمكن النظام من تأكيد حفظ طلب الدفع. حدّث الصفحة وتحقق من سجل المدفوعات.");
        }
        data.payments.push(payment);
        const localSaved = saveLocalData();
        if (whatsappTab && amount > 0) {
          const dateTime = new Intl.DateTimeFormat("ar-EG", { dateStyle: "full", timeStyle: "short" }).format(new Date(payment.createdAt));
          const message = [
            "طلب اشتراك لاعب عبر إنستا باي - أكاديمية الاتحاد",
            `اسم اللاعب: ${player.name} · ${subscriptionDurationLabel(subscriptionDuration)} · سعر الباقة: ${arabicDigits(subscriptionDuration === "half" ? Number(quote.monthlyPrice) / 2 : quote.monthlyPrice)} ج.م · رصيد مستخدم: ${arabicDigits(quote.walletCreditReserved)} ج.م${subscriptionDuration === "full" && quote.fullSiblingDiscount ? ` · خصم إخوة: ${arabicDigits(quote.fullSiblingDiscount)} ج.م` : ""} · المطلوب تحويله: ${arabicDigits(amount)} ج.م`,
            `كود التحويل / رقم العملية: ${reference}`,
            `تاريخ ووقت الإرسال: ${dateTime}`,
            "يرجى إرفاق صورة إيصال التحويل المحفوظة على هاتفك مع هذه الرسالة."
          ].join("\n");
          whatsappTab.opener = null;
          whatsappTab.location.replace(`https://wa.me/${whatsappPhone(DEFAULT_INSTAPAY_NUMBER)}?text=${encodeURIComponent(message)}`);
        }
        closeModal();
        renderView();
        if (!localSaved) {
          showToast("تم حفظ الطلب في الأكاديمية، لكن تعذر حفظ نسخة على هذا الجهاز.");
        } else if (whatsappTab && amount > 0) {
          showToast("تم حفظ الطلب وفتح واتساب. أرفق صورة الإيصال قبل إرسال الرسالة.");
        } else {
          showToast("تم إرسال طلب التجديد للمشرف؛ رصيد المحفظة يغطي الاشتراك.");
        }
      } catch (error) {
        whatsappTab?.close();
        throw error;
      }
    }, "إنستا باي");
    const form = byId("action-form");
    form.addEventListener("change", event => {
      if (!(event.target instanceof HTMLSelectElement) || event.target.name !== "subscriptionDuration") return;
      const duration = normalizeSubscriptionDuration(event.target.value);
      const amount = amountForDuration(duration);
      form.querySelector('input[name="amount"]').value = String(amount);
      byId("player-payment-summary").innerHTML = summaryForDuration(duration);
      byId("player-transfer-guidance").textContent = amount
        ? "حوّل المبلغ المستحق إلى بيانات الأكاديمية. أرفق صورة الإيصال في رسالة واتساب؛ لا تُرفع الصورة إلى الموقع."
        : "رصيد المحفظة يغطي قيمة الاشتراك بالكامل؛ سيتم إرسال طلب التفعيل للمشرف دون تحويل جديد.";
      form.querySelector('input[name="reference"]').required = amount > 0;
      form.querySelector('input[name="reference"]').minLength = amount > 0 ? 4 : 0;
      byId("player-reference-field").hidden = amount === 0;
      form.querySelector(".payment-destination").hidden = amount === 0;
    });
  } catch (error) {
    console.error("تعذر إنشاء طلب دفع اللاعب.", error);
    showToast(error instanceof Error ? error.message : "تعذر إرسال طلب الدفع. حاول مرة أخرى.");
  }
}

function requestPayment(planId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الدفع متاحة من حساب ولي الأمر أو اللاعب."); return; }
  const player = userForMember();
  if (!player) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
  if (currentUser.role === "member") {
    requestPlayerPayment(player, planId);
    return;
  }
  if (currentUser.role !== "guardian") { showToast("إرسال طلب إنستا باي متاح من حساب ولي الأمر أو اللاعب."); return; }
  const guardianId = currentUser.id;
  const siblings = childrenForGuardian(currentUser.id);
  const selectedPlayerIsChild = siblings.some(child => child.id === player.id);
  if (!selectedPlayerIsChild) { showToast("لم يتم العثور على اللاعب ضمن حساب ولي الأمر."); return; }
  if (!selectedSessionsForMember(player).length) { showToast("اختر مواعيد التدريب أولًا من صفحة جدول التدريبات."); return; }
  const playerDayCount = player.weeklyDays?.length || player.weeklyDaysCount;
  if (Number(planId) !== Number(playerDayCount)) { showToast("تغيرت أيام تدريب اللاعب. حدّث الصفحة وحاول مجددًا."); return; }
  if (hasPartialCashPayment(player)) { showToast("أكمل المبلغ النقدي المتبقي لدى الأكاديمية قبل تسجيل تحويل إلكتروني."); return; }
  if (!canRequestPayment(player)) { showToast(`يمكن تجديد اشتراك ${player.name} عند تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  if (hasPendingPayment(player)) { showToast("لدى هذا اللاعب طلب دفع قيد المراجعة بالفعل."); return; }
  const selectablePlayers = siblings.map(child => ({
    player: child,
    dayCount: Number(child.weeklyDays?.length || child.weeklyDaysCount),
    plan: priceSummary(child.weeklyDays?.length || child.weeklyDaysCount).plan,
    walletCreditReserved: memberWalletBalance(child),
    eligible: Boolean(
      child.weeklyDays?.length
      && selectedSessionsForMember(child).length
      && canRequestPayment(child)
      && !hasPendingPayment(child)
      && !hasPartialCashPayment(child)
    )
  }));
  const eligiblePlayers = selectablePlayers.filter(item => item.eligible);
  if (!eligiblePlayers.some(item => item.player.id === player.id)) { showToast("اللاعب المحدد غير جاهز لطلب الدفع."); return; }
  const renderPaymentOptions = (duration, selectedIds) => {
    const selectedPlayers = [...selectedIds]
      .map(id => selectablePlayers.find(candidate => candidate.player.id === id)?.player)
      .filter(Boolean);
    return selectablePlayers.map(item => {
      const checked = selectedIds.has(item.player.id);
      const planPrice = subscriptionPrice(item.dayCount, duration);
      const amountBeforeDiscount = Math.max(0, planPrice - item.walletCreditReserved);
      const siblingDiscount = duration === "full" ? siblingDiscountForPlayer(item.player, amountBeforeDiscount, selectedPlayers) : 0;
      const transferDue = amountBeforeDiscount - siblingDiscount;
      return `<div class="cash-sibling-option"><label class="cash-sibling-choice"><input type="checkbox" name="playerIds" value="${escapeHtml(item.player.id)}" ${checked ? "checked" : ""} ${item.player.id === player.id ? "data-primary-player" : ""} ${item.eligible ? "" : "disabled"}><span><strong>${escapeHtml(item.player.name)}</strong><small>${escapeHtml(item.plan.name)} · ${escapeHtml(subscriptionDurationLabel(duration))} · السعر ${arabicDigits(planPrice)} ج.م · رصيد ${arabicDigits(item.walletCreditReserved)} ج.م${siblingDiscount ? ` · خصم إخوة ${arabicDigits(siblingDiscount)} ج.م` : ""} · التحويل ${arabicDigits(transferDue)} ج.م${item.eligible ? "" : " · غير متاح للدفع الآن"}</small></span></label></div>`;
    }).join("");
  };
  const initialPaymentOptions = renderPaymentOptions("full", new Set([player.id]));
  const initialQuote = subscriptionGroupQuote([eligiblePlayers.find(item => item.player.id === player.id)]);
  if (initialQuote.total && !data.instaPayAddress) { showToast("لم تضف الأكاديمية بيانات التحويل بعد. تواصل مع المدرب."); return; }
  openModal("إرسال طلب الاشتراك عبر إنستا باي", `<label>مدة الاشتراك<select name="subscriptionDuration" required><option value="full">شهر كامل — السعر الشهري</option><option value="half">نصف شهر — ٥٠٪ من السعر الشهري، دون خصومات</option></select></label><fieldset class="cash-sibling-list" id="instapay-player-options"><legend>الأبناء المراد دفع اشتراكاتهم</legend>${initialPaymentOptions}</fieldset><p class="modal-explainer" id="instapay-payment-summary">${subscriptionGroupSummary(initialQuote)}</p><p class="payment-warning" id="instapay-transfer-guidance">${initialQuote.total ? "حوّل المبلغ المستحق إلى بيانات الأكاديمية. أرفق صورة الإيصال في رسالة واتساب؛ لا تُرفع الصورة إلى الموقع." : "رصيد المحفظة يغطي قيمة الاشتراك بالكامل؛ سيتم إرسال طلب التفعيل للمشرف دون تحويل جديد."}</p><label id="instapay-reference-field" ${initialQuote.total ? "" : "hidden"}>كود التحويل / رقم العملية<input name="reference" ${initialQuote.total ? 'required minlength="4"' : ""} maxlength="120" placeholder="رقم العملية كما يظهر في التطبيق"></label><div class="payment-destination" ${initialQuote.total ? "" : "hidden"}><span>رقم التحويل إلى الأكاديمية</span><strong>${escapeHtml(data.instaPayAddress || "")}</strong></div><label>إجمالي المبلغ المطلوب تحويله<input name="amount" type="number" step="0.01" value="${initialQuote.total}" readonly></label>`, "إرسال الطلب", async form => {
    if (currentUser.role !== "guardian") { showToast("إرسال طلب الاشتراك متاح من حساب ولي الأمر فقط."); return; }
    const selectedIds = [...new Set(form.getAll("playerIds").map(String))];
    const selectedPlayers = selectedIds.map(id => eligiblePlayers.find(item => item.player.id === id)).filter(Boolean);
    if (!selectedPlayers.some(item => item.player.id === player.id) || selectedPlayers.length !== selectedIds.length) {
      showToast("اختر اللاعب الأساسي وأبناء الحساب المؤهلين للدفع فقط.");
      return;
    }
    if (selectedPlayers.some(item =>
      item.player.guardianId !== guardianId
      || hasPendingPayment(item.player)
      || hasPartialCashPayment(item.player)
      || !canRequestPayment(item.player)
      || !selectedSessionsForMember(item.player).length
      || Number(item.player.weeklyDays?.length || item.player.weeklyDaysCount) !== item.dayCount
    )) {
      showToast("تغيرت حالة أحد اللاعبين أو أيام تدريبه. حدّث الصفحة وراجع الاختيارات.");
      return;
    }
    const startDates = new Map();
    for (const item of selectedPlayers) {
      startDates.set(item.player.id, automaticSubscriptionStartDate(item.player));
    }
    const subscriptionDuration = normalizeSubscriptionDuration(form.get("subscriptionDuration"));
    const quote = subscriptionGroupQuote(selectedPlayers, subscriptionDuration);
    const reference = String(form.get("reference") || "").trim();
    if (quote.total > 0 && hasDuplicatePaymentReference(reference)) {
      showToast("الرقم المرجعي خطأ، هذا الرقم مستخدم بالفعل. تحقق من الرقم المرجعي.");
      return;
    }
    if (quote.total && !data.instaPayAddress) { showToast("لم تضف الأكاديمية بيانات التحويل بعد. تواصل مع المدرب."); return; }
    if (quote.players.some(item => item.amount !== Math.max(0,
      subscriptionPrice(item.dayCount, subscriptionDuration) - item.walletCreditReserved - item.siblingDiscount
    ))
      || Number(form.get("amount")) !== quote.total
      || (quote.total > 0 && (reference.length < 4 || reference.length > 120))) {
      showToast(quote.total > 0
        ? "تحقق من مبلغ التحويل ورقم العملية بعد خصم رصيد المحفظة وخصم الإخوة."
        : "تعذر التحقق من رصيد المحفظة. حدّث الصفحة وحاول مجددًا.");
      return;
    }
    const whatsappTab = quote.total > 0 ? window.open("about:blank", "_blank") : null;
    const submittedAt = Date.now();
    const allocations = quote.players;
    const paymentGroupId = crypto.randomUUID();
    const submissions = allocations.map(allocation => {
      const payment = {
        id: crypto.randomUUID(), guardianId: currentUser.id, playerId: allocation.player.id,
        playerName: allocation.player.name, planId: allocation.dayCount, planName: allocation.plan.name,
        subscriptionDuration, paymentGroupId,
        amount: allocation.amount,
        ...(allocation.siblingDiscount ? { siblingDiscount: allocation.siblingDiscount } : {}),
        walletCreditReserved: allocation.walletCreditReserved,
        expectedStartDate: startDates.get(allocation.player.id),
        reference: reference || "رصيد محفظة اللاعب", method: "instapay", methodLabel: "إنستا باي / محفظة بنكية",
        status: "بانتظار المراجعة", createdAt: submittedAt, date: egyptianDate.format(new Date(submittedAt))
      };
      return {
        payment,
        subscription: {
          id: crypto.randomUUID(), playerId: allocation.player.id, playerCode: allocation.player.playerCode,
          playerName: allocation.player.name, expectedStartDate: startDates.get(allocation.player.id),
          transferCode: reference || "رصيد محفظة اللاعب", createdAt: submittedAt
        }
      };
    });
    const dateTime = new Intl.DateTimeFormat("ar-EG", { dateStyle: "full", timeStyle: "short" }).format(new Date(submittedAt));
    const message = [
      "طلب اشتراك عبر إنستا باي - أكاديمية الاتحاد",
      ...allocations.map(allocation => `اسم اللاعب: ${allocation.player.name} · ${subscriptionDurationLabel(subscriptionDuration)} · سعر الباقة: ${arabicDigits(allocation.planPrice)} ج.م · رصيد مستخدم: ${arabicDigits(allocation.walletCreditReserved)} ج.م${allocation.siblingDiscount ? ` · خصم إخوة: ${arabicDigits(allocation.siblingDiscount)} ج.م` : ""} · المطلوب تحويله: ${arabicDigits(allocation.amount)} ج.م · بداية التدريب: ${egyptianDate.format(new Date(`${startDates.get(allocation.player.id)}T12:00:00`))}`),
      `إجمالي المبلغ المحوّل: ${arabicDigits(quote.total)} ج.م`,
      `كود التحويل / رقم العملية: ${reference}`,
      `تاريخ ووقت التحويل والإرسال: ${dateTime}`,
      "يرجى إرفاق صورة إيصال التحويل المحفوظة على هاتفك مع هذه الرسالة."
    ].join("\n");
    const whatsappUrl = `https://wa.me/${whatsappPhone(DEFAULT_INSTAPAY_NUMBER)}?text=${encodeURIComponent(message)}`;
    data.payments.push(...submissions.map(item => item.payment));
    try {
      if (!saveLocalData()) throw new Error("تعذر حفظ الطلب محليًا.");
      const firebase = await window.firebaseReady;
      await firebase.saveSubscriptionRequests(submissions);
      if (whatsappTab) {
        whatsappTab.opener = null;
        whatsappTab.location.replace(whatsappUrl);
      } else if (quote.total > 0) {
        showToast("حُفظ الطلب، لكن المتصفح منع فتح واتساب تلقائيًا. اسمح بالنوافذ المنبثقة وحاول مجددًا.");
      }
      closeModal();
      renderView();
      if (whatsappTab) showToast("تم حفظ الطلب وفتح واتساب. أرفق صورة الإيصال قبل إرسال الرسالة.");
      else if (!quote.total) showToast("تم إرسال طلب التجديد للمشرف؛ رصيد المحفظة يغطي الاشتراك.");
    } catch (error) {
      const submissionIds = new Set(submissions.map(item => item.payment.id));
      data.payments = data.payments.filter(item => !submissionIds.has(item.id));
      saveLocalData();
      whatsappTab?.close();
      throw error;
    }
  }, "إنستا باي");
  const form = byId("action-form");
  form.addEventListener("change", event => {
    const subscriptionDuration = normalizeSubscriptionDuration(form.querySelector('select[name="subscriptionDuration"]').value);
    if (event.target instanceof HTMLSelectElement && event.target.name === "subscriptionDuration") {
      const selectedIds = new Set([...form.querySelectorAll('input[name="playerIds"]:checked')].map(input => input.value));
      selectedIds.add(player.id);
      byId("instapay-player-options").innerHTML = `<legend>الأبناء المراد دفع اشتراكاتهم</legend>${renderPaymentOptions(subscriptionDuration, selectedIds)}`;
    } else if (!(event.target instanceof HTMLInputElement) || event.target.name !== "playerIds") return;
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute("data-primary-player") && !event.target.checked) {
      event.target.checked = true;
      return;
    }
    const selected = [...form.querySelectorAll('input[name="playerIds"]:checked')]
      .map(input => eligiblePlayers.find(item => item.player.id === input.value))
      .filter(Boolean);
    const selectedIds = new Set(selected.map(item => item.player.id));
    byId("instapay-player-options").innerHTML = `<legend>الأبناء المراد دفع اشتراكاتهم</legend>${renderPaymentOptions(subscriptionDuration, selectedIds)}`;
    const quote = subscriptionGroupQuote(selected, subscriptionDuration);
    form.querySelector('input[name="amount"]').value = String(quote.total);
    byId("instapay-payment-summary").innerHTML = subscriptionGroupSummary(quote);
    byId("instapay-transfer-guidance").textContent = quote.total
      ? "حوّل المبلغ المستحق إلى بيانات الأكاديمية. أرفق صورة الإيصال في رسالة واتساب؛ لا تُرفع الصورة إلى الموقع."
      : "رصيد المحفظة يغطي قيمة الاشتراك بالكامل؛ سيتم إرسال طلب التفعيل للمشرف دون تحويل جديد.";
    const referenceInput = form.querySelector('input[name="reference"]');
    referenceInput.required = quote.total > 0;
    referenceInput.minLength = quote.total > 0 ? 4 : 0;
    byId("instapay-reference-field").hidden = quote.total === 0;
    form.querySelector(".payment-destination").hidden = quote.total === 0;
  });
}

function subscriptionGroupQuote(players, duration = "full") {
  const subscriptionDuration = normalizeSubscriptionDuration(duration);
  const selectedPlayers = players.filter(Boolean);
  const selectedSiblings = selectedPlayers.map(item => item.player);
  const validPlayers = selectedPlayers.map(item => {
    const walletCreditReserved = memberWalletBalance(item.player);
    const planPrice = subscriptionPrice(item.dayCount, subscriptionDuration);
    const amountBeforeDiscount = Math.max(0, planPrice - walletCreditReserved);
    const siblingDiscount = subscriptionDuration === "full"
      ? siblingDiscountForPlayer(item.player, amountBeforeDiscount, selectedSiblings)
      : 0;
    return {
      ...item,
      subscriptionDuration,
      planPrice,
      walletCreditReserved,
      siblingDiscount,
      amount: amountBeforeDiscount - siblingDiscount
    };
  });
  const subtotal = validPlayers.reduce((total, item) => total + item.amount + item.siblingDiscount, 0);
  const discount = validPlayers.reduce((total, item) => total + item.siblingDiscount, 0);
  return {
    players: validPlayers,
    subtotal,
    discount,
    total: subtotal - discount
  };
}

function subscriptionGroupSummary(quote) {
  const breakdown = quote.players.map(item =>
    `${escapeHtml(item.player.name)}: ${subscriptionDurationLabel(item.subscriptionDuration)} · سعر ${arabicDigits(item.planPrice)} ج.م − رصيد ${arabicDigits(item.walletCreditReserved)} ج.م${item.siblingDiscount ? ` − خصم إخوة ${arabicDigits(item.siblingDiscount)} ج.م` : ""} = تحويل ${arabicDigits(item.amount)} ج.م`
  ).join(" · ");
  return `الاشتراكات: ${breakdown || "اختر لاعبًا واحدًا على الأقل."}<br>إجمالي الخصم ${arabicDigits(quote.discount)} ج.م · إجمالي التحويل بعد خصم الأرصدة وخصم الإخوة: ${arabicDigits(quote.total)} ج.م.<br>خصم الإخوة ٥٠ ج.م لكل لاعب عند سداد اشتراك شهر كامل لشقيقين أو أكثر معًا على نفس باقة يومين أو ثلاثة أيام أسبوعيًا.`;
}

function trainingExerciseRows(exercises, trainers) {
  return exercises.map((exercise, index) => {
    const trainerOptions = trainers.map(trainer => `<option value="${escapeHtml(trainer.id)}" ${exercise.coachId === trainer.id ? "selected" : ""}>${escapeHtml(trainer.name)}</option>`).join("");
    const categories = new Set(exercise.categories || []);
    const categoryOptions = AGE_CATEGORIES.map(category => `<label class="day-choice"><input type="checkbox" name="categories-${index}" value="${escapeHtml(category)}" ${categories.has(category) ? "checked" : ""}><span>${escapeHtml(category)}</span></label>`).join("");
    const genderOptions = `<option value="">اختر النوع</option><option value="male" ${exercise.gender === "male" ? "selected" : ""}>ولاد</option><option value="female" ${exercise.gender === "female" ? "selected" : ""}>بنات</option><option value="all" ${exercise.gender === "all" ? "selected" : ""}>الكل</option>`;
    return `<fieldset class="training-exercise"><legend>التمرين ${arabicDigits(index + 1)}</legend><label>اسم التمرين<input name="title-${index}" required maxlength="100" value="${escapeHtml(exercise.title || "")}" placeholder="تدريب كرة السلة"></label><label>المدرب المسؤول<select name="coachId-${index}" required><option value="">اختر المدرب</option>${trainerOptions}</select></label><label>النوع<select name="gender-${index}" required>${genderOptions}</select></label><fieldset class="registration-days"><legend>الفئات العمرية لهذا التمرين</legend><div class="day-choice-grid">${categoryOptions}</div><p class="form-note">يمكن اختيار أكثر من فئة عمرية للتمرين نفسه.</p></fieldset></fieldset>`;
  }).join("");
}

function exerciseValuesFromForm(form, count) {
  const values = form instanceof FormData ? form : new FormData(form);
  return Array.from({ length: count }, (_, index) => ({
    title: String(values.get(`title-${index}`) || ""),
    coachId: String(values.get(`coachId-${index}`) || ""),
    gender: String(values.get(`gender-${index}`) || ""),
    categories: values.getAll(`categories-${index}`).map(String)
  }));
}

function openSessionForm(existingSession = null) {
  if (currentUser?.role !== "coach") { showToast("إدارة جدول التدريبات من صلاحية المشرف فقط."); return; }
  if (!data.workDays.length) { showToast("حدد أيام عمل الأكاديمية أولًا من الإعدادات."); return; }
  const trainers = data.users.filter(user => user.role === "trainer");
  if (!trainers.length) { showToast("أضف حساب مدرب من صفحة إدارة المدربين قبل إنشاء الحصة."); return; }
  const existingGroup = existingSession ? trainingGroups().find(group => group.sessions.some(session => session.id === existingSession.id)) : null;
  const sessions = existingGroup?.sessions || [];
  const session = sessions[0] || {};
  const dayOptions = dayCheckboxes(data.workDays, sessionDays(session), "sessionDays");
  const count = Math.max(sessions.length, 1);
  const exercises = sessions.length ? sessions.map(item => ({ ...item, gender: ["male", "female"].includes(item.gender) ? item.gender : "all", categories: sessionCategories(item) })) : [{ title: "", coachId: "", gender: "", categories: [] }];
  const countOptions = Array.from({ length: 12 }, (_, index) => index + 1).map(value => `<option value="${value}" ${value === count ? "selected" : ""}>${arabicDigits(value)} ${value === 1 ? "تمرين" : "تمارين"}</option>`).join("");
  const fields = `<div class="form-row session-time-row">${sessionTimePicker("time", "ساعة البداية", session.time)}${sessionTimePicker("endTime", "ساعة النهاية", session.endTime)}</div><label>عدد التمارين في هذه الساعة<select name="exerciseCount" id="training-count" required>${countOptions}</select></label><fieldset class="registration-days"><legend>أيام التدريب</legend><div class="day-choice-grid">${dayOptions}</div></fieldset><label>الملعب<input name="place" required value="${escapeHtml(session.place || "")}" placeholder="ملعب الأكاديمية"></label><div id="training-exercises">${trainingExerciseRows(exercises, trainers)}</div><p class="modal-explainer">حدد الموعد أولًا؛ كل التمارين هنا تشترك في وقت البداية والنهاية. لكل تمرين اختر نوع اللاعبين والفئات العمرية والمدرب المسؤول. يمكن إسناد المدرب نفسه لأكثر من فئة عمرية.</p>`;
  openModal(existingSession ? "تعديل ساعة التدريب وتمارينها" : "إضافة ساعة تدريب", fields, existingSession ? "حفظ التعديلات" : "إضافة الساعة والتمارين", form => saveSession(form, existingGroup?.id), "جدول التدريبات");
}

async function saveSession(form, groupId) {
  if (currentUser?.role !== "coach") { showToast("إدارة التدريب من صلاحية المشرف فقط."); return; }
  const days = form.getAll("sessionDays").map(String).filter(day => data.workDays.includes(day));
  if (!days.length) { showToast("اختر يوم تدريب واحدًا على الأقل."); return; }
  const time = selectedSessionTime(form, "time");
  const endTime = selectedSessionTime(form, "endTime");
  if (!time || !endTime) { showToast("اختر الساعة والدقيقة والفترة لوقت البداية والنهاية."); return; }
  const startsAt = sessionTimeTimestamp(time, "2000-01-01");
  const endsAt = sessionTimeTimestamp(endTime, "2000-01-01");
  if (startsAt === null || endsAt === null || endsAt <= startsAt) { showToast("أدخل وقت بداية ونهاية صحيحين، على أن تكون النهاية بعد البداية."); return; }
  const count = Number(form.get("exerciseCount"));
  if (!Number.isInteger(count) || count < 1 || count > 12) { showToast("حدد عددًا صحيحًا من التمارين بين ١ و١٢."); return; }
  const exercises = exerciseValuesFromForm(form, count);
  for (const [index, exercise] of exercises.entries()) {
    const trainer = data.users.find(user => user.id === exercise.coachId && user.role === "trainer");
    const categories = [...new Set(exercise.categories.filter(category => AGE_CATEGORIES.includes(category)))];
    if (!String(exercise.title).trim() || !trainer || !categories.length || !["male", "female", "all"].includes(exercise.gender)) {
      showToast(`أكمل اسم التمرين والمدرب والنوع وفئة عمرية واحدة على الأقل للتمرين ${arabicDigits(index + 1)}.`);
      return;
    }
  }
  const existingSessions = groupId ? trainingGroups().find(group => group.id === groupId)?.sessions || [] : [];
  if (groupId && !existingSessions.length) { showToast("لم يتم العثور على ساعة التدريب."); return; }
  const trainingGroupId = groupId && !groupId.startsWith("legacy:") ? groupId : crypto.randomUUID();
  const updatedSessions = exercises.map((exercise, index) => {
    const trainer = data.users.find(user => user.id === exercise.coachId && user.role === "trainer");
    const categories = [...new Set(exercise.categories.filter(category => AGE_CATEGORIES.includes(category)))];
    return {
      id: existingSessions[index]?.id || crypto.randomUUID(),
      trainingGroupId,
      title: String(exercise.title).trim(),
      coach: trainer.name,
      coachId: trainer.id,
      gender: exercise.gender,
      days,
      day: days[0],
      time,
      endTime,
      place: String(form.get("place")).trim(),
      categories,
      category: categories.length === 1 ? categories[0] : categories.join("، ")
    };
  });
  const removedSessions = existingSessions.slice(count);
  if (existingSessions.length) {
    const firstIndex = Math.min(...existingSessions.map(session => data.sessions.findIndex(item => item.id === session.id)));
    data.sessions = data.sessions.filter(item => !existingSessions.some(existing => existing.id === item.id));
    data.sessions.splice(firstIndex, 0, ...updatedSessions);
  } else data.sessions.push(...updatedSessions);
  if (saveData()) {
    if (removedSessions.length && cloudProfile) {
      await cloudWriteQueue;
      const firebase = await window.firebaseReady;
      await Promise.all(removedSessions.map(session => firebase.deleteRecord("sessions", session.id)));
    }
    closeModal();
    activeView = "schedule";
    renderView();
    showToast(groupId ? "تم تحديث الساعة وجميع تمارينها." : "تمت إضافة الساعة وتمارينها إلى الجدول.");
  }
}

async function deleteTrainingGroup(sessionId) {
  if (currentUser?.role !== "coach") { showToast("حذف التدريبات متاح للمشرف فقط."); return; }
  const group = trainingGroups().find(item => item.sessions.some(session => session.id === sessionId));
  if (!group) { showToast("لم يتم العثور على ساعة التدريب."); return; }
  const sessions = group.sessions;
  const first = sessions[0];
  const names = sessions.map(session => session.title).join("، ");
  if (!window.confirm(`هل تريد حذف ساعة ${sessionTimeRange(first)} وتمارينها: ${names}؟`)) return;
  data.sessions = data.sessions.filter(session => !sessions.some(item => item.id === session.id));
  if (!saveData()) {
    data.sessions.push(...sessions);
    return;
  }
  try {
    await cloudWriteQueue;
    const firebase = await window.firebaseReady;
    await Promise.all(sessions.map(session => firebase.deleteRecord("sessions", session.id)));
    renderView();
    showToast("تم حذف الساعة وجميع تمارينها من الجدول.");
  } catch (error) {
    data.sessions.push(...sessions);
    saveLocalData();
    console.error("تعذر حذف ساعة التدريب من Firestore.", error);
    showToast("تعذر حذف الساعة سحابيًا. أُعيدت بياناتها محليًا.");
  }
}

function activateSubscription(user, planId, requestedStartDate = user.expectedStartDate, duration = "full") {
  const dayCount = Number(planId);
  const subscriptionDuration = normalizeSubscriptionDuration(duration);
  const durationDetails = SUBSCRIPTION_DURATIONS[subscriptionDuration];
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) throw new Error("باقة الدفع غير صالحة لتفعيل الاشتراك.");
  const plan = priceSummary(dayCount).plan;
  const sessionAllowance = plan.sessions * durationDetails.sessionMultiplier;
  const today = localDateString();
  const startStatus = evaluateSubscriptionStartStatus(user);
  const selectedStartDate = startStatus.status === "continuous"
    ? startStatus.firstPostExpiryAttendance
    : requestedStartDate || expectedStartDateFor(user) || today;
  if (!isValidIsoDate(selectedStartDate)) throw new Error("تاريخ بداية الاشتراك غير صالح.");
  user.plan = dayCount;
  user.weeklyDaysCount = dayCount;
  if ((user.weeklyDays || []).length !== dayCount) user.weeklyDays = data.workDays.slice(0, dayCount);
  user.sessionsLeft = sessionAllowance;
  user.sessionsUsed = 0;
  const previousEndDate = user.endDate || user.subscriptionEnd;
  const extendsActiveSubscription = previousEndDate && daysUntil(previousEndDate) > 0;
  if (extendsActiveSubscription) {
    user.subscriptionStart ||= subscriptionStartDate(user) || today;
    user.expectedStartDate ||= user.subscriptionStart;
    user.endDate = addCalendarDays(previousEndDate, durationDetails.days);
    user.subscriptionEnd = user.endDate;
  } else {
    const expectedStartDate = startStatus.status === "continuous"
      ? selectedStartDate
      : selectedStartDate < today ? today : selectedStartDate;
    const earlyAttendance = data.attendance
      .filter(record => record.playerId === user.id
        && record.attendedUnpaid
        && record.status !== "غائب"
        && (startStatus.status !== "continuous" || record.isoDate > startStatus.previousEndDate)
        && record.isoDate < expectedStartDate)
      .sort((a, b) => a.isoDate.localeCompare(b.isoDate))[0];
    const actualStartDate = startStatus.status === "continuous"
      ? startStatus.firstPostExpiryAttendance
      : earlyAttendance?.isoDate || null;
    user.expectedStartDate = expectedStartDate;
    user.actualStartDate = actualStartDate;
    user.subscriptionStart = actualStartDate || expectedStartDate;
    user.endDate = addCalendarDays(actualStartDate || expectedStartDate, durationDetails.days);
    user.subscriptionEnd = user.endDate;
  }
  if (!Array.isArray(user.attendanceLogs)) user.attendanceLogs = [];
  const unpaidAttendance = data.attendance.filter(record => record.playerId === user.id && record.attendedUnpaid && record.status !== "غائب");
  user.sessionsUsed = unpaidAttendance.length;
  user.sessionsLeft = Math.max(0, sessionAllowance - unpaidAttendance.length);
  unpaidAttendance.forEach(record => { record.attendedUnpaid = false; record.chargedByPaymentAt = Date.now(); });
  return unpaidAttendance.length;
}

function confirmPayment(paymentId) {
  if (currentUser?.role !== "coach") { showToast("تأكيد التحويلات من صلاحية المشرف فقط."); return; }
  const payment = data.payments.find(item => item.id === paymentId);
  if (!payment || payment.status !== "بانتظار المراجعة") { showToast("طلب الدفع غير متاح للمراجعة."); return; }
  if (payment.method !== "instapay" || !Number.isInteger(Number(payment.planId)) || Number(payment.planId) < 1 || Number(payment.planId) > 7) {
    showToast("لا يمكن مراجعة الطلب: طريقة الدفع أو الباقة المسجلة غير صالحة.");
    return;
  }
  const user = data.users.find(item => item.id === payment.playerId);
  if (!user) { showToast("تعذر العثور على اللاعب المرتبط بطلب الدفع."); return; }
  if (!selectedSessionsForMember(user).length) { showToast("لا يمكن تفعيل الاشتراك قبل اختيار مواعيد التدريب."); return; }
  if (!canRequestPayment(user)) { showToast(`لا يمكن تفعيل تجديد ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const subscriptionDuration = normalizeSubscriptionDuration(payment.subscriptionDuration);
  const fullPrice = subscriptionPrice(payment.planId, subscriptionDuration);
  const siblingDiscount = Number(payment.siblingDiscount || 0);
  const paymentGroupPlayers = playersForPaymentGroup(payment, user);
  const reservedWalletCredit = Number.isInteger(Number(payment.walletCreditReserved))
    ? Math.max(0, Number(payment.walletCreditReserved))
    : memberWalletBalance(user);
  const requiredAmount = Math.max(0, fullPrice - siblingDiscount);
  const initialReceivedAmount = Math.max(0, Number(payment.amount) || 0);
  if (siblingDiscount < 0 || siblingDiscount > SIBLING_DISCOUNT_PER_PLAYER || !Number.isInteger(siblingDiscount)) {
    showToast("قيمة خصم الإخوة المسجلة غير صالحة؛ راجع الطلب قبل تأكيده.");
    return;
  }
  openModal(`مراجعة تحويل ${user.name}`, `<p class="modal-explainer">${escapeHtml(subscriptionDurationLabel(subscriptionDuration))} · سعر الاشتراك ${arabicDigits(fullPrice)} ج.م${siblingDiscount ? `، وخصم الإخوة ${arabicDigits(siblingDiscount)} ج.م` : ""}، ورصيد المحفظة المحجوز ${arabicDigits(reservedWalletCredit)} ج.م. المبلغ المتوقع تحويله بعد الخصومات والأرصدة: ${arabicDigits(Math.max(0, requiredAmount - reservedWalletCredit))} ج.م. أي زيادة مؤكدة تُضاف إلى محفظة اللاعب.</p><label>المبلغ المحوّل فعليًا<input name="receivedAmount" type="number" min="0" max="1000000" step="0.01" value="${initialReceivedAmount}" data-plan-id="${Number(payment.planId)}" data-duration="${subscriptionDuration}" data-wallet-credit="${reservedWalletCredit}" placeholder="المبلغ الظاهر في إثبات التحويل" required></label><fieldset class="registration-days" id="instapay-shortage-options" hidden><legend>المبلغ ورصيد المحفظة أقل من المستحق بعد الخصم — اختر طريقة المعالجة</legend><label class="day-choice"><input type="radio" name="instapayShortageResolution" value="debt"><span>البقاء على نفس الباقة وتسجيل الباقي كرصيد مستحق (محدد تلقائيًا)</span></label><label class="day-choice"><input type="radio" name="instapayShortageResolution" value="downgrade"><span>الانتقال إلى أعلى باقة أدنى يغطيها المبلغ ورصيد المحفظة</span></label><small id="instapay-downgrade-note" hidden>المبلغ ورصيد المحفظة لا يكفيان لأي باقة أدنى؛ سيُسجل الفرق رصيدًا مستحقًا.</small></fieldset>`, "تأكيد المبلغ وتفعيل الاشتراك", form => applyPaymentConfirmation(form, payment.id), "تأكيد التحويلات");
  const form = byId("action-form");
  form.querySelector('input[name="receivedAmount"]').addEventListener("input", () => updateInstaPayShortageOptions(form, requiredAmount, Number(payment.planId), subscriptionDuration));
  updateInstaPayShortageOptions(form, requiredAmount, Number(payment.planId), subscriptionDuration);
}

function updateInstaPayShortageOptions(form, fullPrice, requestedDayCount, duration = "full") {
  const options = form.querySelector("#instapay-shortage-options");
  const amountInput = form.querySelector('input[name="receivedAmount"]');
  const amount = amountInput.value === "" ? Number.NaN : Number(amountInput.value);
  const walletCredit = Math.max(0, Number(amountInput.dataset.walletCredit) || 0);
  const availableAmount = amount + walletCredit;
  const requiresResolution = isValidCurrencyAmount(amount) && amount >= 0 && availableAmount < fullPrice;
  const dayCount = Number(requestedDayCount ?? amountInput.dataset.planId);
  const subscriptionDuration = normalizeSubscriptionDuration(duration);
  const downgrade = options.querySelector('input[name="instapayShortageResolution"][value="downgrade"]');
  const canDowngrade = Object.keys(DEFAULT_DAY_PRICES).map(Number)
    .some(candidateDayCount => candidateDayCount < dayCount
      && subscriptionPrice(candidateDayCount, subscriptionDuration) <= availableAmount);
  downgrade.disabled = requiresResolution && !canDowngrade;
  options.querySelector("#instapay-downgrade-note").hidden = !requiresResolution || canDowngrade;
  options.hidden = !requiresResolution;
  const resolutionInputs = [...options.querySelectorAll('input[name="instapayShortageResolution"]')];
  if (requiresResolution && (downgrade.disabled || !resolutionInputs.some(input => input.checked))) {
    options.querySelector('input[name="instapayShortageResolution"][value="debt"]').checked = true;
  }
  resolutionInputs.forEach(input => {
    input.required = requiresResolution && !input.disabled;
    if (!requiresResolution) input.checked = false;
  });
}

function rejectPaymentForResubmission(paymentId) {
  if (currentUser?.role !== "coach") { showToast("إدارة طلبات الدفع متاحة للمشرف فقط."); return; }
  const payment = data.payments.find(item => item.id === paymentId && item.status === "بانتظار المراجعة");
  if (!payment) { showToast("طلب الدفع غير متاح."); return; }
  if (!window.confirm("سيُرفض هذا الطلب غير المطابق للسعر الكامل، ويمكن لولي الأمر إرسال طلب جديد بالسعر الصحيح. هل تريد المتابعة؟")) return;
  const previousStatus = payment.status;
  payment.status = "مرفوض — يلزم إعادة الطلب بالسعر الكامل";
  payment.reviewedAt = Date.now();
  if (saveData()) {
    renderView();
    showToast("تم رفض الطلب. يمكن لولي الأمر الآن إرساله مجددًا بالسعر الكامل.");
  } else {
    payment.status = previousStatus;
    delete payment.reviewedAt;
  }
}

function applyPaymentConfirmation(form, paymentId) {
  if (currentUser?.role !== "coach") { showToast("تأكيد التحويلات من صلاحية المشرف فقط."); return; }
  const payment = data.payments.find(item => item.id === paymentId && item.status === "بانتظار المراجعة");
  const user = payment && data.users.find(item => item.id === payment.playerId);
  const receivedAmount = Number(form.get("receivedAmount"));
  if (!payment || !user) { showToast("طلب الدفع أو اللاعب غير متاح."); return; }
  if (payment.method !== "instapay" || !Number.isInteger(Number(payment.planId)) || Number(payment.planId) < 1 || Number(payment.planId) > 7) {
    showToast("لا يمكن تأكيد الطلب: طريقة الدفع أو الباقة المسجلة غير صالحة.");
    return;
  }
  const requestedDayCount = Number(payment.planId);
  const subscriptionDuration = normalizeSubscriptionDuration(payment.subscriptionDuration);
  const requestedPrice = subscriptionPrice(requestedDayCount, subscriptionDuration);
  const paymentGroupPlayers = playersForPaymentGroup(payment, user);
  const walletBalance = memberWalletBalance(user);
  const reservedWalletCredit = payment.walletCreditReserved === undefined
    ? walletBalance
    : Number(payment.walletCreditReserved);
  if (!Number.isInteger(reservedWalletCredit) || reservedWalletCredit < 0 || reservedWalletCredit > walletBalance) {
    showToast("تغير رصيد محفظة اللاعب أثناء مراجعة الطلب. أعد تحميل البيانات ثم راجع الطلب مجددًا.");
    return;
  }
  const siblingDiscount = Number(payment.siblingDiscount || 0);
  if (!Number.isInteger(siblingDiscount) || siblingDiscount < 0 || siblingDiscount > SIBLING_DISCOUNT_PER_PLAYER
    || (subscriptionDuration === "half" && siblingDiscount > 0)
    || (payment.siblingDiscount !== undefined
      && siblingDiscount !== (subscriptionDuration === "half"
        ? 0
        : siblingDiscountForPlayer(user, Math.max(0, requestedPrice - reservedWalletCredit), paymentGroupPlayers)))) {
    showToast("تغير استحقاق خصم الإخوة منذ إرسال الطلب. أعد مراجعته مع ولي الأمر.");
    return;
  }
  const requiredAmount = Math.max(0, requestedPrice - siblingDiscount);
  if (!isValidCurrencyAmount(receivedAmount) || receivedAmount < 0 || receivedAmount > 1000000) {
    showToast("أدخل مبلغًا صحيحًا من صفر إلى مليون جنيه.");
    return;
  }
  const totalAvailable = receivedAmount + reservedWalletCredit;
  if (!canRequestPayment(user)) { showToast(`لا يمكن تفعيل تجديد ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const shortageResolution = String(form.get("instapayShortageResolution") || (totalAvailable < requiredAmount ? "debt" : ""));
  if (totalAvailable < requiredAmount && !["debt", "downgrade"].includes(shortageResolution)) {
    showToast("اختر تسجيل الفرق كمديونية أو تخفيض الباقة قبل تأكيد المبلغ الناقص.");
    return;
  }
  let planDayCount = requestedDayCount;
  let plan = priceSummary(planDayCount).plan;
  let appliedSiblingDiscount = siblingDiscount;
  let debtAddedAmount = 0;
  if (totalAvailable < requiredAmount && shortageResolution === "debt") {
    debtAddedAmount = requiredAmount - totalAvailable;
  } else if (totalAvailable < requiredAmount && shortageResolution === "downgrade") {
    const affordablePlans = Object.keys(DEFAULT_DAY_PRICES).map(Number)
      .filter(dayCount => dayCount < requestedDayCount
        && subscriptionPrice(dayCount, subscriptionDuration) <= totalAvailable)
      .sort((a, b) => b - a);
    planDayCount = affordablePlans[0] || 0;
    if (!planDayCount) {
      showToast(`المبلغ لا يكفي لأقل باقة أدنى من المطلوبة (${arabicDigits(priceSummary(1).plan.price)} ج.م).`);
      return;
    }
    plan = priceSummary(planDayCount).plan;
    appliedSiblingDiscount = 0;
  }
  const selectedIds = Array.isArray(user.selectedSessionIds) ? user.selectedSessionIds : [];
  const chosenSessions = sessionsForMember(user).filter(session => selectedIds.includes(session.id));
  const priorDays = user.weeklyDays || [];
  const preferredDays = [
    ...data.workDays.filter(day => priorDays.includes(day) && chosenSessions.some(session => sessionDays(session).includes(day))),
    ...data.workDays.filter(day => chosenSessions.some(session => sessionDays(session).includes(day))),
    ...priorDays,
    ...data.workDays
  ];
  const assignedDays = [...new Set(preferredDays)].slice(0, planDayCount);
  if (assignedDays.length !== planDayCount || !chosenSessions.some(session => sessionDays(session).some(day => assignedDays.includes(day)))) {
    showToast("لا توجد مواعيد مختارة تناسب الباقة المطلوبة. حدّث مواعيد اللاعب أولًا.");
    return;
  }
  const previousPayment = { ...payment };
  const previousUser = {
    ...user,
    weeklyDays: [...priorDays],
    selectedSessionIds: [...(user.selectedSessionIds || [])],
    attendanceLogs: [...(user.attendanceLogs || [])]
  };
  const replacedPayments = data.payments.filter(item => item.playerId === user.id && item.id !== payment.id && item.status === "بانتظار المراجعة").map(item => ({ payment: item, status: item.status }));
  const previousAttendance = data.attendance.filter(record => record.playerId === user.id && record.attendedUnpaid).map(record => ({ record, chargedByPaymentAt: record.chargedByPaymentAt }));
  user.weeklyDays = assignedDays;
  user.weeklyDaysCount = assignedDays.length;
  user.plan = assignedDays.length;
  if (debtAddedAmount) user.cashDebt = Math.max(0, Number(user.cashDebt || 0)) + debtAddedAmount;
  payment.amount = receivedAmount;
  const discountedPlanPrice = Math.max(0, subscriptionPrice(planDayCount, subscriptionDuration) - appliedSiblingDiscount);
  payment.walletCreditUsedAmount = Math.min(reservedWalletCredit, Math.max(0, discountedPlanPrice - receivedAmount));
  payment.walletCreditAddedAmount = Math.max(0, receivedAmount - discountedPlanPrice);
  user.walletBalance = Math.max(0, walletBalance - payment.walletCreditUsedAmount) + payment.walletCreditAddedAmount;
  payment.originalPlanId = requestedDayCount;
  payment.originalPlanName = priceSummary(requestedDayCount).plan.name;
  payment.planId = assignedDays.length;
  payment.planName = plan.name;
  payment.subscriptionDuration = subscriptionDuration;
  if (appliedSiblingDiscount) payment.siblingDiscount = appliedSiblingDiscount;
  else delete payment.siblingDiscount;
  if (debtAddedAmount) {
    payment.debtAddedAmount = debtAddedAmount;
    payment.instapayShortageResolution = "debt";
  } else if (shortageResolution === "downgrade") {
    payment.instapayShortageResolution = "downgrade";
  }
  payment.status = "تم التأكيد";
  payment.confirmedAt = Date.now();
  payment.paidTime = new Date(payment.confirmedAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  payment.date = egyptianDate.format(new Date(payment.confirmedAt));
  replacedPayments.forEach(item => { item.payment.status = "تم استبداله بدفعة مؤكدة أخرى"; });
  let chargedAttendance = 0;
  try {
    chargedAttendance = activateSubscription(
      user,
      assignedDays.length,
      payment.expectedStartDate || localDateString(),
      payment.subscriptionDuration
    );
  } catch (error) {
    Object.assign(payment, previousPayment);
    Object.assign(user, previousUser);
    replacedPayments.forEach(item => { item.payment.status = item.status; });
    previousAttendance.forEach(item => { item.record.attendedUnpaid = true; delete item.record.chargedByPaymentAt; });
    showToast(error.message);
    return;
  }
  if (saveData()) {
    closeModal();
    renderView();
    const debtNotice = debtAddedAmount ? ` وسُجل الفرق ${arabicDigits(debtAddedAmount)} ج.م كمديونية` : "";
    const downgradeNotice = shortageResolution === "downgrade" ? ` بعد تخفيض الباقة إلى ${plan.name}` : "";
    const walletNotice = [
      payment.walletCreditUsedAmount ? `استُخدم ${arabicDigits(payment.walletCreditUsedAmount)} ج.م من رصيد المحفظة` : "",
      payment.walletCreditAddedAmount ? `أُضيف ${arabicDigits(payment.walletCreditAddedAmount)} ج.م إلى رصيد المحفظة` : ""
    ].filter(Boolean).join(" و");
    showToast(`تم تأكيد تحويل ${arabicDigits(receivedAmount)} ج.م وتفعيل باقة ${plan.name}${debtNotice}${downgradeNotice}${walletNotice}، وخصم ${arabicDigits(chargedAttendance)} تدريب سابق غير مدفوع.`);
  } else {
    Object.assign(payment, previousPayment);
    Object.assign(user, previousUser);
    replacedPayments.forEach(item => { item.payment.status = item.status; });
    previousAttendance.forEach(item => {
      item.record.attendedUnpaid = true;
      if (item.chargedByPaymentAt === undefined) delete item.record.chargedByPaymentAt;
      else item.record.chargedByPaymentAt = item.chargedByPaymentAt;
    });
  }
}

function playersForPaymentGroup(payment, user) {
  if (!payment.paymentGroupId) return [];
  return data.payments
    .filter(item => item.paymentGroupId === payment.paymentGroupId && item.guardianId === user.guardianId)
    .map(item => data.users.find(candidate => candidate.id === item.playerId))
    .filter(Boolean);
}

function cashPaymentDetails(user, duration = cashPartialDuration(user)) {
  const dayCount = user.weeklyDays?.length || user.weeklyDaysCount;
  const plan = priceSummary(dayCount).plan;
  const walletBalance = memberWalletBalance(user);
  const subscriptionDuration = normalizeSubscriptionDuration(duration);
  const partialPayments = data.payments.filter(item => item.playerId === user.id
    && item.planId === dayCount
    && ["دفع جزئي نقدًا", "تم تطبيق خصم إخوة"].includes(item.status)
    && normalizeSubscriptionDuration(item.subscriptionDuration) === subscriptionDuration);
  const previousCashPaid = partialPayments.reduce((total, item) => total + Number(item.amount || 0), 0);
  const previousSiblingDiscount = partialPayments.reduce((total, item) => total + Number(item.siblingDiscount || 0), 0);
  return {
    subscriptionDuration,
    subscriptionPrice: subscriptionPrice(dayCount, subscriptionDuration),
    dayCount,
    plan,
    walletBalance,
    partialPayments,
    previousCashPaid,
    previousSiblingDiscount,
    remainingAmount: Math.max(0, subscriptionPrice(dayCount, subscriptionDuration) - previousCashPaid - previousSiblingDiscount - walletBalance),
    pendingPayments: data.payments.filter(item => item.playerId === user.id && item.status === "بانتظار المراجعة")
  };
}

function cashPartialDuration(user) {
  const existingPartialPayment = data.payments.find(item => item.playerId === user.id && item.status === "دفع جزئي نقدًا");
  return normalizeSubscriptionDuration(existingPartialPayment?.subscriptionDuration);
}

function cashPaymentEligibility(user) {
  const details = cashPaymentDetails(user);
  return selectedSessionsForMember(user).length > 0 && canRequestPayment(user)
    && (details.remainingAmount > 0 || details.walletBalance > 0);
}

function siblingDiscountForPlayer(user, eligibleAmount, selectedPlayers = []) {
  return siblingDiscountEligible(selectedPlayers, user.guardianId)
    ? Math.min(SIBLING_DISCOUNT_PER_PLAYER, Math.max(0, eligibleAmount))
    : 0;
}

function siblingDiscountEligible(players, guardianId = players[0]?.guardianId) {
  if (!guardianId) return false;
  const siblings = [...new Map(players
    .filter(player => player?.id && player.guardianId === guardianId)
    .map(player => [player.id, player])).values()];
  if (siblings.length < 2) return false;
  const dayCounts = siblings.map(player => Number(player.weeklyDays?.length || player.weeklyDaysCount));
  return dayCounts.every(dayCount => dayCount === 2 || dayCount === 3)
    && dayCounts.every(dayCount => dayCount === dayCounts[0]);
}

function cashPaymentQuote(players, duration = players[0] ? cashPartialDuration(players[0]) : "full") {
  const subscriptionDuration = normalizeSubscriptionDuration(duration);
  const payingTogether = siblingDiscountEligible(players);
  const balances = players.map(user => {
    const partialDuration = cashPartialDuration(user);
    if (hasPartialCashPayment(user) && partialDuration !== subscriptionDuration) {
      throw new Error(`مدة اشتراك ${user.name} لا تطابق مدة الدفعة الجزئية السابقة.`);
    }
    const details = cashPaymentDetails(user, subscriptionDuration);
    const previousSiblingDiscount = data.payments
      .filter(payment => payment.playerId === user.id
        && ["دفع جزئي نقدًا", "تم تطبيق خصم إخوة"].includes(payment.status))
      .reduce((total, payment) => total + Number(payment.siblingDiscount || 0), 0);
    const siblingDiscount = subscriptionDuration === "full" && payingTogether
      ? Math.min(
        Math.max(0, SIBLING_DISCOUNT_PER_PLAYER - previousSiblingDiscount),
        details.remainingAmount
      )
      : 0;
    const remainingAmount = Math.max(0,
      subscriptionPrice(details.dayCount, subscriptionDuration)
        - details.previousCashPaid - details.previousSiblingDiscount - details.walletBalance
    );
    return { user, ...details, remainingAmount, siblingDiscount };
  });
  const baseTotal = balances.reduce((total, item) => total + item.remainingAmount, 0);
  const discount = balances.reduce((total, item) => total + item.siblingDiscount, 0);
  return { balances, baseTotal, discount, total: baseTotal - discount };
}

function updateCashShortageOptions(form, total, duration = "full") {
  const options = form.querySelector("#cash-shortage-options");
  const amountInput = form.querySelector('input[name="amount"]');
  const normalizedDuration = normalizeSubscriptionDuration(duration);
  const specialDiscountOption = form.querySelector("#cash-special-discount-option");
  const specialDiscountInput = specialDiscountOption.querySelector("input");
  specialDiscountOption.hidden = normalizedDuration === "half";
  specialDiscountInput.disabled = normalizedDuration === "half";
  if (specialDiscountInput.disabled) specialDiscountInput.checked = false;
  const requiresResolution = Number(amountInput.value) < total;
  options.hidden = !requiresResolution;
  const resolutionInputs = [...options.querySelectorAll('input[name="shortageResolution"]')];
  if (requiresResolution && !resolutionInputs.some(input => input.checked && !input.disabled)) {
    options.querySelector('input[name="shortageResolution"][value="debt"]').checked = true;
  }
  resolutionInputs.forEach(input => {
    input.required = requiresResolution && !input.disabled;
    if (!requiresResolution) input.checked = false;
  });
}

function recordCashPayment(playerId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الدفع النقدي من صلاحية المشرف فقط."); return; }
  const user = data.users.find(item => item.id === playerId && item.role === "member");
  if (!user) { showToast("لم يتم العثور على اللاعب."); return; }
  if (!selectedSessionsForMember(user).length) { showToast("اطلب من اللاعب اختيار مواعيد التدريب قبل تسجيل الدفع وتفعيل الاشتراك."); return; }
  if (!canRequestPayment(user)) { showToast(`لا يمكن تجديد اشتراك ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const details = cashPaymentDetails(user);
  if (!details.remainingAmount && !details.walletBalance) { showToast("اكتمل مبلغ الاشتراك نقدًا بالفعل. لا يمكن تسجيل دفعة أخرى له."); return; }
  const siblings = data.users.filter(item => item.role === "member" && item.guardianId === user.guardianId);
  const selectablePlayers = siblings.length ? siblings : [user];
  const subscriptionDuration = cashPartialDuration(user);
  const renderCashPlayerOptions = (duration, selectedIds) => {
    const selectedPlayers = [...selectedIds]
      .map(id => selectablePlayers.find(candidate => candidate.id === id))
      .filter(Boolean);
    return selectablePlayers.map(sibling => {
      const siblingDetails = cashPaymentDetails(sibling);
      const isEligible = cashPaymentEligibility(sibling);
      const partialDurationMismatch = hasPartialCashPayment(sibling) && siblingDetails.subscriptionDuration !== duration;
      const planPrice = subscriptionPrice(siblingDetails.dayCount, duration);
      const previousPaid = partialDurationMismatch ? 0 : siblingDetails.previousCashPaid;
      const beforeDiscount = Math.max(0,
        planPrice - previousPaid
        - (partialDurationMismatch ? 0 : siblingDetails.previousSiblingDiscount)
        - siblingDetails.walletBalance
      );
      const discount = duration === "full"
        ? Math.min(
          Math.max(0, SIBLING_DISCOUNT_PER_PLAYER - siblingDetails.previousSiblingDiscount),
          beforeDiscount,
          siblingDiscountForPlayer(sibling, beforeDiscount, selectedPlayers)
        )
        : 0;
      const remaining = Math.max(0, beforeDiscount - discount);
      const description = `${siblingDetails.plan.name} · ${subscriptionDurationLabel(duration)} · المستحق ${arabicDigits(remaining)} ج.م · رصيد ${arabicDigits(siblingDetails.walletBalance)} ج.م${discount ? ` · خصم إخوة ${arabicDigits(discount)} ج.م` : ""}${partialDurationMismatch ? " · مدة الدفعة الجزئية السابقة مختلفة" : ""}${isEligible ? "" : " · غير متاح للدفع حاليًا"}`;
      const checked = selectedIds.has(sibling.id) && !partialDurationMismatch;
      const disabled = !isEligible || partialDurationMismatch;
      return `<div class="cash-sibling-option"><label class="cash-sibling-choice"><input type="checkbox" name="playerIds" value="${escapeHtml(sibling.id)}" ${checked ? "checked" : ""} ${sibling.id === user.id ? "data-primary-player" : ""} ${disabled ? "disabled" : ""}><span><strong>${escapeHtml(sibling.name)}</strong><small>${escapeHtml(description)}${isEligible && !partialDurationMismatch ? " · تاريخ البداية يحدده أقرب تمرين متاح تلقائيًا" : ""}</small></span></label></div>`;
    }).join("");
  };
  const quote = cashPaymentQuote([user], subscriptionDuration);
  const discountMessage = subscriptionDuration === "half"
    ? "اشتراك نصف شهر؛ لا تنطبق عليه أي خصومات."
    : quote.discount
      ? `تم احتساب خصم إخوة ${arabicDigits(quote.discount)} ج.م لهذا اللاعب.`
      : `يُطبق خصم ${arabicDigits(SIBLING_DISCOUNT_PER_PLAYER)} ج.م لكل ابن عند تسجيل اشتراك ابنين أو أكثر معًا على نفس باقة يومين أو ثلاثة أيام أسبوعيًا.`;
  const now = new Date();
  const paidDate = localDateString(now);
  const paidTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal(`تسجيل دفع نقدي · ${user.name}`, `<label>مدة الاشتراك<select name="subscriptionDuration" ${hasPartialCashPayment(user) ? "disabled" : ""} required><option value="full" ${subscriptionDuration === "full" ? "selected" : ""}>شهر كامل — السعر الشهري</option><option value="half" ${subscriptionDuration === "half" ? "selected" : ""}>نصف شهر — ٥٠٪ من السعر، دون خصومات</option></select></label><fieldset class="cash-sibling-list" id="cash-player-options"><legend>اللاعبون الذين يسددون معًا</legend>${renderCashPlayerOptions(subscriptionDuration, new Set([user.id]))}</fieldset><p class="modal-explainer" id="cash-payment-summary">إجمالي المستحق ${subscriptionDurationLabel(subscriptionDuration)} بعد رصيد المحفظة والخصومات: ${arabicDigits(quote.total)} ج.م. ${discountMessage}</p><label>المبلغ النقدي المستلم<input name="amount" type="number" min="${quote.total ? 0.01 : 0}" max="${quote.total}" step="0.01" value="${quote.total}" required></label><fieldset class="registration-days" id="cash-shortage-options" hidden><legend>المبلغ أقل من المستحق — حدد معالجة الفرق</legend><label class="day-choice" id="cash-special-discount-option"><input type="radio" name="shortageResolution" value="discount"><span>نفس الباقة، واعتبار الفرق خصمًا استثنائيًا دون رصيد مستحق</span></label><label class="day-choice"><input type="radio" name="shortageResolution" value="debt"><span>نفس الباقة، وتسجيل الباقي كرصيد مستحق (محدد تلقائيًا)</span></label><label class="day-choice"><input type="radio" name="shortageResolution" value="downgrade"><span>تخفيض الباقة إلى أعلى باقة يغطيها المبلغ المقبوض ورصيد المحفظة</span></label></fieldset><div class="form-row"><label>تاريخ الدفع<input name="paidDate" type="date" max="${localDateString()}" value="${paidDate}" required></label><label>ساعة الدفع<input name="paidTime" type="time" value="${paidTime}" required></label></div>`, "تسجيل الدفع النقدي", form => saveCashPayment(form, user.id), "المدفوعات");
  const form = byId("action-form");
  form.addEventListener("change", event => {
    const duration = normalizeSubscriptionDuration(form.querySelector('select[name="subscriptionDuration"]').value);
    if (event.target instanceof HTMLSelectElement && event.target.name === "subscriptionDuration") {
      const selectedIds = new Set([...form.querySelectorAll('input[name="playerIds"]:checked')].map(input => input.value));
      selectedIds.add(user.id);
      byId("cash-player-options").innerHTML = `<legend>اللاعبون الذين يسددون معًا</legend>${renderCashPlayerOptions(duration, selectedIds)}`;
    } else if (!(event.target instanceof HTMLInputElement) || event.target.name !== "playerIds") return;
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute("data-primary-player") && !event.target.checked) {
      event.target.checked = true;
      return;
    }
    const selected = [...form.querySelectorAll('input[name="playerIds"]:checked')]
      .map(input => data.users.find(item => item.id === input.value && item.role === "member"))
      .filter(Boolean);
    const selectedIds = new Set(selected.map(item => item.id));
    byId("cash-player-options").innerHTML = `<legend>اللاعبون الذين يسددون معًا</legend>${renderCashPlayerOptions(duration, selectedIds)}`;
    const updatedQuote = cashPaymentQuote(selected, duration);
    const amountInput = form.querySelector('input[name="amount"]');
    const summary = byId("cash-payment-summary");
    amountInput.min = updatedQuote.total ? "0.01" : "0";
    amountInput.max = String(updatedQuote.total);
    amountInput.value = String(updatedQuote.total);
    summary.textContent = `إجمالي المستحق ${subscriptionDurationLabel(duration)} بعد الرصيد والخصومات: ${arabicDigits(updatedQuote.total)} ج.م. ${duration === "half" ? "نصف الشهر مستثنى من جميع الخصومات." : updatedQuote.discount ? `يشمل خصم إخوة ${arabicDigits(updatedQuote.discount)} ج.م، بواقع ٥٠ ج.م لكل لاعب مؤهل.` : "لا ينطبق خصم إخوة على الاختيار الحالي."}`;
    updateCashShortageOptions(form, updatedQuote.total, duration);
  });
  form.querySelector('input[name="amount"]').addEventListener("input", () => {
    const selected = [...form.querySelectorAll('input[name="playerIds"]:checked')]
      .map(input => data.users.find(item => item.id === input.value && item.role === "member"))
      .filter(Boolean);
    const duration = normalizeSubscriptionDuration(form.querySelector('select[name="subscriptionDuration"]').value);
    updateCashShortageOptions(form, cashPaymentQuote(selected, duration).total, duration);
  });
}

function saveCashPayment(form, playerId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الدفع النقدي من صلاحية المشرف فقط."); return; }
  const primaryPlayer = data.users.find(item => item.id === playerId && item.role === "member");
  if (!primaryPlayer) { showToast("لم يتم العثور على اللاعب."); return; }
  const selectedIds = [...new Set(form.getAll("playerIds").map(String))];
  const selectedPlayers = selectedIds.map(id => data.users.find(item => item.id === id && item.role === "member")).filter(Boolean);
  if (!selectedPlayers.some(item => item.id === primaryPlayer.id) || selectedPlayers.length !== selectedIds.length) {
    showToast("تأكد من اختيار اللاعب الأساسي وأفراد الأسرة المسجلين فقط.");
    return;
  }
  if (selectedPlayers.some(item => item.guardianId !== primaryPlayer.guardianId)) {
    showToast("يمكن تسجيل الدفع الجماعي لأبناء ولي الأمر نفسه فقط.");
    return;
  }
  const unavailablePlayer = selectedPlayers.find(item => !cashPaymentEligibility(item));
  if (unavailablePlayer) {
    showToast(`لا يمكن تسجيل دفع ${unavailablePlayer.name} قبل اختيار المواعيد أو موعد التجديد.`);
    return;
  }
  const subscriptionDuration = normalizeSubscriptionDuration(form.get("subscriptionDuration"));
  let quote;
  try {
    quote = cashPaymentQuote(selectedPlayers, subscriptionDuration);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "تعذر احتساب المبلغ المستحق.");
    return;
  }
  const { balances, total, discount } = quote;
  const amount = Number(form.get("amount"));
  const shortageResolution = String(form.get("shortageResolution") || (amount < total ? "debt" : ""));
  const paidDate = String(form.get("paidDate"));
  const paidTime = String(form.get("paidTime"));
  const confirmedAt = new Date(`${paidDate}T${paidTime}:00`).getTime();
  if (!Number.isFinite(confirmedAt) || paidDate > localDateString() || !isValidCurrencyAmount(amount) || amount < 0 || (amount === 0 && total > 0) || amount > total) {
    showToast("راجع المبلغ النقدي والتاريخ والوقت، ولا تدخل مبلغًا أكبر من إجمالي المستحق.");
    return;
  }
  if (subscriptionDuration === "half" && shortageResolution === "discount") {
    showToast("اشتراك نصف الشهر مستثنى من الخصومات الاستثنائية.");
    return;
  }
  if (amount < total && !["discount", "debt", "downgrade"].includes(shortageResolution)) {
    showToast("اختر طريقة معالجة المبلغ المتبقي قبل تسجيل الدفع النقدي.");
    return;
  }
  const siblingDiscount = discount;
  let remainingAmount = amount;
  const allocations = balances.map(balance => {
    const discountAmount = balance.siblingDiscount;
    const due = balance.remainingAmount - discountAmount;
    const paid = Math.min(due, remainingAmount);
    remainingAmount -= paid;
    return {
      ...balance,
      discountAmount,
      paid,
      completesSubscription: paid === due || ["discount", "debt", "downgrade"].includes(shortageResolution),
      shortageResolution: paid === due ? "" : shortageResolution,
      expectedStartDate: paid === due || ["discount", "debt", "downgrade"].includes(shortageResolution)
        ? automaticSubscriptionStartDate(balance.user)
        : expectedStartDateFor(balance.user)
    };
  });
  const previousUsers = JSON.parse(JSON.stringify(data.users));
  const previousPayments = JSON.parse(JSON.stringify(data.payments));
  const previousAttendance = JSON.parse(JSON.stringify(data.attendance));
  try {
    allocations.forEach(allocation => {
    const { user, dayCount, plan, partialPayments, pendingPayments: pending, paid, discountAmount, completesSubscription, expectedStartDate, shortageResolution } = allocation;
    let activatedPlan = plan;
    let targetDays = user.weeklyDays || [];
    let specialDiscountAmount = 0;
    let debtAddedAmount = 0;
    if (shortageResolution === "downgrade") {
      activatedPlan = planForAmount(
        (paid + allocation.previousCashPaid + allocation.walletBalance
        + allocation.previousSiblingDiscount + discountAmount
        ) / SUBSCRIPTION_DURATIONS[subscriptionDuration].sessionMultiplier
      );
      if (!activatedPlan || activatedPlan.price >= plan.price) {
        throw new Error(`المبلغ المسجل ورصيد المحفظة لـ${user.name} لا يكفيان لتخفيض الاشتراك إلى باقة أقل. سجّل مبلغًا أعلى أو اختر الخصم/المديونية.`);
      }
      const chosenSessions = sessionsForMember(user).filter(session => (user.selectedSessionIds || []).includes(session.id));
      const priorDays = user.weeklyDays || [];
      const preferredDays = [
        ...data.workDays.filter(day => priorDays.includes(day) && chosenSessions.some(session => sessionDays(session).includes(day))),
        ...data.workDays.filter(day => chosenSessions.some(session => sessionDays(session).includes(day))),
        ...priorDays,
        ...data.workDays
      ];
      targetDays = [...new Set(preferredDays)].slice(0, activatedPlan.sessions / 4);
      if (targetDays.length !== activatedPlan.sessions / 4 || !chosenSessions.some(session => sessionDays(session).some(day => targetDays.includes(day)))) {
        throw new Error(`لا توجد مواعيد تدريب مناسبة لتفعيل الباقة المخفضة لـ${user.name}.`);
      }
      user.weeklyDays = targetDays;
      user.weeklyDaysCount = targetDays.length;
      user.selectedSessionIds = chosenSessions.map(session => session.id);
    } else if (shortageResolution === "discount") {
      specialDiscountAmount = Math.max(0, allocation.remainingAmount - paid - discountAmount);
    } else if (shortageResolution === "debt") {
      debtAddedAmount = Math.max(0, allocation.remainingAmount - paid - discountAmount);
      user.cashDebt = Math.max(0, Number(user.cashDebt || 0)) + debtAddedAmount;
    }
    if (completesSubscription) {
      const dueAfterDiscount = Math.max(0,
        subscriptionPrice(activatedPlan.sessions / 4, subscriptionDuration)
        - allocation.previousSiblingDiscount - discountAmount
      );
      allocation.walletCreditUsedAmount = Math.min(
        allocation.walletBalance,
        Math.max(0, dueAfterDiscount - allocation.previousCashPaid - paid)
      );
      const creditAfterApplication = allocation.walletBalance - allocation.walletCreditUsedAmount;
      const cashOverpayment = Math.max(0,
        allocation.previousCashPaid + paid - dueAfterDiscount
      );
      user.walletBalance = creditAfterApplication + cashOverpayment;
      allocation.walletCreditAddedAmount = Math.max(0, user.walletBalance - creditAfterApplication);
    }
    pending.forEach(item => { item.status = "تم استبداله بدفعة نقدية"; });
    if (completesSubscription) partialPayments.forEach(item => { item.status = "تم استكمال الدفع النقدي"; });
    if (paid > 0 || discountAmount > 0 || specialDiscountAmount > 0 || debtAddedAmount > 0 || allocation.walletCreditUsedAmount > 0) {
      const payment = {
        id: crypto.randomUUID(), playerId: user.id, playerName: user.name, planId: shortageResolution === "downgrade" ? activatedPlan.sessions / 4 : dayCount,
        subscriptionDuration,
        expectedStartDate,
        planName: activatedPlan.name, amount: paid, ...(discountAmount ? { siblingDiscount: discountAmount } : {}),
        ...(specialDiscountAmount ? { specialDiscountAmount } : {}),
        ...(debtAddedAmount ? { debtAddedAmount } : {}),
        ...(allocation.walletCreditUsedAmount ? { walletCreditUsedAmount: allocation.walletCreditUsedAmount } : {}),
        ...(allocation.walletCreditAddedAmount ? { walletCreditAddedAmount: allocation.walletCreditAddedAmount } : {}),
        ...(shortageResolution ? { cashShortageResolution: shortageResolution } : {}),
        ...(shortageResolution === "downgrade" ? { originalPlanId: dayCount, originalPlanName: plan.name } : {}),
        reference: "دفع نقدي في الأكاديمية",
        method: "cash", methodLabel: "نقدي", status: completesSubscription ? "تم الدفع نقدًا" : paid > 0 ? "دفع جزئي نقدًا" : discountAmount ? "تم تطبيق خصم إخوة" : "تم الدفع نقدًا",
        createdAt: Date.now(), confirmedAt, paidTime, date: egyptianDate.format(new Date(confirmedAt))
      };
      data.payments.push(payment);
    }
      allocation.activatedPlan = activatedPlan;
      allocation.targetDays = targetDays;
    });
    allocations.filter(item => item.completesSubscription).forEach(allocation => {
      allocation.chargedAttendance = activateSubscription(
        allocation.user,
        allocation.activatedPlan.sessions / 4,
        allocation.expectedStartDate,
        subscriptionDuration
      );
    });
  } catch (error) {
    data.users = previousUsers;
    data.payments = previousPayments;
    data.attendance = previousAttendance;
    showToast(error.message);
    return;
  }
  if (saveData()) {
    closeModal();
    renderView();
    const activatedPlayers = allocations.filter(item => item.completesSubscription).map(item => item.user.name);
    const chargedAttendance = allocations.reduce((total, item) => total + Number(item.chargedAttendance || 0), 0);
    const discountMessage = siblingDiscount ? ` وتطبيق خصم الإخوة ${arabicDigits(siblingDiscount)} ج.م على الرصيد` : "";
    const debtTotal = allocations.reduce((sum, item) => sum + (item.shortageResolution === "debt" ? Math.max(0, item.remainingAmount - item.paid - item.discountAmount) : 0), 0);
    const specialDiscountTotal = allocations.reduce((sum, item) => sum + (item.shortageResolution === "discount" ? Math.max(0, item.remainingAmount - item.paid - item.discountAmount) : 0), 0);
    const walletUsed = allocations.reduce((sum, item) => sum + Number(item.walletCreditUsedAmount || 0), 0);
    const walletAdded = allocations.reduce((sum, item) => sum + Number(item.walletCreditAddedAmount || 0), 0);
    const paymentMessage = amount ? `تم تسجيل دفعة ${arabicDigits(amount)} ج.م نقدًا` : "تمت تسوية الرصيد من المحفظة";
    const resolutionMessage = `${debtTotal ? ` وسُجلت مديونية ${arabicDigits(debtTotal)} ج.م` : ""}${specialDiscountTotal ? ` وطُبق خصم استثنائي ${arabicDigits(specialDiscountTotal)} ج.م` : ""}`;
    const walletMessage = `${walletUsed ? ` واستخدم ${arabicDigits(walletUsed)} ج.م من المحفظة` : ""}${walletAdded ? ` وأضيف ${arabicDigits(walletAdded)} ج.م إلى المحفظة` : ""}`;
    showToast(`${paymentMessage}${discountMessage}${resolutionMessage}${walletMessage}.${activatedPlayers.length ? ` تم تفعيل اشتراك ${activatedPlayers.join(" و")} وخصم ${arabicDigits(chargedAttendance)} تدريب سابق.` : " لم يكتمل الاشتراك بعد."}`);
  } else {
    data.users = previousUsers;
    data.payments = previousPayments;
    data.attendance = previousAttendance;
  }
}

function recordCashDebtPayment(playerId) {
  if (currentUser?.role !== "coach") { showToast("تحصيل المديونية النقدية من صلاحية المشرف فقط."); return; }
  const user = data.users.find(item => item.id === playerId && item.role === "member");
  const debt = Math.max(0, Number(user?.cashDebt || 0));
  if (!user || !debt) { showToast("لا توجد مديونية نقدية قائمة لهذا اللاعب."); return; }
  const now = new Date();
  const paidDate = localDateString(now);
  const paidTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal(`تحصيل مديونية · ${user.name}`, `<p class="modal-explainer">المديونية النقدية القائمة: ${arabicDigits(debt)} ج.م.</p><label>المبلغ المحصّل<input name="amount" type="number" min="1" max="${debt}" step="1" required></label><div class="form-row"><label>تاريخ السداد<input name="paidDate" type="date" max="${localDateString()}" value="${paidDate}" required></label><label>ساعة السداد<input name="paidTime" type="time" value="${paidTime}" required></label></div>`, "تسجيل السداد", form => {
    if (currentUser?.role !== "coach") { showToast("تحصيل المديونية النقدية من صلاحية المشرف فقط."); return; }
    const currentUserRecord = data.users.find(item => item.id === playerId && item.role === "member");
    const currentDebt = Math.max(0, Number(currentUserRecord?.cashDebt || 0));
    const amount = Number(form.get("amount"));
    const date = String(form.get("paidDate"));
    const time = String(form.get("paidTime"));
    const confirmedAt = new Date(`${date}T${time}:00`).getTime();
    if (!currentUserRecord || !Number.isInteger(amount) || amount < 1 || amount > currentDebt
      || !Number.isFinite(confirmedAt) || date > localDateString()) {
      showToast("راجع المبلغ والتاريخ؛ يجب ألا يتجاوز المبلغ المديونية القائمة.");
      return;
    }
    const previousUser = JSON.parse(JSON.stringify(currentUserRecord));
    const previousPayments = JSON.parse(JSON.stringify(data.payments));
    currentUserRecord.cashDebt = currentDebt - amount;
    data.payments.push({
      id: crypto.randomUUID(),
      playerId: currentUserRecord.id,
      playerName: currentUserRecord.name,
      planId: Number(currentUserRecord.weeklyDays?.length || currentUserRecord.weeklyDaysCount || 1),
      planName: "سداد مديونية نقدية",
      amount,
      debtPaymentAmount: amount,
      reference: "تحصيل مديونية نقدية في الأكاديمية",
      method: "cash",
      methodLabel: "نقدي",
      status: "سداد مديونية نقدية",
      createdAt: Date.now(),
      confirmedAt,
      paidTime: time,
      date: egyptianDate.format(new Date(confirmedAt))
    });
    if (saveData()) {
      closeModal();
      renderView();
      showToast(`تم تسجيل سداد ${arabicDigits(amount)} ج.م. المديونية المتبقية ${arabicDigits(currentUserRecord.cashDebt)} ج.م.`);
    } else {
      Object.assign(currentUserRecord, previousUser);
      data.payments = previousPayments;
    }
  }, "المدفوعات");
}

byId("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const consent = String(form.get("notificationConsent") || "");
  if (!["accept", "decline"].includes(consent)) {
    showToast("اختر الموافقة على إشعارات الأكاديمية أو رفضها قبل تسجيل الدخول.");
    return;
  }
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  authFlowInProgress = true;
  try {
    const notificationPermission = await requestNotificationPermission(consent);
    const firebase = await window.firebaseReady;
    const profile = await firebase.signIn(String(form.get("email")), String(form.get("password")));
    if (profile.role !== "guardian") {
      await firebase.signOut();
      throw new Error("المدرب يستخدم مدخل الاسم وكلمة المرور المخصص له، والمشرف يستخدم مدخله الخاص.");
    }
    saveNotificationConsent(profile.id, consent, notificationPermission);
    await activateCloudProfile(profile);
  } catch (error) {
    console.error("تعذر تسجيل الدخول.", error);
    showToast(error instanceof Error ? error.message : "تعذر تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى.");
  } finally {
    authFlowInProgress = false;
    submitButton.disabled = false;
  }
});

byId("register-form").addEventListener("submit", event => {
  event.preventDefault();
  const registerForm = event.currentTarget;
  const form = new FormData(registerForm);
  const email = String(form.get("email")).trim().toLowerCase();
  const consent = String(form.get("notificationConsent") || "");
  if (!["accept", "decline"].includes(consent)) {
    showToast("اختر الموافقة على إشعارات الأكاديمية أو رفضها قبل إنشاء الحساب.");
    return;
  }
  const guardianPhone = String(form.get("guardianPhone")).replace(/\s/g, "");
  const whatsappPhone = String(form.get("whatsappPhone")).replace(/\s/g, "");
  if (!/^01\d{9}$/.test(guardianPhone)) { showToast("أدخل رقم هاتف مصري صحيحًا مكوّنًا من ١١ رقمًا."); return; }
  if (!/^01\d{9}$/.test(whatsappPhone)) { showToast("أدخل رقم واتساب مصريًا مكوّنًا من ١١ رقمًا."); return; }
  const childNames = form.getAll("childName").map(value => String(value).trim());
  const childGenders = form.getAll("childGender").map(String);
  const childBirthDays = form.getAll("childBirthDay").map(value => Number(normalizeDigits(String(value).trim())));
  const childBirthMonths = form.getAll("childBirthMonth").map(value => Number(normalizeDigits(String(value).trim())));
  const childBirthYears = form.getAll("childBirthYear").map(value => Number(normalizeDigits(String(value).trim())));
  const childBirthDates = childBirthDays.map((day, index) => {
    const month = childBirthMonths[index];
    const year = childBirthYears[index];
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });
  if (!childNames.length || childNames.some(name => name.length < 2 || name.length > 80)
    || childGenders.length !== childNames.length || childGenders.some(gender => !["male", "female"].includes(gender))
    || childBirthDays.length !== childNames.length || childBirthMonths.length !== childNames.length || childBirthYears.length !== childNames.length
    || childBirthDates.some((birthDate, index) => {
      const birthday = new Date(`${birthDate}T12:00:00`);
      return !Number.isInteger(childBirthDays[index]) || !Number.isInteger(childBirthMonths[index]) || !Number.isInteger(childBirthYears[index])
        || childBirthYears[index] < 1000 || Number.isNaN(birthday.getTime()) || birthday.toISOString().slice(0, 10) !== birthDate
        || birthDate > localDateString();
    })) {
    showToast("أدخل اسمًا صحيحًا ونوعًا وتاريخ ميلاد صحيحًا لكل لاعب.");
    return;
  }
  const user = { role: "guardian", name: String(form.get("guardianName")).trim(), guardianPhone, whatsappPhone, email, password: String(form.get("password")), joinedAt: new Date().toISOString() };
  if (user.name.length < 2 || !email || String(form.get("password")).length < 6) { showToast("أكمل اسم ولي الأمر والبريد الإلكتروني وكلمة المرور."); return; }
  const players = childNames.map((name, index) => ({
    id: crypto.randomUUID(),
    role: "member",
    guardianId: user.id,
    joinedAt: user.joinedAt,
    name,
    gender: childGenders[index],
    birthDate: childBirthDates[index],
    guardian: user.name,
    guardianPhone,
    whatsappPhone,
    category: playerCategoryForBirthDate(childBirthDates[index]),
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
    attendanceLogs: []
  }));
  const submitButton = registerForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  authFlowInProgress = true;
  (async () => {
    try {
      const notificationPermission = await requestNotificationPermission(consent);
      const firebase = await window.firebaseReady;
      const registration = await firebase.registerGuardian(user, players);
      saveNotificationConsent(registration.profile.id, consent, notificationPermission);
      registerForm.reset();
      byId("child-name-list").innerHTML = '<div class="child-name-row"><label>اسم اللاعب<input name="childName" required minlength="2" maxlength="80" placeholder="اسم اللاعب بالكامل"></label><label>النوع<select name="childGender" required><option value="">اختر النوع</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label><fieldset class="child-birth-date"><legend>تاريخ ميلاد اللاعب</legend><div class="child-birth-date-fields"><label>اليوم<input name="childBirthDay" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{1,2}" maxlength="2" required placeholder="يوم"></label><label>الشهر<input name="childBirthMonth" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{1,2}" maxlength="2" required placeholder="شهر"></label><label>السنة<input name="childBirthYear" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{4}" maxlength="4" required placeholder="سنة"></label></div></fieldset></div></div>';
      await activateCloudProfile(registration.profile);
      showToast("تم إنشاء حساب ولي الأمر وحفظ بيانات الأبناء وأكوادهم في Firestore.");
    } catch (error) {
      console.error("تعذر إنشاء حساب ولي الأمر أو حفظ بيانات الأبناء.", error);
      showToast(error instanceof Error ? error.message : "تعذر حفظ التسجيل في Firestore. حاول مرة أخرى.");
    } finally {
      authFlowInProgress = false;
      if (submitButton.isConnected) submitButton.disabled = false;
    }
  })();
});

byId("add-child-name").addEventListener("click", () => {
  const row = document.createElement("div");
  row.className = "child-name-row";
  row.innerHTML = '<label>اسم اللاعب<input name="childName" required minlength="2" maxlength="80" placeholder="اسم اللاعب بالكامل"></label><label>النوع<select name="childGender" required><option value="">اختر النوع</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label><fieldset class="child-birth-date"><legend>تاريخ ميلاد اللاعب</legend><div class="child-birth-date-fields"><label>اليوم<input name="childBirthDay" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{1,2}" maxlength="2" required placeholder="يوم"></label><label>الشهر<input name="childBirthMonth" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{1,2}" maxlength="2" required placeholder="شهر"></label><label>السنة<input name="childBirthYear" type="text" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{4}" maxlength="4" required placeholder="سنة"></label></div></fieldset><button type="button" class="remove-child-button" data-remove-child aria-label="حذف اسم اللاعب">×</button>';
  byId("child-name-list").append(row);
  row.querySelector("input").focus();
});

byId("child-name-list").addEventListener("click", event => {
  if (!(event.target instanceof Element) || !event.target.closest("[data-remove-child]")) return;
  event.target.closest(".child-name-row").remove();
  const rows = byId("child-name-list").querySelectorAll(".child-name-row");
  if (rows.length === 1) rows[0].querySelector("[data-remove-child]")?.remove();
});

byId("player-code-entry").addEventListener("click", openPlayerCodeLogin);
byId("coach-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  authFlowInProgress = true;
  (async () => {
    try {
      const firebase = await window.firebaseReady;
      const profile = await firebase.signInCoach(normalizeDigits(String(form.get("password"))));
      if (profile.role !== "coach") {
        await firebase.signOut();
        throw new Error("هذا الحساب غير مسجل بدور مشرف الأكاديمية.");
      }
      await activateCloudProfile(profile);
    } catch (error) {
      console.error("تعذر تسجيل دخول المشرف.", error);
      showToast(error instanceof Error ? error.message : "تعذر تسجيل الدخول. تحقق من البيانات.");
    } finally {
      authFlowInProgress = false;
      submitButton.disabled = false;
    }
  })();
});

document.querySelectorAll(".auth-tab").forEach(tab => tab.addEventListener("click", () => setAuthTab(tab.dataset.authTab)));
byId("coach-entry").addEventListener("click", () => {
  byId("member-auth").hidden = true;
  byId("coach-auth").hidden = false;
});
byId("member-entry").addEventListener("click", () => {
  byId("coach-auth").hidden = true;
  byId("member-auth").hidden = false;
  setAuthTab("login");
});

document.querySelectorAll(".show-password").forEach(button => button.addEventListener("click", () => {
  const input = button.parentElement.querySelector("input");
  input.type = input.type === "password" ? "text" : "password";
}));

document.addEventListener("click", async event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const viewButton = target.closest("[data-view]");
  if (viewButton) {
    const allowedViews = currentUser.role === "coach"
      ? ["home", "legacyPlayers", "schedule", "attendance", "subscription", "guardianReport", "payments", "settings", "trainers", "trainerAttendance", "finances"]
      : currentUser.role === "trainer" ? ["home", "schedule", "attendance"] : ["home", "schedule", "attendance", "subscription", "payments"];
    if (!allowedViews.includes(viewButton.dataset.view)) { showToast("هذه الصفحة غير متاحة لحسابك."); return; }
    if (viewButton.dataset.view !== activeView) viewHistory.push(activeView);
    activeView = viewButton.dataset.view;
    byId("portal-sidebar").classList.remove("open");
    renderView();
    return;
  }
  const action = target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "select-legacy-player") {
    if (currentUser?.role !== "coach") { showToast("ملفات اللاعبين الحاليين متاحة للمشرف فقط."); return; }
    const player = data.users.find(item => item.id === action.dataset.player && item.role === "member");
    if (!player) { showToast("لم يتم العثور على اللاعب المطلوب."); return; }
    selectedLegacyPlayerId = player.id;
    renderView();
    return;
  }
  if (action.dataset.action === "select-guardian-report") {
    if (currentUser?.role !== "coach") { showToast("تقرير ولي الأمر متاح للمشرف فقط."); return; }
    const guardianId = action.dataset.guardian;
    if (!guardianId) { showToast("معرّف ولي الأمر غير صالح."); return; }
    selectedReportGuardianId = guardianId;
    guardianReport = null;
    guardianReportError = "";
    guardianReportLoading = true;
    renderView();
    try {
      const firebase = await window.firebaseReady;
      const report = await firebase.getGuardianReport(guardianId);
      if (selectedReportGuardianId === guardianId) guardianReport = report;
    } catch (error) {
      console.error("تعذر تحميل تقرير ولي الأمر.", error);
      if (selectedReportGuardianId === guardianId) guardianReportError = error instanceof Error ? error.message : "تعذر تحميل تقرير ولي الأمر.";
    } finally {
      if (selectedReportGuardianId === guardianId) {
        guardianReportLoading = false;
        renderView();
      }
    }
    return;
  }
  if (action.dataset.action === "go-back") {
    activeView = viewHistory.pop() || "home";
    renderView();
    return;
  }
  if (["new-session", "edit-session", "delete-session", "take-attendance", "day-off", "code-attendance", "cash-payment", "cash-debt-payment", "new-trainer", "mark-trainer-attendance", "new-expense", "new-revenue", "instapay-settings", "confirm-payment", "reject-payment", "receipt-preview", "approve-makeup", "reject-makeup", "approve-player-category", "delete-expense", "delete-revenue", "delete-guardian", "record-administrative-absence"].includes(action.dataset.action) && currentUser.role !== "coach") {
    showToast("هذا الإجراء متاح لمشرف الأكاديمية فقط.");
    return;
  }
  if (action.dataset.action === "payment" && ["member", "guardian"].includes(currentUser.role)) {
    const player = userForMember();
    if (player) requestPayment(player.weeklyDays.length || player.weeklyDaysCount);
  }
  if (action.dataset.action === "new-player") openPlayerForm();
  if (action.dataset.action === "complete-player") {
    const player = data.users.find(user => user.id === action.dataset.player && user.role === "member" && user.guardianId === currentUser.id);
    if (player) openPlayerFormFor(player);
  }
  if (action.dataset.action === "new-session") {
    openSessionForm();
  }
  if (action.dataset.action === "edit-session") {
    const session = data.sessions.find(item => item.id === action.dataset.session);
    if (!session) { showToast("لم يتم العثور على موعد التدريب."); return; }
    openSessionForm(session);
  }
  if (action.dataset.action === "delete-session") {
    deleteTrainingGroup(action.dataset.session);
  }
  if (action.dataset.action === "take-attendance") openAttendanceRoster(action.dataset.session);
  if (action.dataset.action === "day-off") openDayOffForm(action.dataset.session);
  if (action.dataset.action === "code-attendance") openCodeAttendanceForm();
  if (action.dataset.action === "request-makeup") openMakeupRequest(action.dataset.attendance);
  if (action.dataset.action === "approve-makeup") reviewMakeupRequest(action.dataset.request, true);
  if (action.dataset.action === "reject-makeup") reviewMakeupRequest(action.dataset.request, false);
  if (action.dataset.action === "receipt-preview") {
    openModal(`إيصال تحويل ${action.dataset.player}`, `<div class="receipt-preview-modal"><img src="${escapeHtml(action.dataset.receipt)}" alt="إيصال تحويل ${escapeHtml(action.dataset.player)}"></div>`, "إغلاق", closeModal, "مراجعة التحويلات");
  }
  if (action.dataset.action === "trainer-mark-attendance") openSearchedPlayerAttendanceForm(action.dataset.player, action.dataset.session);
  if (action.dataset.action === "cash-payment") recordCashPayment(action.dataset.player);
  if (action.dataset.action === "cash-debt-payment") recordCashDebtPayment(action.dataset.player);
  if (action.dataset.action === "approve-player-category") approvePlayerCategory(action.dataset.player);
  if (action.dataset.action === "subscription-override") openSubscriptionOverride(action.dataset.player);
  if (action.dataset.action === "record-administrative-absence") {
    if (currentUser?.role !== "coach") { showToast("تسجيل الغياب الإداري متاح للمشرف فقط."); return; }
    const playerId = byId("administrative-absence-player").value;
    if (!playerId) { showToast("اختر اللاعب أولًا."); return; }
    openAdministrativeAbsenceForm(playerId);
  }
  if (action.dataset.action === "delete-guardian") deleteGuardian(action.dataset.guardian);
  if (action.dataset.action === "new-trainer") openTrainerForm();
  if (action.dataset.action === "mark-trainer-attendance") openTrainerAttendanceForm();
  if (action.dataset.action === "new-expense") openExpenseForm();
  if (action.dataset.action === "new-revenue") openRevenueForm();
  if (action.dataset.action === "instapay-settings") {
    if (currentUser.role !== "coach") { showToast("إعداد التحويل من صلاحية المشرف فقط."); return; }
    openModal("رقم إنستا باي للأكاديمية", `<label>رقم التحويل عبر إنستا باي<input value="${DEFAULT_INSTAPAY_NUMBER}" readonly></label><p class="modal-explainer">يستخدم اللاعبون الرقم الثابت 01017692213 للتحويل. يراجع المشرف رقم العملية ورسالة واتساب ثم يؤكد الدفع.</p>`, "تم", () => {
      data.instaPayAddress = DEFAULT_INSTAPAY_NUMBER;
      data.paymentDestinationType = "instapay";
      if (saveData()) { closeModal(); renderView(); showToast("رقم إنستا باي المعتمد: 01017692213."); }
    }, "إدارة المدفوعات");
  }
  if (action.dataset.action === "copy-text") {
    const value = action.dataset.copy || "";
    if (!navigator.clipboard?.writeText) { showToast(`رقم التحويل: ${value}`); return; }
    navigator.clipboard.writeText(value).then(() => showToast("تم نسخ الرقم.")).catch(error => { console.error("تعذر نسخ الرقم.", error); showToast(`رقم التحويل: ${value}`); });
  }
  if (action.dataset.action === "toggle-guardian-notifications") toggleUserNotifications();
  if (action.dataset.action === "mark-announcement-read") markAnnouncementRead([action.dataset.announcement]);
  if (action.dataset.action === "mark-all-announcements-read") {
    const currentGuardianId = currentUser.role === "member" ? currentUser.guardianId : currentUser.id;
    markAnnouncementRead(data.announcements
      .filter(item => !Array.isArray(item.targetGuardianIds) || item.targetGuardianIds.includes(currentGuardianId))
      .map(item => item.id));
  }
  if (action.dataset.action === "confirm-payment") confirmPayment(action.dataset.payment);
  if (action.dataset.action === "reject-payment") rejectPaymentForResubmission(action.dataset.payment);
  if (action.dataset.action === "delete-expense") deleteExpense(action.dataset.expense);
  if (action.dataset.action === "delete-revenue") deleteRevenue(action.dataset.revenue);
  if (action.classList.contains("request-plan")) requestPayment(action.dataset.plan);
});

document.addEventListener("change", event => {
  if (event.target.name?.startsWith("legacySubscriptionStart") && currentUser?.role === "coach") {
    updateLegacyProjectedEndDate(event.target.form);
  }
  if (event.target.id === "training-count" && currentUser?.role === "coach") {
    const form = byId("action-form");
    const currentCount = form.querySelectorAll(".training-exercise").length;
    const values = exerciseValuesFromForm(form, currentCount);
    const nextCount = Number(event.target.value);
    while (values.length < nextCount) values.push({ title: "", coachId: "", gender: "", categories: [] });
    form.querySelector("#training-exercises").innerHTML = trainingExerciseRows(values.slice(0, nextCount), data.users.filter(user => user.role === "trainer"));
    return;
  }
  if (event.target.id === "selected-player" && currentUser?.role === "guardian") {
    selectedPlayerId = event.target.value;
    localStorage.setItem(selectedPlayerStorageKey(currentUser.id), selectedPlayerId);
    renderView();
    return;
  }
  if (event.target.id === "finance-month" && currentUser?.role === "coach") { renderView(); return; }
  if (event.target.matches('#member-days-form input[name="weeklyDays"]')) {
    const count = byId("member-days-form").querySelectorAll('input[name="weeklyDays"]:checked').length;
    byId("member-days-price").textContent = count
      ? `الاشتراك: ${arabicDigits(data.pricesByDays[count])} ج.م شهريًا · ${arabicDigits(count * 4)} تدريبات`
      : "اختر يومًا واحدًا على الأقل.";
    const price = byId("member-days-form").parentElement.querySelector(".payment-cta strong");
    price.textContent = count ? `قيمة الاشتراك: ${arabicDigits(data.pricesByDays[count])} ج.م شهريًا` : "اختر أيام التدريب لتحديد السعر.";
    const paymentButton = byId("member-days-form").parentElement.querySelector('[data-action="payment"]');
    paymentButton.disabled = true;
    paymentButton.title = "احفظ أيام التدريب أولًا قبل الدفع";
  }
});

document.addEventListener("input", event => {
  if (event.target.name?.startsWith("legacySubscriptionStart") && currentUser?.role === "coach") {
    updateLegacyProjectedEndDate(event.target.form);
  }
  if (event.target.id === "guardian-report-search" && currentUser?.role === "coach") {
    guardianReportSearch = event.target.value;
    selectedReportGuardianId = "";
    guardianReport = null;
    guardianReportLoading = false;
    guardianReportError = "";
    const results = byId("guardian-report-results");
    const details = byId("guardian-report-details");
    if (results) results.innerHTML = guardianReportSearchResults();
    if (details) details.innerHTML = guardianReportDetails();
  }
  if (event.target.id === "trainer-player-search" && currentUser?.role === "trainer") renderTrainerPlayerSearch(event.target.value);
  if (event.target.id === "legacy-player-search" && currentUser?.role === "coach") {
    legacyPlayerSearch = event.target.value;
    const query = normalizeDigits(legacyPlayerSearch.trim()).toLocaleLowerCase("ar");
    const results = byId("legacy-player-results");
    const players = [...(results?.querySelectorAll(".legacy-player-result") || [])];
    let visibleCount = 0;
    players.forEach(button => {
      const name = button.querySelector("strong")?.textContent?.toLocaleLowerCase("ar") || "";
      const code = normalizeDigits(button.querySelector("small")?.textContent || "");
      button.hidden = Boolean(query) && !name.includes(query) && !code.includes(query);
      if (!button.hidden) visibleCount += 1;
    });
    const emptyMessage = results?.querySelector(".legacy-player-no-results");
    if (emptyMessage) emptyMessage.hidden = visibleCount > 0;
  }
  if (event.target.id === "coach-player-search" && currentUser?.role === "coach") {
    const query = normalizeDigits(event.target.value.trim()).toLocaleLowerCase("ar");
    document.querySelectorAll("#portal-content [data-coach-search-row]").forEach(row => {
      const parentName = row.dataset.searchParent?.toLocaleLowerCase("ar") || "";
      const playerCode = normalizeDigits(row.dataset.searchCode || "");
      row.hidden = Boolean(query) && !parentName.includes(query) && !playerCode.includes(query);
    });
    document.querySelectorAll("#portal-content tbody").forEach(body => {
      const rows = [...body.querySelectorAll("[data-coach-search-row]")];
      const emptyRow = body.querySelector("[data-search-empty]");
      if (emptyRow) emptyRow.hidden = !query || rows.some(row => !row.hidden);
    });
  }
});

document.addEventListener("submit", event => {
  const legacyHandlers = {
    "legacy-player-days-form": saveLegacyPlayerDays,
    "legacy-player-balance-form": saveLegacyPlayerBalance,
    "legacy-player-attendance-form": saveLegacyPlayerAttendance,
    "legacy-player-payment-form": saveLegacyPlayerPayment
  };
  const legacyHandler = legacyHandlers[event.target.id];
  if (legacyHandler) {
    event.preventDefault();
    if (currentUser?.role !== "coach") { showToast("تعديل ملفات اللاعبين متاح للمشرف فقط."); return; }
    Promise.resolve(legacyHandler(new FormData(event.target))).catch(error => {
      console.error("تعذر حفظ بيانات اللاعب القائم.", error);
      showToast(error instanceof Error ? `تعذر الحفظ: ${error.message}` : "تعذر حفظ بيانات اللاعب.");
    });
    return;
  }
  if (event.target.id === "member-sessions-form") {
    event.preventDefault();
    if (!["member", "guardian"].includes(currentUser?.role)) { showToast("اختيار مواعيد التدريب متاح للاعب أو ولي الأمر فقط."); return; }
    const user = userForMember();
    if (!user) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
    if (!canEditPlayerSchedule(user)) { showToast("تعديل جدول التدريب غير متاح حسب حالة الاشتراك الحالية."); return; }
    const availableIds = new Set(sessionsForMember(user).filter(session => sessionMatchesMemberDays(session, user)).map(session => session.id));
    const selectedIds = [...new Set(new FormData(event.target).getAll("sessionIds").map(String))];
    if (!selectedIds.length || selectedIds.some(id => !availableIds.has(id))) { showToast("اختر موعدًا واحدًا على الأقل من المواعيد المتاحة لأيام تدريبك."); return; }
    const previousSelection = user.selectedSessionIds;
    user.selectedSessionIds = selectedIds;
    if (saveData()) {
      renderView();
      showToast("تم حفظ مواعيدك المختارة. يتفعّل الاشتراك بعد تأكيد سداد كامل المبلغ.");
    } else if (previousSelection === undefined) delete user.selectedSessionIds;
    else user.selectedSessionIds = previousSelection;
    return;
  }
  if (event.target.id === "member-days-form") {
    event.preventDefault();
    if (!["member", "guardian"].includes(currentUser?.role)) { showToast("إعداد الاشتراك متاح من حساب ولي الأمر فقط."); return; }
    const user = userForMember();
    if (!user) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
    if (!canEditPlayerSchedule(user)) { showToast("تعديل أيام التدريب غير متاح حسب حالة الاشتراك الحالية."); return; }
    const weeklyDays = new FormData(event.target).getAll("weeklyDays").map(String).filter(day => data.workDays.includes(day));
    if (!weeklyDays.length) { showToast("اختر يومًا واحدًا على الأقل."); return; }
    user.weeklyDays = weeklyDays;
    user.weeklyDaysCount = weeklyDays.length;
    user.plan = weeklyDays.length;
    if (saveData()) { renderView(); showToast("تم حفظ أيام تدريبك. حدّث الدفع عند تغيير عدد الأيام."); }
    return;
  }
  if (event.target.id === "coach-settings-form") {
    event.preventDefault();
    if (currentUser?.role !== "coach") { showToast("تعديل أيام العمل والأسعار من صلاحية المشرف فقط."); return; }
    const form = new FormData(event.target);
    const workDays = form.getAll("workDays").map(String).filter(day => WEEK_DAYS.includes(day));
    if (!workDays.length) { showToast("يجب تحديد يوم عمل واحد على الأقل."); return; }
    const removedScheduledDay = data.sessions.find(session => sessionDays(session).some(day => !workDays.includes(day)));
    if (removedScheduledDay) { showToast(`لا يمكن إلغاء يوم تدريب لمجموعة ${removedScheduledDay.title}. عدّل المجموعة أولًا.`); return; }
    const removedBookedDay = data.users.find(user => user.role === "member" && (user.weeklyDays || []).some(day => !workDays.includes(day)));
    if (removedBookedDay) { showToast("لا يمكن إلغاء يوم اختاره لاعب؛ عدّل أيام اشتراكه أولًا."); return; }
    const pricesByDays = {};
    for (let count = 1; count <= 7; count += 1) {
      const price = Number(form.get(`price-${count}`));
      if (!Number.isFinite(price) || price < 1) { showToast("أدخل سعرًا صحيحًا لكل عدد من أيام التدريب."); return; }
      pricesByDays[count] = Math.round(price);
    }
    const previousData = { workDays: data.workDays, pricesByDays: data.pricesByDays };
    data.workDays = workDays;
    data.pricesByDays = pricesByDays;
    if (saveData()) { renderView(); showToast("تم حفظ أيام العمل وأسعار الاشتراك."); }
    else { data.workDays = previousData.workDays; data.pricesByDays = previousData.pricesByDays; }
    return;
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});
byId("modal-close").addEventListener("click", closeModal);
byId("action-modal").addEventListener("click", event => { if (event.target === byId("action-modal")) closeModal(); });
byId("portal-menu").addEventListener("click", () => byId("portal-sidebar").classList.toggle("open"));
async function logOut() {
  try {
    await cloudWriteQueue;
    const firebase = await window.firebaseReady;
    await firebase.signOut();
    cloudProfile = null;
    currentUser = null;
    appUserReady = false;
    selectedPlayerId = null;
    showAuth();
  } catch (error) {
    console.error("تعذر تسجيل الخروج من Firebase Authentication.", error);
    showToast("تعذر تسجيل الخروج. حاول مرة أخرى.");
  }
}

byId("logout-button").addEventListener("click", logOut);
byId("profile-button").addEventListener("click", logOut);
byId("portal-notifications").addEventListener("click", openAnnouncementsBoard);

function observeFirebaseAuth() {
  if (firebaseObserverStarted) return;
  firebaseObserverStarted = true;
  window.firebaseReady = window.loadFirebase();
  window.firebaseReady.then(firebase => {
    firebase.observeAuth(async user => {
      if (authFlowInProgress || currentUser) return;
      if (!user) {
        initialAuthResolved = true;
        showAuth();
        return;
      }
      try {
        const profile = await firebase.currentProfile(user);
        if (!profile) {
          initialAuthResolved = true;
          await firebase.signOut();
          showAuth();
          showToast(user.isAnonymous
            ? "تعذر استعادة جلسة اللاعب. سجّل الدخول مجددًا باستخدام كود الحضور."
            : "هذا البريد غير مسجل بدور في الأكاديمية. تواصل مع المشرف.");
          return;
        }
        await activateCloudProfile(profile);
        initialAuthResolved = true;
      } catch (error) {
        initialAuthResolved = true;
        console.error("تعذر استعادة جلسة Firebase.", error);
        showAuth();
        showToast("تعذر تحميل الحساب من Firebase. أعد تسجيل الدخول.");
      }
    });
  }).catch(error => {
    initialAuthResolved = true;
    console.error("تعذر تحميل Firebase.", error);
    showAuth();
    showToast("تعذر الاتصال بخدمات Firebase. تحقق من الاتصال وإعدادات المشروع.");
  });
}
