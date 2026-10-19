const STORAGE_KEY = "alEtihadAcademy.portal.v1";
const WEEK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const DEFAULT_WORK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const DEFAULT_DAY_PRICES = { 1: 400, 2: 760, 3: 1020, 4: 1200, 5: 1400, 6: 1600, 7: 1800 };
const DEFAULT_INSTAPAY_NUMBER = "01017692213";
const AGE_CATEGORIES = ["براعم تحت ١٠", "ناشئين تحت ١٤", "شباب تحت ١٨", "شباب ١٨+", "جميع الفئات العمرية"];
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

function notificationConsentStorageKey(userId) {
  return `${STORAGE_KEY}.push.${userId}`;
}

function notificationSubscriptionStorageKey(userId) {
  return `${STORAGE_KEY}.push.subscription.${userId}`;
}

async function requestNotificationPermission(consent) {
  if (consent !== "accept" || !("Notification" in window)) return null;
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
  if (!user || !["guardian", "member"].includes(user.role)) return false;
  const choice = localStorage.getItem(notificationConsentStorageKey(user.id));
  if (choice === "declined") return false;
  return choice === "accepted" || choice === "enabled"
    || ("Notification" in window && Notification.permission === "granted");
}

function hasNotificationSubscription(user) {
  if (!user || !["guardian", "member"].includes(user.role)) return false;
  return "Notification" in window
    && Notification.permission === "granted"
    && (localStorage.getItem(notificationSubscriptionStorageKey(user.id)) === "enabled"
      || localStorage.getItem(notificationConsentStorageKey(user.id)) === "enabled");
}

function emptyData() {
  return { users: [], sessions: [], announcements: [], payments: [], attendance: [], attendanceExceptions: [], trainerAttendance: [], expenses: [], revenues: [], instaPayAddress: DEFAULT_INSTAPAY_NUMBER, paymentDestinationType: "instapay", workDays: [...DEFAULT_WORK_DAYS], pricesByDays: { ...DEFAULT_DAY_PRICES } };
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
  let age = new Date().getFullYear() - birthday.getFullYear();
  if (new Date().getMonth() < birthday.getMonth() || (new Date().getMonth() === birthday.getMonth() && new Date().getDate() < birthday.getDate())) age -= 1;
  return age < 10 ? "براعم تحت ١٠" : age < 14 ? "ناشئين تحت ١٤" : age < 18 ? "شباب تحت ١٨" : "شباب ١٨+";
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

function canChooseSubscriptionStartDate(user) {
  const { status } = evaluateSubscriptionStartStatus(user);
  return status === "new" || status === "returning";
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
  const sessionsLeft = user.sessionsLeft == null ? priceSummary(user.plan).plan.sessions : Number(user.sessionsLeft);
  return subscriptionState(user).className === "status-active"
    && isSubscriptionActiveOn(user, isoDate)
    && sessionsLeft > 0;
}

function consumeTraining(user) {
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
    console.warn("منع المتصفح تشغيل الفيديو الافتتاحي بالصوت تلقائياً.", error);
    video.muted = true;
    video.play().catch(playError => {
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
  byId("user-role").textContent = user.role === "coach" ? "مشرف الأكاديمية" : user.role === "trainer" ? "مدرب الأكاديمية" : user.role === "guardian" ? "ولي أمر اللاعبين" : "ولي أمر اللاعب";
  document.querySelectorAll(".supervisor-only").forEach(item => { item.hidden = user.role !== "coach"; });
  document.querySelectorAll(".member-only").forEach(item => { item.hidden = !["member", "guardian"].includes(user.role); });
  document.querySelectorAll(".trainer-only").forEach(item => { item.hidden = user.role !== "trainer"; });
  activeView = "home";
  renderView();
  if (hasAcceptedNotifications(user) && "Notification" in window && Notification.permission === "granted") {
    window.firebaseReady
      .then(async firebase => {
        await firebase.subscribeGuardianToNotifications(user);
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

function dayCheckboxes(days, selectedDays = [], name = "weeklyDays") {
  if (!days.length) return '<p class="form-note">لم يحدد المدرب أيام العمل بعد.</p>';
  return days.map(day => `<label class="day-choice"><input type="checkbox" name="${name}" value="${escapeHtml(day)}" ${selectedDays.includes(day) ? "checked" : ""}><span>${escapeHtml(day)}</span></label>`).join("");
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
  const completeProfile = selectedChild && (!selectedChild.birthDate || !selectedChild.weeklyDays?.length)
    ? `<button class="small-action" data-action="complete-player" data-player="${escapeHtml(selectedChild.id)}">استكمال بيانات اللاعب</button>`
    : "";
  return `<section class="panel child-picker"><label for="selected-player">اللاعب المعروض</label><select id="selected-player">${children.map(child => `<option value="${escapeHtml(child.id)}" ${child.id === selectedPlayerId ? "selected" : ""}>${escapeHtml(child.name)} · كود ${escapeHtml(child.playerCode)}</option>`).join("")}</select>${completeProfile}<button class="small-action" data-action="new-player">＋ إضافة لاعب</button></section>`;
}

function sessionIncludesMember(session, user) {
  const categories = sessionCategories(session);
  return categories.includes("جميع الفئات العمرية") || categories.includes(user.category) || user.category === "جميع الفئات العمرية";
}

function sessionCategories(session) {
  const categories = Array.isArray(session.categories) ? session.categories.filter(category => AGE_CATEGORIES.includes(category)) : [];
  if (categories.length) return [...new Set(categories)];
  return [AGE_CATEGORIES.includes(session.category) ? session.category : "جميع الفئات العمرية"];
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

function sessionDays(session) {
  const days = Array.isArray(session.days) ? session.days : [session.day];
  return days.filter(day => WEEK_DAYS.includes(day));
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
  const sessionsLeft = Number(user.sessionsLeft ?? priceSummary(user.plan).plan.sessions);
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

function priceSummary(planId) {
  const dayCount = Math.max(1, Math.min(7, Number(planId) || 1));
  const price = Number(data.pricesByDays[dayCount] ?? DEFAULT_DAY_PRICES[dayCount]);
  const plan = { name: `${arabicDigits(dayCount)} ${dayCount === 1 ? "يوم" : "أيام"} أسبوعيًا`, sessions: dayCount * 4, price };
  const sessionPrice = Math.round(price / plan.sessions);
  return { plan, sessionPrice, sessions: arabicDigits(plan.sessions) };
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
  const titles = { home: "الرئيسية", schedule: "جدول التدريبات", attendance: "الحضور", subscription: isCoach ? "اشتراكات اللاعبين" : "اشتراكي", payments: "المدفوعات", settings: "أيام العمل والأسعار", trainers: "إدارة المدربين", trainerAttendance: "حضور المدربين", finances: "الإيرادات والمصروفات" };
  if ((isTrainer && !["home", "schedule", "attendance"].includes(activeView)) || (["member", "guardian"].includes(currentUser?.role) && !["home", "schedule", "attendance", "subscription", "payments"].includes(activeView))) activeView = "home";
  byId("view-title").textContent = isCoach && activeView === "home" ? "إدارة الأكاديمية" : isTrainer && activeView === "home" ? "مساحة المدرب" : titles[activeView];
  byId("portal-back").disabled = viewHistory.length === 0;
  document.querySelectorAll(".portal-nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === activeView));
  const content = byId("portal-content");
  if (isCoach) {
    content.innerHTML = activeView === "schedule" ? coachScheduleView() : activeView === "attendance" ? coachAttendanceView() : activeView === "subscription" ? coachPlayersView() : activeView === "payments" ? coachPaymentsView() : activeView === "settings" ? coachSettingsView() : activeView === "trainers" ? coachTrainersView() : activeView === "trainerAttendance" ? supervisorTrainerAttendanceView() : activeView === "finances" ? financeView() : coachHomeView();
  } else if (isTrainer) {
    content.innerHTML = activeView === "schedule" ? trainerScheduleView() : activeView === "attendance" ? trainerAttendanceView() : trainerHomeView();
  } else {
    if (currentUser.role === "guardian" && !childrenForGuardian().length) content.innerHTML = guardianChildBar();
    else content.innerHTML = `${guardianChildBar()}${activeView === "schedule" ? memberScheduleView() : activeView === "attendance" ? memberAttendanceView() : activeView === "subscription" ? memberSubscriptionView() : activeView === "payments" ? memberPaymentsView() : memberHomeView()}`;
  }
}

function memberHomeView() {
  const user = userForMember();
  if (!user) return "";
  const state = subscriptionState(user);
  const planInfo = priceSummary(user.plan);
  const sessionsLeft = user.sessionsLeft ?? planInfo.plan.sessions;
  const percent = Math.max(0, Math.min(100, sessionsLeft / planInfo.plan.sessions * 100));
  const chosenSessions = selectedSessionsForMember(user);
  const memberSessions = chosenSessions.length ? chosenSessions : sessionsForMember(user);
  const nextSession = memberSessions.find(session => sessionMatchesMemberDays(session, user)) || memberSessions[0];
  const notices = memberNotifications(user);
  const noticeTitle = notices[0] || "خصم تدريباتك مرتبط بباقة اشتراكك";
  const noticeMessage = notices[1] || `سعر التدريب الواحد ${arabicDigits(planInfo.sessionPrice)} ج.م حسب الأيام التي اخترتها.`;
  const notificationPanel = ["guardian", "member"].includes(currentUser?.role)
    && !hasNotificationSubscription(currentUser)
    ? `<section class="panel push-notification-panel"><div><strong>إشعارات الأكاديمية</strong><p>استقبل تنبيهات الحضور والغياب والدفع، والإعلانات الجديدة على هاتفك.</p></div><button class="small-action" data-action="toggle-guardian-notifications">🔔 ${hasAcceptedNotifications(currentUser) ? "إعادة محاولة تفعيل الإشعارات" : "الموافقة على الإشعارات"}</button></section>`
    : "";
  return `<section class="portal-welcome"><div><p class="eyebrow"><span class="live-dot"></span>${egyptianDate.format(new Date())}</p><h1>أهلًا يا ${escapeHtml(user.name.split(" ")[0])} <span class="wave">✦</span></h1><p class="welcome-subtitle">مستعد لتمرينك القادم؟ تقدمك يبدأ بخطوة.</p></div><span class="welcome-ball">🏀</span></section>${notificationPanel}
    <section class="member-stats">
      <article class="member-stat"><span class="member-stat-icon green-icon">◷</span><p>التدريبات المرشحة</p><strong>${nextSession ? `${sessionDays(nextSession).join("، ")} · ${nextSession.time}` : "لا يوجد تدريب"}</strong><small>${escapeHtml(nextSession?.title || "تظهر المواعيد بعد إضافتها من الأكاديمية")}</small></article>
      <article class="member-stat"><span class="member-stat-icon blue-icon">✓</span><p>تدريبات الباقة</p><strong>${arabicDigits(planInfo.plan.sessions)} تدريبات</strong><small>كود الحضور يظهر في صفحة «كودي»</small></article>
      <article class="member-stat"><span class="member-stat-icon amber-icon">▤</span><p>حالة الاشتراك</p><strong><span class="subscription-badge ${state.className}">${state.label}</span></strong><small>${state.remaining === null ? "بانتظار تأكيد الدفع" : `متبقي ${arabicDigits(Math.max(0, state.remaining))} يومًا`}</small></article>
      <article class="member-stat"><span class="member-stat-icon purple-icon">⌗</span><p>كود اللاعب</p><strong class="player-code">${escapeHtml(user.playerCode)}</strong><small>تاريخ الانضمام: ${joinedDate(user)}</small></article>
    </section>
    <section class="portal-grid"><article class="panel member-plan-card"><div class="panel-heading"><div><h2>اشتراكك الحالي</h2><p>${planInfo.plan.name} · ${planInfo.sessions} تدريبات شهريًا</p></div><span class="plan-icon">✦</span></div><div class="plan-progress"><div><span>التدريبات المتبقية</span><strong>${arabicDigits(sessionsLeft)}</strong></div><div class="progress-track"><i style="width:${percent}%"></i></div><small>الأيام المختارة: ${escapeHtml(user.weeklyDays.join("، ") || "لم تختر بعد")}</small></div><button class="text-link" data-view="subscription">تعديل أيام التدريب والاشتراك <span>←</span></button></article>
    <article class="panel next-session-card"><div class="panel-heading"><div><h2>مواعيدك المرشحة</h2><p>المواعيد التي اختارها المشرف للاعب</p></div><span class="session-sport">🏀</span></div>${nextSession ? `<div class="next-session-details"><strong>${escapeHtml(nextSession.title)}</strong><span>${escapeHtml(sessionDays(nextSession).join("، "))} · ${escapeHtml(nextSession.time)}</span><span>${escapeHtml(nextSession.place)} · ${escapeHtml(nextSession.coach)}</span></div>` : '<div class="empty-state"><p>لا توجد تدريبات مجدولة لفئتك حتى الآن.</p></div>'}<button class="text-link" data-view="schedule">عرض الجدول الكامل <span>←</span></button></article></section>
    <section class="panel upcoming-panel"><div class="panel-heading"><div><h2>تنبيهات تهمك</h2><p>ابقَ على اطلاع بحسابك وتدريباتك</p></div></div>${notices.length ? notices.map((notice, index) => `<div class="notice-item"><span class="notice-icon ${index ? "status-soon" : state.className}">!</span><span><strong>${escapeHtml(notice)}</strong><small>${index === 0 ? escapeHtml(noticeMessage) : "تابع صفحة الحضور والمدفوعات لمزيد من التفاصيل."}</small></span></div>`).join("") : `<div class="notice-item"><span class="notice-icon ${state.className}">!</span><span><strong>${escapeHtml(noticeTitle)}</strong><small>${escapeHtml(noticeMessage)}</small></span></div>`}</section>`;
}

async function toggleUserNotifications() {
  if (!["guardian", "member"].includes(currentUser?.role)) { showToast("إشعارات الهاتف متاحة من حساب ولي الأمر أو اللاعب فقط."); return; }
  try {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) {
      throw new Error("إشعارات الهاتف تحتاج فتح الأكاديمية من رابط HTTPS، وليس من ملف على الجهاز.");
    }
    if (!("Notification" in window)) throw new Error("هذا المتصفح لا يدعم إشعارات الهاتف.");
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") throw new Error("لم يتم السماح بالإشعارات. فعّلها من إعدادات المتصفح ثم حاول مرة أخرى.");
    const firebase = await window.firebaseReady;
    await firebase.subscribeGuardianToNotifications(currentUser);
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
        return `<li><strong>${escapeHtml(item.title)}</strong> · ${escapeHtml(sessionCategoryLabel(item))} · ${escapeHtml(item.coach)} · ${arabicDigits(count)} لاعب</li>`;
      }).join("");
      return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(sessionTimeRange(session))}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(session.place)}</strong><ul class="training-exercise-summary">${details}</ul></div><div class="schedule-actions"><button type="button" data-action="take-attendance" data-session="${escapeHtml(session.id)}">كشف الساعة</button><button type="button" data-action="day-off" data-session="${escapeHtml(session.id)}">إعلان إجازة</button><button type="button" data-action="edit-session" data-session="${escapeHtml(session.id)}">تعديل الساعة</button><button type="button" data-action="delete-session" data-session="${escapeHtml(session.id)}">حذف الساعة</button></div></article>`;
    }).join("")}</div>`;
  }
  return `<div class="schedule-list">${sessions.map(session => { const days = sessionDays(session); const playerCount = data.users.filter(user => user.role === "member" && sessionIncludesMember(session, user) && (user.weeklyDays || []).some(day => days.includes(day))).length; const categoryLabel = member ? (sessionMatchesMemberDays(session, member) ? "مناسب لأيام تدريبك" : "موعد متاح لفئتك") : sessionCategoryLabel(session); return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(sessionTimeRange(session))}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.place)} · ${escapeHtml(session.coach)}</span>${showCoach ? `<small>الفئة: ${escapeHtml(sessionCategoryLabel(session))} · ${arabicDigits(playerCount)} لاعب مسجل</small>` : ""}</div>${showCoach ? `<div class="schedule-actions"><button type="button" data-action="take-attendance" data-session="${escapeHtml(session.id)}">كشف الحضور</button><button type="button" data-action="edit-session" data-session="${escapeHtml(session.id)}">تعديل</button><button type="button" data-action="delete-session" data-session="${escapeHtml(session.id)}">حذف</button></div>` : `<span class="schedule-category">${escapeHtml(categoryLabel)}</span>`}</article>`; }).join("")}</div>`;
}

function memberScheduleView() {
  const user = userForMember();
  if (!user) return "";
  const availableSessions = sessionsForMember(user).filter(session => sessionMatchesMemberDays(session, user));
  const selectedSessions = selectedSessionsForMember(user);
  const selectedIds = new Set(selectedSessions.map(session => session.id));
  const selectionForm = availableSessions.length ? `<section class="panel"><div class="panel-heading"><div><h2>اختر مواعيدك المفضلة</h2><p>اختر الوقت والمجموعة المناسبة من المواعيد المتاحة لأيام تدريبك. حفظ الموعد لا يفعّل الاشتراك؛ يلزم تأكيد الدفع.</p></div></div><form id="member-sessions-form"><div class="session-choice-list">${availableSessions.map(session => `<label class="session-choice"><input type="checkbox" name="sessionIds" value="${escapeHtml(session.id)}" ${selectedIds.has(session.id) ? "checked" : ""}><span><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(sessionTimeRange(session))} · ${escapeHtml(session.place)} · ${escapeHtml(session.coach)}</small></span></label>`).join("")}</div><button class="primary-button" type="submit">حفظ المواعيد المختارة</button></form></section>` : `<section class="panel"><div class="empty-state"><p>لا توجد مواعيد لفئتك وأيام تدريبك حاليًا. تواصل مع المشرف أو راجع أيام الاشتراك.</p></div></section>`;
  const sessions = selectedSessions.length ? selectedSessions : sessionsForMember(user);
  return `<section class="page-intro"><div><p class="eyebrow">جدولك الرياضي</p><h1>تدريبات ${escapeHtml(user.category)}</h1><p class="welcome-subtitle">اختر وقت تدريبك من المواعيد التي أضافها المشرف؛ يمكنك تحديث اختيارك لاحقًا.</p></div></section>${selectionForm}<section class="panel schedule-panel"><div class="panel-heading"><div><h2>${selectedSessions.length ? "مواعيدك المختارة" : "المواعيد المتاحة لفئتك"}</h2><p>${arabicDigits(sessions.length)} حصص على الجدول</p></div></div>${sessionCards(sessions, false, user)}</section>`;
}

function memberAttendanceView() {
  const user = userForMember();
  if (!user) return "";
  const records = data.attendance.filter(record => record.playerId === user.id).sort((a, b) => b.timestamp - a.timestamp);
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
      return `<div class="attendance-day-entry"><div><strong>${escapeHtml(item.session.title)}</strong><small>${escapeHtml(sessionTimeRange(item.session))}</small></div><span class="subscription-badge ${badgeClass}">${escapeHtml(label)}</span>${item.record?.registeredAt && label !== "غائب" ? `<small>وقت الوصول: ${escapeHtml(item.record.registeredAt)}</small>` : ""}${next ? `<small>الموعد القادم: ${escapeHtml(weekdayForDate(localDateString(next.date)))} ${escapeHtml(egyptianDate.format(next.date))} · ${escapeHtml(sessionTimeRange(next.session))}</small>` : ""}</div>`;
    }).join("") : '<small>لا يوجد موعد محدد</small>';
    return `<article class="attendance-day-card"><strong>${escapeHtml(day)}</strong><span class="attendance-day-date">${escapeHtml(egyptianDate.format(date))}</span>${entries}</article>`;
  }).join("")}</div>` : '<div class="empty-state"><p>لم تختر أيام تدريب أسبوعية بعد.</p></div>';
  const exceptions = records.filter(record => record.status === "معذور" || record.status === "استثناء");
  const exceptionList = exceptions.length ? `<div class="attendance-exception-list">${exceptions.map(record => `<div class="attendance-exception-row"><span class="subscription-badge status-soon">استثناء</span><strong>${escapeHtml(weekdayForDate(record.isoDate))} · ${escapeHtml(record.date)}</strong><span>${escapeHtml(record.sessionTitle)} · وصل الساعة ${escapeHtml(record.registeredAt || "—")}</span></div>`).join("")}</div>` : "";
  return `<section class="page-intro"><div><p class="eyebrow">حساب اللاعب</p><h1>الحضور والغياب</h1><p class="welcome-subtitle">تابع أيام تدريبك وتاريخ كل حصة وحالة حضورك ووقت وصولك.</p></div></section><section class="coach-code-value player-code-panel"><span>كود اللاعب</span><strong>${escapeHtml(user.playerCode)}</strong><button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(user.playerCode)}">نسخ الكود</button></section><section class="panel"><div class="panel-heading"><div><h2>كشف أيام التدريب لهذا الأسبوع</h2><p>أيامك المختارة وتاريخ كل يوم وحالة الحضور، مع وقت الوصول والموعد القادم عند التأخير.</p></div></div>${weekGrid}${exceptionList ? `<div class="attendance-exceptions"><h3>استثناءات الحضور في أيام أخرى</h3>${exceptionList}</div>` : ""}</section><section class="panel"><div class="panel-heading"><div><h2>مواعيد التمرين المرشحة</h2><p>كل مواعيد فئتك التي أضافها المشرف؛ الأيام المناسبة لاشتراكك مميزة.</p></div></div>${sessionCards(schedules, false, user)}</section><section class="panel"><div class="panel-heading"><div><h2>سجل الحضور والغياب</h2><p>يظهر هنا تاريخ الحصة وموعدها ووقت وصول اللاعب. يمكن طلب تعويض الغياب في أي يوم قبل نهاية الاشتراك، بعد موافقة المشرف.</p></div></div>${records.length ? `<div class="table-wrap"><table><thead><tr><th>التدريب</th><th>تاريخ الحصة وموعدها</th><th>وقت الحضور</th><th>الحالة / الاستثناء</th></tr></thead><tbody>${records.map(record => { const request = makeUpRequestFor(record); const exceptionLabel = request ? `استثناء ${request.status}` : ""; const exceptionAction = !request && canRequestMakeup(user, record) ? `<button class="small-action" data-action="request-makeup" data-attendance="${escapeHtml(record.id)}">طلب استثناء</button>` : ""; const statusLabel = record.status === "معذور" ? "استثناء" : record.status || "حاضر"; return `<tr><td>${escapeHtml(record.sessionTitle)}</td><td>${escapeHtml(record.date)} · ${escapeHtml(record.sessionTime || "—")}</td><td>${escapeHtml(record.registeredAt || "—")}</td><td><span class="subscription-badge ${record.status === "غائب" ? "status-expired" : record.status === "معذور" || record.status === "متأخر" ? "status-soon" : "status-active"}">${escapeHtml(statusLabel)}</span>${exceptionLabel ? `<small class="table-subtext">${escapeHtml(exceptionLabel)}${request.date ? ` · ${escapeHtml(request.date)} ${escapeHtml(request.time || "")} · ${escapeHtml(request.sessionTitle || "")}` : ""}</small>` : ""}${exceptionAction}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد سجلات حضور بعد.</p></div>'}</section>`;
}

function memberSubscriptionView() {
  const user = userForMember();
  if (!user) return "";
  const selectedDays = user.weeklyDays || [];
  const summary = priceSummary(selectedDays.length || user.weeklyDaysCount);
  const state = subscriptionState(user);
  const endDate = user.subscriptionEnd ? egyptianDate.format(new Date(`${user.subscriptionEnd}T12:00:00`)) : "لم يتم التفعيل بعد";
  const daysInput = dayCheckboxes(data.workDays, selectedDays);
  const pendingPayment = hasPendingPayment(user);
  const hasChosenSession = selectedSessionsForMember(user).length > 0;
  const walletBalance = memberWalletBalance(user);
  const renewalAmountDue = Math.max(0, summary.plan.price - walletBalance);
  return `<section class="page-intro"><div><p class="eyebrow">باقتك وتدريباتك</p><h1>اشتراك ${escapeHtml(summary.plan.name)}</h1><p class="welcome-subtitle">اختر أيام حضورك الأسبوعية، ويُحسب الاشتراك حسب عددها.</p></div><span class="subscription-badge ${state.className}">${state.label}</span></section>
    <section class="pricing-hero"><span class="pricing-kicker">سعر الاشتراك الشهري</span><div class="pricing-number">${arabicDigits(summary.plan.price)} <small>ج.م / شهر · ${summary.sessions} تدريبات</small></div><p>سعر التدريب الواحد ${arabicDigits(summary.sessionPrice)} ج.م · يحدّد المدرب الأسعار من لوحة الأكاديمية.</p></section>
    <section class="member-stats plan-details"><article class="member-stat"><p>التدريبات المستخدمة</p><strong>${arabicDigits(user.sessionsUsed || 0)}</strong><small>تُخصم عند تأكيد الحضور</small></article><article class="member-stat"><p>تاريخ نهاية الاشتراك</p><strong>${endDate}</strong><small>الحالة: ${state.label}</small></article><article class="member-stat"><p>رصيد المحفظة</p><strong>${arabicDigits(walletBalance)} ج.م</strong><small>المستحق بعد الخصم: ${arabicDigits(renewalAmountDue)} ج.م</small></article><article class="member-stat"><p>كود اللاعب</p><strong class="player-code">${escapeHtml(user.playerCode)}</strong><small>تاريخ الانضمام: ${joinedDate(user)}</small></article></section>
    <section class="panel plan-options"><div class="panel-heading"><div><h2>أيام تدريبك الأسبوعية</h2><p>اختر من أيام عمل الأكاديمية المحددة من المدرب.</p></div></div>${data.workDays.length ? `<form id="member-days-form"><div class="day-choice-grid member-day-grid">${daysInput}</div><p id="member-days-price" class="price-preview">${selectedDays.length ? `اشتراكك الحالي: ${arabicDigits(summary.plan.price)} ج.م شهريًا` : "اختر يومًا واحدًا على الأقل."}</p><button class="primary-button" type="submit">حفظ أيام التدريب <span>←</span></button></form>` : '<div class="empty-state"><p>لم يحدد المدرب أيام العمل بعد.</p></div>'}<div class="payment-cta"><strong>السعر ${arabicDigits(summary.plan.price)} ج.م · رصيد ${arabicDigits(walletBalance)} ج.م · المستحق ${arabicDigits(renewalAmountDue)} ج.م</strong><button class="primary-button" data-action="payment" ${selectedDays.length && hasChosenSession && canRequestPayment(user) && !pendingPayment && !hasPartialCashPayment(user) ? "" : "disabled"}>${pendingPayment ? "طلب الدفع قيد المراجعة" : hasPartialCashPayment(user) ? "أكمل الدفع النقدي لدى الأكاديمية" : !hasChosenSession ? "اختر مواعيدك أولًا" : canRequestPayment(user) ? renewalAmountDue ? "تجديد / دفع الاشتراك" : "تجديد باستخدام رصيد المحفظة" : "الدفع متاح عند تبقي تمرين واحد"} <span>←</span></button></div></section>`;
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
  const renewalAmountDue = Math.max(0, priceSummary(user.weeklyDays?.length || user.weeklyDaysCount).plan.price - walletBalance);
  const paymentBlockedMessage = hasPartialCashPayment(user)
    ? "لديك دفعة نقدية جزئية. أكمل المبلغ المتبقي لدى الأكاديمية لتفعيل الاشتراك."
    : !hasChosenSession ? "اختر مواعيد التدريب أولًا من صفحة جدول التدريبات."
      : `لا يمكن الدفع الآن. يتاح التجديد عند تبقي تمرين واحد أو انتهاء الاشتراك. المتبقي حاليًا ${arabicDigits(user.sessionsLeft || 0)} تمرين.`;
  return `<section class="page-intro"><div><p class="eyebrow">إنستا باي / محفظة بنكية</p><h1>المدفوعات والاشتراك</h1><p class="welcome-subtitle">سجّل كود التحويل لإرساله إلى الأكاديمية عبر واتساب.</p></div></section>
    <section class="instapay-panel"><span class="instapay-brand">⇄</span><div><h2>ادفع اشتراكك عبر إنستا باي / محفظة بنكية</h2><p>${paymentAllowed ? `سعر التجديد بعد خصم رصيد محفظتك (${arabicDigits(walletBalance)} ج.م): ${arabicDigits(renewalAmountDue)} ج.م.` : paymentBlockedMessage}</p><div class="instapay-hint"><span>رصيدك الدائن</span><strong>${arabicDigits(walletBalance)} ج.م</strong></div><div class="instapay-hint"><span>رقم / عنوان التحويل</span>${address}</div><p class="payment-warning">بعد فتح واتساب أرفق صورة إيصال التحويل المحفوظة على هاتفك يدوياً إذا كان هناك مبلغ مطلوب تحويله. لا تُرفع صورة إلى الموقع.</p></div><button class="primary-button" data-action="payment" ${paymentAllowed ? "" : "disabled"}>${paymentAllowed ? renewalAmountDue ? "تسجيل تحويل جديد" : "تجديد باستخدام رصيد المحفظة" : "التجديد غير متاح الآن"} <span>←</span></button></section>
    <section class="panel payment-history"><div class="panel-heading"><div><h2>سجل طلبات الدفع</h2><p>حالة كل تحويل أو مبلغ نقدي مسجل</p></div></div>${payments.length ? `<div class="history-list">${payments.map(payment => `<div class="history-item"><span class="payment-icon">⇄</span><span><strong>${escapeHtml(payment.planName)} · ${arabicDigits(payment.amount)} ج.م</strong><small>${escapeHtml(paymentMethodLabel(payment))} · ${escapeHtml(payment.reference)} · ${escapeHtml(payment.date)}</small>${payment.walletCreditUsedAmount ? `<small>رصيد مستخدم: ${arabicDigits(payment.walletCreditUsedAmount)} ج.م</small>` : ""}${payment.walletCreditAddedAmount ? `<small>رصيد دائن مضاف: ${arabicDigits(payment.walletCreditAddedAmount)} ج.م</small>` : ""}${payment.reference && payment.method !== "cash" && payment.reference !== "رصيد محفظة اللاعب" ? `<button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(payment.reference)}">نسخ رقم التحويل</button>` : ""}</span><span class="subscription-badge ${isRecordedPayment(payment) && payment.status !== "دفع جزئي نقدًا" ? "status-active" : "status-soon"}">${escapeHtml(payment.status)}</span></div>`).join("")}</div>` : '<div class="empty-state"><p>لا توجد طلبات دفع بعد.</p></div>'}</section>`;
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
  return `<section class="portal-welcome"><div><p class="eyebrow"><span class="live-dot"></span>${egyptianDate.format(new Date())}</p><h1>أهلًا ${OWNER_NAME} <span class="wave">✦</span></h1><p class="welcome-subtitle">إدارة الأكاديمية، المدربين، حضور اللاعبين والحسابات المالية.</p></div><button class="primary-button" data-action="new-session"><span>＋</span> إضافة تدريب</button></section>
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
  return `<section class="portal-welcome"><div><p class="eyebrow">فريق التدريب</p><h1>أهلًا كابتن ${escapeHtml(currentUser.name)}</h1><p class="welcome-subtitle">راجع جدول الحصص المسندة إليك. تسجيل الحضور وتأكيد التحويلات من صلاحية المشرف.</p></div></section><section class="panel schedule-panel"><div class="panel-heading"><div><h2>حصصي التدريبية</h2><p>${arabicDigits(sessions.length)} حصص مسندة إليك</p></div></div>${sessionCards(sessions)}</section>`;
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
  openModal(title, `${nameField}<fieldset class="registration-birth-date"><legend>تاريخ ميلاد اللاعب</legend><div class="birth-date-fields"><label>اليوم<input name="birthDay" type="text" inputmode="numeric" pattern="[0-9٠-٩]{1,2}" maxlength="2" required placeholder="يوم"></label><label>الشهر<input name="birthMonth" type="text" inputmode="numeric" pattern="[0-9٠-٩]{1,2}" maxlength="2" required placeholder="شهر"></label><label>السنة<input name="birthYear" type="text" inputmode="numeric" pattern="[0-9٠-٩]{4}" maxlength="4" required placeholder="سنة"></label></div></fieldset><fieldset class="registration-days"><legend>أيام حضور اللاعب أسبوعيًا</legend><div class="day-choice-grid">${dayCheckboxes(data.workDays, player?.weeklyDays || [])}</div></fieldset><p class="modal-explainer">${isExistingPlayer ? `كود اللاعب ${escapeHtml(player.playerCode)} ثابت ولن يتغير.` : "سيُنشأ كود رقمي ثابت للاعب تلقائيًا. يعرضه اللاعب للمشرف لتسجيل حضوره."}</p>`, isExistingPlayer ? "حفظ البيانات" : "حفظ اللاعب", form => savePlayer(form, player?.id), "حساب ولي الأمر");
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
  const weeklyDays = form.getAll("weeklyDays").map(String).filter(day => data.workDays.includes(day));
  const birthday = new Date(`${birthDate}T12:00:00`);
  if (name.length < 2 || !Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year) || year < 1000 || Number.isNaN(birthday.getTime()) || birthday.getFullYear() !== year || birthday.getMonth() !== month - 1 || birthday.getDate() !== day) {
    showToast("أدخل يومًا وشهرًا وسنة صحيحة لتاريخ الميلاد.");
    return;
  }
  if (!weeklyDays.length) { showToast("اختر يوم تدريب واحدًا على الأقل للاعب."); return; }
  const guardian = currentUser;
  const existingPlayer = playerId ? data.users.find(user => user.id === playerId && user.role === "member" && user.guardianId === guardian.id) : null;
  if (playerId && !existingPlayer) { showToast("لم يتم العثور على اللاعب في حساب ولي الأمر."); return; }
  const user = {
    ...(existingPlayer || {}),
    id: existingPlayer?.id || crypto.randomUUID(), role: "member", guardianId: guardian.id,
    playerCode: existingPlayer?.playerCode || "", joinedAt: existingPlayer?.joinedAt || new Date().toISOString(),
    name, birthDate, guardian: guardian.name, guardianPhone: guardian.guardianPhone,
    whatsappPhone: guardian.whatsappPhone, category: playerCategoryForBirthDate(birthDate),
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
    return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(sessionTimeRange(session))}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(categories)}</strong><span>${exercises} · ${arabicDigits(players.size)} لاعب مسجل</span></div><div class="schedule-actions"><button class="small-action" data-action="take-attendance" data-session="${escapeHtml(session.id)}">كشف الساعة</button><button class="small-action" data-action="day-off" data-session="${escapeHtml(session.id)}">إعلان إجازة</button></div></article>`;
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
      return `<article class="roster-row"><div><strong>${escapeHtml(player.name)}</strong><small>كود اللاعب: ${escapeHtml(player.playerCode)} · ${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} ${escapeHtml(sessionTimeRange(session))}</small></div><button type="button" class="small-action" data-action="trainer-mark-attendance" data-player="${escapeHtml(player.id)}" data-session="${escapeHtml(session.id)}" ${alreadyRecorded ? "disabled" : ""}>${alreadyRecorded ? "تم التسجيل اليوم" : "تسجيل الحضور"}</button></article>`;
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
  const availableSessions = data.sessions.filter(session => !attendanceWindowError(session, localDateString(now), now));
  const slots = attendanceSlots(availableSessions);
  if (!slots.length) { showToast("لا توجد حصة متاحة للحضور في الساعة الحالية. تحقق من وقت الحصص وأيامها في الجدول."); return; }
  const selectedSlotId = slots.length === 1 ? slots[0].id : "";
  const options = slots.map(slot => {
    const session = slot.sessions[0];
    return `<option value="${escapeHtml(slot.id)}" ${slot.id === selectedSlotId ? "selected" : ""}>${escapeHtml(sessionTimeRange(session))}</option>`;
  }).join("");
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal("تسجيل حضور بكود اللاعب", `<p class="attendance-current-time">الساعة الحالية: <strong id="attendance-current-time">${currentTime}</strong> <button type="button" class="small-action" id="refresh-attendance-time">تحديث الساعة الحالية</button></p><label>ساعة التدريب<select name="slotId" required>${slots.length > 1 ? '<option value="">اختر الساعة</option>' : ""}${options}</select></label><label>كود اللاعب<input name="playerCode" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{6}" minlength="6" maxlength="6" required placeholder="الكود الرقمي المكوّن من ٦ أرقام"></label><p class="modal-explainer">تظهر ساعات التدريب المفتوح تسجيل الحضور فيها الآن فقط. يُسجّل اللاعب تلقائيًا في تمرينه المناسب.</p>`, "تسجيل الحضور الآن", form => saveCodeAttendance(form), "الحضور والغياب");
  const form = byId("action-form");
  form.querySelector("#refresh-attendance-time").addEventListener("click", openCodeAttendanceForm);
}

function saveCodeAttendance(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الحضور بالكود من صلاحية المشرف فقط."); return; }
  const code = normalizeDigits(String(form.get("playerCode")).trim());
  const player = data.users.find(user => user.role === "member" && user.playerCode === code);
  const availableSessions = data.sessions.filter(session => !attendanceWindowError(session, localDateString()));
  const slot = attendanceSlots(availableSessions).find(item => item.id === form.get("slotId"));
  if (!player) { showToast("كود اللاعب غير موجود. راجع الرقم وحاول مرة أخرى."); return; }
  if (!slot) { showToast("ساعة التدريب المختارة غير متاحة لتسجيل الحضور في الوقت الحالي."); return; }
  const session = sessionForPlayerInSlot(player, slot);
  if (!session) { showToast("اللاعب لا ينتمي إلى أي فئة من فئات التمارين المتاحة في هذه الساعة."); return; }
  if (data.attendance.some(record => record.playerId === player.id && slot.sessions.some(item => item.id === record.sessionId) && record.isoDate === localDateString())) {
    showToast(`تم تسجيل حضور ${player.name} لهذه الساعة اليوم بالفعل.`);
    return;
  }
  registerPlayerAttendance(player, session, new Date(), true);
}

function registerPlayerAttendance(player, session, dateTime = new Date(), keepCodeEntryOpen = false) {
  const isoDate = localDateString(dateTime);
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
  if (saveData()) {
    if (keepCodeEntryOpen) {
      const codeInput = byId("action-form").querySelector('input[name="playerCode"]');
      codeInput.value = "";
      codeInput.focus();
    } else {
      closeModal();
      renderView();
    }
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

function coachPlayersView() {
  const users = data.users.filter(user => user.role === "member");
  const guardians = data.users.filter(user => user.role === "guardian");
  const guardianRows = guardians.map(guardian => {
    const children = childrenForGuardian(guardian.id);
    return `<tr><td>${escapeHtml(guardian.name)}</td><td>${escapeHtml(guardian.guardianPhone || "—")}<br>${escapeHtml(guardian.whatsappPhone || "—")}</td><td>${escapeHtml(guardian.email || "—")}</td><td>${children.map(child => `${escapeHtml(child.name)} · ${escapeHtml(child.birthDate || "—")} · كود ${escapeHtml(child.playerCode)}`).join("<br>") || "لا يوجد لاعبون"}</td><td><button class="small-action danger-action" data-action="delete-guardian" data-guardian="${escapeHtml(guardian.id)}">حذف ولي الأمر وأبنائه</button></td></tr>`;
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
    const cashRemaining = Math.max(0, priceSummary(user.weeklyDays?.length || user.weeklyDaysCount).plan.price - cashPartial);
    const cashDebt = Math.max(0, Number(user.cashDebt || 0));
    const walletBalance = memberWalletBalance(user);
    return `<tr><td class="player-code">${escapeHtml(user.playerCode)}</td><td>${escapeHtml(user.name)}<small class="table-subtext">${escapeHtml(guardian?.name || user.guardian || "")}</small></td><td>${escapeHtml(user.birthDate || "—")}<br>${escapeHtml(user.category)}</td><td>${escapeHtml((user.weeklyDays || []).join("، ") || "لم يختر")}<br>${schedules || "لا توجد مجموعة مرشحة"}</td><td>${arabicDigits(totalPaid)} ج.م${walletBalance ? `<small class="table-subtext">رصيد دائن بالمحفظة: ${arabicDigits(walletBalance)} ج.م</small>` : ""}${cashPartial ? `<small class="table-subtext">دفع نقدًا ${arabicDigits(cashPartial)} ج.م · المتبقي ${arabicDigits(cashRemaining)} ج.م لإكمال الاشتراك</small>` : ""}${cashDebt ? `<small class="table-subtext">مديونية قائمة: ${arabicDigits(cashDebt)} ج.م</small>` : ""}</td><td>${latestPayment ? `${escapeHtml(paymentMethodLabel(latestPayment))} · ${escapeHtml(latestPayment.date || "—")} · ${escapeHtml(latestPayment.paidTime || "—")}` : "لا توجد دفعات مؤكدة"}</td><td>${user.subscriptionEnd ? egyptianDate.format(new Date(`${user.subscriptionEnd}T12:00:00`)) : "غير مفعّل"}<br><span class="subscription-badge ${state.className}">${state.label}</span><br>متبقي ${arabicDigits(user.sessionsLeft || 0)} تمرين</td><td><button class="small-action" data-action="cash-payment" data-player="${escapeHtml(user.id)}" ${canRequestPayment(user) ? "" : "disabled"}>تسجيل دفع نقدي</button>${cashDebt ? `<button class="small-action" data-action="cash-debt-payment" data-player="${escapeHtml(user.id)}">تحصيل المديونية</button>` : ""}${state.label === "منتهي" ? guardianWhatsApp(user, expiredMessage, "إشعار انتهاء الاشتراك") : ""}</td></tr>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">متابعة الحسابات والاشتراكات</p><h1>أولياء الأمور واللاعبون</h1><p class="welcome-subtitle">تظهر بيانات اللاعب وتاريخ ميلاده ومواعيده ومجموع ما دفعه. حذف الحساب لا يحذف السجلات المالية.</p></div></section><section class="panel"><div class="panel-heading"><div><h2>حسابات أولياء الأمور</h2><p>${arabicDigits(guardians.length)} ولي أمر · الحذف يزيل ولي الأمر وأطفاله فقط، وتبقى السجلات المالية محفوظة.</p></div></div>${guardians.length ? `<div class="table-wrap"><table><thead><tr><th>ولي الأمر</th><th>الهاتف / واتساب</th><th>البريد الإلكتروني</th><th>اللاعبون</th><th>إجراء الحساب</th></tr></thead><tbody>${guardianRows}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد حسابات أولياء أمور بعد.</p></div>'}</section><section class="panel"><div class="panel-heading"><div><h2>سجل اللاعبين والاشتراكات</h2><p>كل الدفعات تبقى مسجلة ولا يمكن حذفها من سجل الدفع.</p></div></div>${users.length ? `<div class="table-wrap"><table><thead><tr><th>كود اللاعب</th><th>اللاعب / ولي الأمر</th><th>تاريخ الميلاد والفئة</th><th>أيام التدريب والمواعيد</th><th>إجمالي ما دفع</th><th>آخر دفعة: الطريقة والتاريخ والوقت</th><th>الانتهاء والحالة</th><th>إجراء</th></tr></thead><tbody>${playerRows}</tbody></table></div>` : '<div class="empty-state"><p>لا يوجد لاعبون مسجلون بعد.</p></div>'}</section>`;
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
  const payments = [...data.payments].sort((a, b) => b.createdAt - a.createdAt);
  const paymentRows = payments.map(payment => {
    const user = data.users.find(item => item.id === payment.playerId);
    const paid = isRecordedPayment(payment);
    const paidMessage = payment.status === "سداد مديونية نقدية"
      ? `تم تسجيل سداد مديونية اللاعب ${payment.playerName} بقيمة ${payment.amount} ج.م.`
      : `تم تأكيد دفع اشتراك اللاعب ${payment.playerName} بقيمة ${payment.amount} ج.م وتفعيل الاشتراك.`;
    const paymentTime = payment.paidTime || new Date(payment.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    const requiresResubmission = payment.status === "بانتظار المراجعة"
      && (payment.method !== "instapay"
        || !Number.isInteger(Number(payment.planId))
        || Number(payment.planId) < 1
        || Number(payment.planId) > 7
        || !Number.isInteger(Number(payment.amount))
        || Number(payment.amount) < 0);
    const action = payment.status !== "بانتظار المراجعة"
      ? `<span class="subscription-badge ${paid ? "status-active" : "status-soon"}">${escapeHtml(payment.status)}</span>${paid && user ? guardianWhatsApp(user, paidMessage, "إشعار الدفع") : ""}`
      : requiresResubmission
        ? `<button class="small-action" data-action="reject-payment" data-payment="${escapeHtml(payment.id)}">رفض لإعادة تقديمه بالسعر الكامل</button>`
        : `<button class="small-action" data-action="confirm-payment" data-payment="${escapeHtml(payment.id)}" ${user && canRequestPayment(user) ? "" : "disabled"}>مراجعة المبلغ وتأكيده</button>`;
    return `<tr><td>${escapeHtml(payment.playerName)}</td><td>${escapeHtml(payment.planName)}${payment.originalPlanName && payment.originalPlanName !== payment.planName ? `<small class="table-subtext">الباقة المطلوبة: ${escapeHtml(payment.originalPlanName)}</small>` : ""}<br><strong>${arabicDigits(payment.amount)} ج.م</strong>${payment.walletCreditReserved ? `<small class="table-subtext">رصيد محفظة مستخدم/محجوز: ${arabicDigits(payment.walletCreditReserved)} ج.م</small>` : ""}${payment.walletCreditAddedAmount ? `<small class="table-subtext">رصيد دائن مضاف: ${arabicDigits(payment.walletCreditAddedAmount)} ج.م</small>` : ""}${payment.walletCreditUsedAmount ? `<small class="table-subtext">رصيد مخصوم: ${arabicDigits(payment.walletCreditUsedAmount)} ج.م</small>` : ""}${payment.siblingDiscount ? `<small class="table-subtext">خصم إخوة ${arabicDigits(payment.siblingDiscount)} ج.م</small>` : ""}${payment.specialDiscountAmount ? `<small class="table-subtext">خصم استثنائي ${arabicDigits(payment.specialDiscountAmount)} ج.م</small>` : ""}${payment.debtAddedAmount ? `<small class="table-subtext">مديونية مضافة ${arabicDigits(payment.debtAddedAmount)} ج.م</small>` : ""}</td><td>${escapeHtml(payment.method === "cash" ? "نقدي" : payment.methodLabel || "تحويل")}</td><td><strong class="payment-reference">${escapeHtml(payment.reference || "—")}</strong>${payment.reference && payment.method !== "cash" ? `<button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(payment.reference)}">نسخ كود الدفع</button>` : ""}</td><td>${payment.receiptImage ? `<button type="button" class="receipt-preview" data-action="receipt-preview" data-receipt="${escapeHtml(payment.receiptImage)}" data-player="${escapeHtml(payment.playerName)}"><img class="receipt-thumbnail" src="${escapeHtml(payment.receiptImage)}" alt="إيصال تحويل ${escapeHtml(payment.playerName)}"><span>اضغط لتكبير الإيصال</span></button>` : "—"}</td><td>${escapeHtml(payment.date)}<br>${escapeHtml(paymentTime)}</td><td>${action}</td></tr>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">التحصيل المالي</p><h1>طلبات الدفع</h1><p class="welcome-subtitle">راجع كود التحويل والرسالة الواردة عبر واتساب قبل تأكيد أي دفعة.</p></div><button class="primary-button" data-action="instapay-settings">بيانات التحويل</button></section>
    <section class="instapay-panel coach-instapay"><span class="instapay-brand">⇄</span><div><h2>بيانات التحويل الحالية</h2><p>${data.instaPayAddress ? escapeHtml(data.instaPayAddress) : "لم تتم إضافة بيانات الدفع بعد."}</p></div></section>
    <section class="panel">${payments.length ? `<div class="table-wrap"><table><thead><tr><th>اللاعب</th><th>الباقة والمبلغ</th><th>طريقة الدفع</th><th>مرجع / كود الدفع</th><th>الإيصال</th><th>تاريخ وساعة الدفع</th><th>الحالة والإجراء</th></tr></thead><tbody>${paymentRows}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد تحويلات مسجلة حتى الآن.</p></div>'}</section>`;
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
  byId("action-modal").classList.remove("open");
  byId("action-modal").setAttribute("aria-hidden", "true");
}

function requestPayment(planId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الدفع متاحة من حساب ولي الأمر فقط."); return; }
  const player = userForMember();
  if (!player) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
  if (currentUser.role !== "guardian") { showToast("إرسال طلب إنستا باي متاح من حساب ولي الأمر."); return; }
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
  const paymentOptions = selectablePlayers.map(item => {
    const checked = item.player.id === player.id;
    const startDateField = item.eligible && canChooseSubscriptionStartDate(item.player)
      ? `<label class="expected-start-picker">تاريخ بداية التدريب<input type="date" name="expectedStartDate-${escapeHtml(item.player.id)}" min="${localDateString()}" value="${expectedStartDateFor(item.player)}" ${checked ? "required" : "disabled"}></label>`
      : `<small class="expected-start-note">${item.eligible ? "سيبدأ التجديد بعد انتهاء الاشتراك الحالي." : ""}</small>`;
    const transferDue = Math.max(0, item.plan.price - item.walletCreditReserved);
    return `<div class="cash-sibling-option"><label class="cash-sibling-choice"><input type="checkbox" name="playerIds" value="${escapeHtml(item.player.id)}" ${checked ? "checked data-primary-player" : ""} ${item.eligible ? "" : "disabled"}><span><strong>${escapeHtml(item.player.name)}</strong><small>${escapeHtml(item.plan.name)} · السعر ${arabicDigits(item.plan.price)} ج.م · رصيد ${arabicDigits(item.walletCreditReserved)} ج.م · التحويل ${arabicDigits(transferDue)} ج.م${item.eligible ? "" : " · غير متاح للدفع الآن"}</small></span></label>${startDateField}</div>`;
  }).join("");
  const initialQuote = subscriptionGroupQuote([eligiblePlayers.find(item => item.player.id === player.id)]);
  if (initialQuote.total && !data.instaPayAddress) { showToast("لم تضف الأكاديمية بيانات التحويل بعد. تواصل مع المدرب."); return; }
  openModal("إرسال طلب الاشتراك عبر إنستا باي", `<fieldset class="cash-sibling-list"><legend>الأبناء المراد دفع اشتراكاتهم</legend>${paymentOptions}</fieldset><p class="modal-explainer" id="instapay-payment-summary">${subscriptionGroupSummary(initialQuote)}</p><p class="payment-warning" id="instapay-transfer-guidance">${initialQuote.total ? "حوّل المبلغ المستحق إلى بيانات الأكاديمية. أرفق صورة الإيصال في رسالة واتساب؛ لا تُرفع الصورة إلى الموقع." : "رصيد المحفظة يغطي قيمة الاشتراك بالكامل؛ سيتم إرسال طلب التفعيل للمشرف دون تحويل جديد."}</p><label id="instapay-reference-field" ${initialQuote.total ? "" : "hidden"}>كود التحويل / رقم العملية<input name="reference" ${initialQuote.total ? 'required minlength="4"' : ""} maxlength="120" placeholder="رقم العملية كما يظهر في التطبيق"></label><div class="payment-destination" ${initialQuote.total ? "" : "hidden"}><span>رقم التحويل إلى الأكاديمية</span><strong>${escapeHtml(data.instaPayAddress || "")}</strong></div><label>إجمالي المبلغ المطلوب تحويله<input name="amount" type="number" value="${initialQuote.total}" readonly></label>`, "إرسال الطلب", async form => {
    if (currentUser.role !== "guardian") { showToast("إرسال طلب الاشتراك متاح من حساب ولي الأمر فقط."); return; }
    const selectedIds = [...new Set(form.getAll("playerIds").map(String))];
    const selectedPlayers = selectedIds.map(id => eligiblePlayers.find(item => item.player.id === id)).filter(Boolean);
    if (!selectedPlayers.some(item => item.player.id === player.id) || selectedPlayers.length !== selectedIds.length) {
      showToast("اختر اللاعب الأساسي وأبناء الحساب المؤهلين للدفع فقط.");
      return;
    }
    if (selectedPlayers.some(item =>
      item.player.guardianId !== currentUser.id
      || hasPendingPayment(item.player)
      || hasPartialCashPayment(item.player)
      || !canRequestPayment(item.player)
      || !selectedSessionsForMember(item.player).length
      || Number(item.player.weeklyDays?.length || item.player.weeklyDaysCount) !== item.dayCount
    )) {
      showToast("تغيرت حالة أحد اللاعبين أو أيام تدريبه. حدّث الصفحة وراجع الاختيارات.");
      return;
    }
    const startDates = new Map(selectedPlayers.map(item => {
      const expectedStartDate = canChooseSubscriptionStartDate(item.player)
        ? String(form.get(`expectedStartDate-${item.player.id}`) || "")
        : expectedStartDateFor(item.player);
      return [item.player.id, expectedStartDate];
    }));
    const invalidStartDate = selectedPlayers.find(item => {
      const expectedStartDate = startDates.get(item.player.id);
      return !isValidIsoDate(expectedStartDate)
        || (canChooseSubscriptionStartDate(item.player) && expectedStartDate < localDateString());
    });
    if (invalidStartDate) {
      showToast(`اختر تاريخ بداية صحيحًا من اليوم فصاعدًا لاشتراك ${invalidStartDate.player.name}.`);
      return;
    }
    const quote = subscriptionGroupQuote(selectedPlayers);
    const reference = String(form.get("reference") || "").trim();
    if (quote.total && !data.instaPayAddress) { showToast("لم تضف الأكاديمية بيانات التحويل بعد. تواصل مع المدرب."); return; }
    if (quote.discount !== 0
      || quote.players.some(item => item.amount !== Math.max(0, item.plan.price - item.walletCreditReserved))
      || Number(form.get("amount")) !== quote.total
      || (quote.total > 0 && (reference.length < 4 || reference.length > 120))) {
      showToast(quote.total > 0
        ? "تحقق من مبلغ التحويل ورقم العملية بعد خصم أرصدة المحفظة."
        : "تعذر التحقق من رصيد المحفظة. حدّث الصفحة وحاول مجددًا.");
      return;
    }
    const whatsappTab = quote.total > 0 ? window.open("about:blank", "_blank") : null;
    const submittedAt = Date.now();
    const allocations = allocateSiblingDiscount(quote.players, quote.discount);
    const submissions = allocations.map(allocation => {
      const payment = {
        id: crypto.randomUUID(), guardianId: currentUser.id, playerId: allocation.player.id,
        playerName: allocation.player.name, planId: allocation.dayCount, planName: allocation.plan.name,
        amount: allocation.amount,
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
      ...allocations.map(allocation => `اسم اللاعب: ${allocation.player.name} · سعر الباقة: ${arabicDigits(allocation.plan.price)} ج.م · رصيد مستخدم: ${arabicDigits(allocation.walletCreditReserved)} ج.م · المطلوب تحويله: ${arabicDigits(allocation.amount)} ج.م · بداية التدريب: ${egyptianDate.format(new Date(`${startDates.get(allocation.player.id)}T12:00:00`))}`),
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
    if (!(event.target instanceof HTMLInputElement) || event.target.name !== "playerIds") return;
    if (event.target.hasAttribute("data-primary-player") && !event.target.checked) {
      event.target.checked = true;
      return;
    }
    const selected = [...form.querySelectorAll('input[name="playerIds"]:checked')]
      .map(input => eligiblePlayers.find(item => item.player.id === input.value))
      .filter(Boolean);
    const quote = subscriptionGroupQuote(selected);
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
    eligiblePlayers.forEach(item => {
      const dateInput = form.querySelector(`input[name="expectedStartDate-${CSS.escape(item.player.id)}"]`);
      if (dateInput) {
        dateInput.disabled = !event.target.checked || event.target.value !== item.player.id;
        dateInput.required = !dateInput.disabled;
      }
    });
  });
}

function subscriptionGroupQuote(players) {
  const validPlayers = players.filter(Boolean).map(item => {
    const walletCreditReserved = memberWalletBalance(item.player);
    return {
      ...item,
      walletCreditReserved,
      amount: Math.max(0, item.plan.price - walletCreditReserved)
    };
  });
  const subtotal = validPlayers.reduce((total, item) => total + item.amount, 0);
  return {
    players: validPlayers,
    subtotal,
    discount: 0,
    total: subtotal
  };
}

function allocateSiblingDiscount(players, discount) {
  let remainingDiscount = discount;
  return players.map(item => {
    const appliedDiscount = Math.min(item.amount, remainingDiscount);
    remainingDiscount -= appliedDiscount;
    return { ...item, discount: appliedDiscount, amount: item.amount - appliedDiscount };
  });
}

function subscriptionGroupSummary(quote) {
  const breakdown = quote.players.map(item =>
    `${escapeHtml(item.player.name)}: سعر ${arabicDigits(item.plan.price)} ج.م − رصيد ${arabicDigits(item.walletCreditReserved)} ج.م = تحويل ${arabicDigits(item.amount)} ج.م`
  ).join(" · ");
  return `الاشتراكات: ${breakdown || "اختر لاعبًا واحدًا على الأقل."}<br>إجمالي التحويل بعد خصم الأرصدة الدائنة: ${arabicDigits(quote.total)} ج.م.`;
}

function trainingExerciseRows(exercises, trainers) {
  return exercises.map((exercise, index) => {
    const trainerOptions = trainers.map(trainer => `<option value="${escapeHtml(trainer.id)}" ${exercise.coachId === trainer.id ? "selected" : ""}>${escapeHtml(trainer.name)}</option>`).join("");
    const categories = new Set(exercise.categories || []);
    const categoryOptions = AGE_CATEGORIES.map(category => `<label class="day-choice"><input type="checkbox" name="categories-${index}" value="${escapeHtml(category)}" ${categories.has(category) ? "checked" : ""}><span>${escapeHtml(category)}</span></label>`).join("");
    return `<fieldset class="training-exercise"><legend>التمرين ${arabicDigits(index + 1)}</legend><label>اسم التمرين<input name="title-${index}" required maxlength="100" value="${escapeHtml(exercise.title || "")}" placeholder="تدريب كرة السلة"></label><label>المدرب المسؤول<select name="coachId-${index}" required><option value="">اختر المدرب</option>${trainerOptions}</select></label><fieldset class="registration-days"><legend>الفئات العمرية لهذا التمرين</legend><div class="day-choice-grid">${categoryOptions}</div></fieldset></fieldset>`;
  }).join("");
}

function exerciseValuesFromForm(form, count) {
  const values = form instanceof FormData ? form : new FormData(form);
  return Array.from({ length: count }, (_, index) => ({
    title: String(values.get(`title-${index}`) || ""),
    coachId: String(values.get(`coachId-${index}`) || ""),
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
  const exercises = sessions.length ? sessions.map(item => ({ ...item, categories: sessionCategories(item) })) : [{ title: "", coachId: "", categories: [] }];
  const countOptions = Array.from({ length: 12 }, (_, index) => index + 1).map(value => `<option value="${value}" ${value === count ? "selected" : ""}>${arabicDigits(value)} ${value === 1 ? "تمرين" : "تمارين"}</option>`).join("");
  const fields = `<div class="form-row session-time-row">${sessionTimePicker("time", "ساعة البداية", session.time)}${sessionTimePicker("endTime", "ساعة النهاية", session.endTime)}</div><label>عدد التمارين في هذه الساعة<select name="exerciseCount" id="training-count" required>${countOptions}</select></label><fieldset class="registration-days"><legend>أيام التدريب</legend><div class="day-choice-grid">${dayOptions}</div></fieldset><label>الملعب<input name="place" required value="${escapeHtml(session.place || "")}" placeholder="ملعب الأكاديمية"></label><div id="training-exercises">${trainingExerciseRows(exercises, trainers)}</div><p class="modal-explainer">حدد الموعد أولًا؛ كل التمارين هنا تشترك في وقت البداية والنهاية. لكل تمرين يمكن اختيار فئة عمرية ومدرب مسؤول مختلفين.</p>`;
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
    if (!String(exercise.title).trim() || !trainer || !categories.length) {
      showToast(`أكمل اسم التمرين والمدرب وفئة عمرية واحدة على الأقل للتمرين ${arabicDigits(index + 1)}.`);
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

function activateSubscription(user, planId, requestedStartDate = user.expectedStartDate) {
  const dayCount = Number(planId);
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) throw new Error("باقة الدفع غير صالحة لتفعيل الاشتراك.");
  const plan = priceSummary(dayCount).plan;
  const today = localDateString();
  const startStatus = evaluateSubscriptionStartStatus(user);
  const selectedStartDate = startStatus.status === "continuous"
    ? startStatus.firstPostExpiryAttendance
    : requestedStartDate || expectedStartDateFor(user) || today;
  if (!isValidIsoDate(selectedStartDate)) throw new Error("تاريخ بداية الاشتراك غير صالح.");
  user.plan = dayCount;
  user.weeklyDaysCount = dayCount;
  if ((user.weeklyDays || []).length !== dayCount) user.weeklyDays = data.workDays.slice(0, dayCount);
  user.sessionsLeft = plan.sessions;
  user.sessionsUsed = 0;
  const previousEndDate = user.endDate || user.subscriptionEnd;
  const extendsActiveSubscription = previousEndDate && daysUntil(previousEndDate) > 0;
  if (extendsActiveSubscription) {
    user.subscriptionStart ||= subscriptionStartDate(user) || today;
    user.expectedStartDate ||= user.subscriptionStart;
    user.endDate = addCalendarDays(previousEndDate, 30);
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
    user.endDate = addCalendarDays(actualStartDate || expectedStartDate, 30);
    user.subscriptionEnd = user.endDate;
  }
  if (!Array.isArray(user.attendanceLogs)) user.attendanceLogs = [];
  const unpaidAttendance = data.attendance.filter(record => record.playerId === user.id && record.attendedUnpaid && record.status !== "غائب");
  user.sessionsUsed = unpaidAttendance.length;
  user.sessionsLeft = Math.max(0, plan.sessions - unpaidAttendance.length);
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
  const fullPrice = priceSummary(payment.planId).plan.price;
  const reservedWalletCredit = Number.isInteger(Number(payment.walletCreditReserved))
    ? Math.max(0, Number(payment.walletCreditReserved))
    : memberWalletBalance(user);
  const initialReceivedAmount = reservedWalletCredit >= fullPrice ? 0 : "";
  openModal(`مراجعة تحويل ${user.name}`, `<p class="modal-explainer">سعر الباقة ${arabicDigits(fullPrice)} ج.م، والرصيد المحجوز من محفظة اللاعب ${arabicDigits(reservedWalletCredit)} ج.م. أدخل المبلغ الذي وصل فعليًا؛ عند عدم كفاية مجموعهما اختر المديونية أو تخفيض الباقة.</p><label>المبلغ المحوّل فعليًا<input name="receivedAmount" type="number" min="0" max="${fullPrice}" step="1" value="${initialReceivedAmount || (reservedWalletCredit >= fullPrice ? 0 : "")}" data-plan-id="${Number(payment.planId)}" data-wallet-credit="${reservedWalletCredit}" placeholder="أدخل المبلغ الظاهر في إثبات التحويل" required></label><fieldset class="registration-days" id="instapay-shortage-options" hidden><legend>المبلغ ورصيد المحفظة أقل من سعر الباقة — اختر طريقة المعالجة (إجباري)</legend><label class="day-choice"><input type="radio" name="instapayShortageResolution" value="debt"><span>البقاء على نفس الباقة وتسجيل الفرق كمديونية</span></label><label class="day-choice"><input type="radio" name="instapayShortageResolution" value="downgrade"><span>الانتقال إلى أعلى باقة أدنى يغطيها المبلغ ورصيد المحفظة</span></label><small id="instapay-downgrade-note" hidden>المبلغ ورصيد المحفظة لا يكفيان لأي باقة أدنى؛ اختر تسجيل الفرق كمديونية.</small></fieldset>`, "تأكيد المبلغ وتفعيل الاشتراك", form => applyPaymentConfirmation(form, payment.id), "تأكيد التحويلات");
  const form = byId("action-form");
  form.querySelector('input[name="receivedAmount"]').addEventListener("input", () => updateInstaPayShortageOptions(form, fullPrice));
  updateInstaPayShortageOptions(form, fullPrice);
}

function updateInstaPayShortageOptions(form, fullPrice) {
  const options = form.querySelector("#instapay-shortage-options");
  const amountInput = form.querySelector('input[name="receivedAmount"]');
  const amount = amountInput.value === "" ? Number.NaN : Number(amountInput.value);
  const walletCredit = Math.max(0, Number(amountInput.dataset.walletCredit) || 0);
  const availableAmount = amount + walletCredit;
  const requiresResolution = Number.isInteger(amount) && amount >= 0 && availableAmount < fullPrice;
  const requestedDayCount = Number(amountInput.dataset.planId);
  const downgrade = options.querySelector('input[name="instapayShortageResolution"][value="downgrade"]');
  const canDowngrade = Object.keys(DEFAULT_DAY_PRICES).map(Number)
    .some(dayCount => dayCount < requestedDayCount && priceSummary(dayCount).plan.price <= availableAmount);
  downgrade.disabled = requiresResolution && !canDowngrade;
  options.querySelector("#instapay-downgrade-note").hidden = !requiresResolution || canDowngrade;
  options.hidden = !requiresResolution;
  options.querySelectorAll('input[name="instapayShortageResolution"]').forEach(input => {
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
  const requiredAmount = priceSummary(payment.planId).plan.price;
  const walletBalance = memberWalletBalance(user);
  const reservedWalletCredit = payment.walletCreditReserved === undefined
    ? walletBalance
    : Number(payment.walletCreditReserved);
  if (!Number.isInteger(reservedWalletCredit) || reservedWalletCredit < 0 || reservedWalletCredit > walletBalance) {
    showToast("تغير رصيد محفظة اللاعب أثناء مراجعة الطلب. أعد تحميل البيانات ثم راجع الطلب مجددًا.");
    return;
  }
  if (!Number.isInteger(receivedAmount) || receivedAmount < 0 || receivedAmount > requiredAmount) {
    showToast(`أدخل مبلغًا صحيحًا من صفر إلى السعر الكامل للباقة (${arabicDigits(requiredAmount)} ج.م).`);
    return;
  }
  const totalAvailable = receivedAmount + reservedWalletCredit;
  if (!canRequestPayment(user)) { showToast(`لا يمكن تفعيل تجديد ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const shortageResolution = String(form.get("instapayShortageResolution") || "");
  if (totalAvailable < requiredAmount && !["debt", "downgrade"].includes(shortageResolution)) {
    showToast("اختر تسجيل الفرق كمديونية أو تخفيض الباقة قبل تأكيد المبلغ الناقص.");
    return;
  }
  const requestedDayCount = Number(payment.planId);
  let planDayCount = requestedDayCount;
  let plan = priceSummary(planDayCount).plan;
  let debtAddedAmount = 0;
  if (totalAvailable < requiredAmount && shortageResolution === "debt") {
    debtAddedAmount = requiredAmount - totalAvailable;
  } else if (totalAvailable < requiredAmount && shortageResolution === "downgrade") {
    const affordablePlans = Object.keys(DEFAULT_DAY_PRICES).map(Number)
      .filter(dayCount => dayCount < requestedDayCount && priceSummary(dayCount).plan.price <= totalAvailable)
      .sort((a, b) => b - a);
    planDayCount = affordablePlans[0] || 0;
    if (!planDayCount) {
      showToast(`المبلغ لا يكفي لأقل باقة أدنى من المطلوبة (${arabicDigits(priceSummary(1).plan.price)} ج.م).`);
      return;
    }
    plan = priceSummary(planDayCount).plan;
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
  user.walletBalance = Math.max(0, totalAvailable - plan.price);
  if (debtAddedAmount) user.cashDebt = Math.max(0, Number(user.cashDebt || 0)) + debtAddedAmount;
  payment.amount = receivedAmount;
  payment.walletCreditUsedAmount = Math.min(reservedWalletCredit, plan.price);
  payment.walletCreditAddedAmount = Math.max(0, user.walletBalance - (reservedWalletCredit - payment.walletCreditUsedAmount));
  payment.originalPlanId = requestedDayCount;
  payment.originalPlanName = priceSummary(requestedDayCount).plan.name;
  payment.planId = assignedDays.length;
  payment.planName = plan.name;
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
    chargedAttendance = activateSubscription(user, assignedDays.length, payment.expectedStartDate || localDateString());
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

function cashPaymentDetails(user) {
  const dayCount = user.weeklyDays?.length || user.weeklyDaysCount;
  const plan = priceSummary(dayCount).plan;
  const partialPayments = data.payments.filter(item => item.playerId === user.id && item.planId === dayCount && ["دفع جزئي نقدًا", "تم تطبيق خصم إخوة"].includes(item.status));
  const previousCashPaid = partialPayments.reduce((total, item) => total + Number(item.amount || 0), 0);
  const previousSiblingDiscount = partialPayments.reduce((total, item) => total + Number(item.siblingDiscount || 0), 0);
  return {
    dayCount,
    plan,
    partialPayments,
    previousCashPaid,
    previousSiblingDiscount,
    remainingAmount: Math.max(0, plan.price - previousCashPaid - previousSiblingDiscount),
    pendingPayments: data.payments.filter(item => item.playerId === user.id && item.status === "بانتظار المراجعة")
  };
}

function cashPaymentEligibility(user) {
  return selectedSessionsForMember(user).length > 0 && canRequestPayment(user) && cashPaymentDetails(user).remainingAmount > 0;
}

function cashPaymentQuote(players) {
  const balances = players.map(user => ({ user, ...cashPaymentDetails(user) }));
  const baseTotal = balances.reduce((total, item) => total + item.remainingAmount, 0);
  const eligibleForSiblingDiscount = players.length >= 2 && balances.every(item => item.dayCount === 3);
  const discountAlreadyApplied = balances.reduce((total, item) => total + item.previousSiblingDiscount, 0);
  const discount = eligibleForSiblingDiscount ? Math.min(Math.max(0, 50 - discountAlreadyApplied), baseTotal) : 0;
  return { balances, baseTotal, discount, total: baseTotal - discount };
}

function updateCashShortageOptions(form, total) {
  const options = form.querySelector("#cash-shortage-options");
  const amountInput = form.querySelector('input[name="amount"]');
  const requiresResolution = Number(amountInput.value) < total;
  options.hidden = !requiresResolution;
  options.querySelectorAll('input[name="shortageResolution"]').forEach(input => {
    input.required = requiresResolution;
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
  if (!details.remainingAmount) { showToast("اكتمل مبلغ الاشتراك نقدًا بالفعل. لا يمكن تسجيل دفعة أخرى له."); return; }
  const siblings = data.users.filter(item => item.role === "member" && item.guardianId === user.guardianId);
  const selectablePlayers = siblings.length ? siblings : [user];
  const playerOptions = selectablePlayers.map(sibling => {
    const siblingDetails = cashPaymentDetails(sibling);
    const isEligible = cashPaymentEligibility(sibling);
    const description = `${siblingDetails.plan.name} · ${arabicDigits(siblingDetails.remainingAmount)} ج.م${isEligible ? "" : " · غير متاح للدفع حاليًا"}`;
    const checked = sibling.id === user.id;
    const startDateField = isEligible && canChooseSubscriptionStartDate(sibling)
      ? `<label class="expected-start-picker">تاريخ بداية التدريب<input type="date" name="expectedStartDate-${escapeHtml(sibling.id)}" min="${localDateString()}" value="${expectedStartDateFor(sibling)}" ${checked ? "required" : "disabled"}></label>`
      : `<small class="expected-start-note">${isEligible ? "سيبدأ التجديد بعد انتهاء الاشتراك الحالي." : ""}</small>`;
    return `<div class="cash-sibling-option"><label class="cash-sibling-choice"><input type="checkbox" name="playerIds" value="${escapeHtml(sibling.id)}" ${checked ? "checked data-primary-player" : ""} ${isEligible ? "" : "disabled"}><span><strong>${escapeHtml(sibling.name)}</strong><small>${escapeHtml(description)}</small></span></label>${startDateField}</div>`;
  }).join("");
  const quote = cashPaymentQuote([user]);
  const now = new Date();
  const paidDate = localDateString(now);
  const paidTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal(`تسجيل دفع نقدي · ${user.name}`, `<fieldset class="cash-sibling-list"><legend>اللاعبون الذين يسددون معًا</legend>${playerOptions}</fieldset><p class="modal-explainer" id="cash-payment-summary">الإجمالي المستحق بعد الخصم: ${arabicDigits(quote.total)} ج.م. يمكن تطبيق خصم الإخوة على النقد فقط.</p><label>المبلغ النقدي المستلم<input name="amount" type="number" min="${quote.total ? 1 : 0}" max="${quote.total}" step="1" value="${quote.total}" required></label><fieldset class="registration-days" id="cash-shortage-options" hidden><legend>المبلغ أقل من المستحق — اختر طريقة معالجة الفرق (إجباري)</legend><label class="day-choice"><input type="radio" name="shortageResolution" value="discount"><span>نفس الباقة، واعتبار الفرق خصمًا استثنائيًا دون مديونية</span></label><label class="day-choice"><input type="radio" name="shortageResolution" value="debt"><span>نفس الباقة، وتسجيل الفرق مديونية نقدية تُسدد لاحقًا</span></label><label class="day-choice"><input type="radio" name="shortageResolution" value="downgrade"><span>تخفيض الباقة إلى أعلى باقة يغطيها المبلغ المقبوض</span></label></fieldset><div class="form-row"><label>تاريخ الدفع<input name="paidDate" type="date" max="${localDateString()}" value="${paidDate}" required></label><label>ساعة الدفع<input name="paidTime" type="time" value="${paidTime}" required></label></div>`, "تسجيل الدفع النقدي", form => saveCashPayment(form, user.id), "المدفوعات");
  const form = byId("action-form");
  form.addEventListener("change", event => {
    if (!(event.target instanceof HTMLInputElement) || event.target.name !== "playerIds") return;
    if (event.target.hasAttribute("data-primary-player") && !event.target.checked) {
      event.target.checked = true;
      return;
    }
    selectablePlayers.forEach(sibling => {
      const dateInput = form.querySelector(`input[name="expectedStartDate-${CSS.escape(sibling.id)}"]`);
      if (dateInput) {
        dateInput.disabled = !event.target.checked || event.target.value !== sibling.id;
        dateInput.required = !dateInput.disabled;
      }
    });
    const selected = [...form.querySelectorAll('input[name="playerIds"]:checked')]
      .map(input => data.users.find(item => item.id === input.value && item.role === "member"))
      .filter(Boolean);
    const updatedQuote = cashPaymentQuote(selected);
    const amountInput = form.querySelector('input[name="amount"]');
    const summary = byId("cash-payment-summary");
    amountInput.min = updatedQuote.total ? "1" : "0";
    amountInput.max = String(updatedQuote.total);
    amountInput.value = String(updatedQuote.total);
    summary.textContent = `الإجمالي المستحق بعد الخصم النقدي المسموح: ${arabicDigits(updatedQuote.total)} ج.م. ${updatedQuote.discount ? `يشمل خصم إخوة ${arabicDigits(updatedQuote.discount)} ج.م.` : "لا ينطبق خصم إخوة على الاختيار الحالي."}`;
    updateCashShortageOptions(form, updatedQuote.total);
  });
  form.querySelector('input[name="amount"]').addEventListener("input", () => {
    const selected = [...form.querySelectorAll('input[name="playerIds"]:checked')]
      .map(input => data.users.find(item => item.id === input.value && item.role === "member"))
      .filter(Boolean);
    updateCashShortageOptions(form, cashPaymentQuote(selected).total);
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
  const { balances, total, discount } = cashPaymentQuote(selectedPlayers);
  const amount = Number(form.get("amount"));
  const shortageResolution = String(form.get("shortageResolution") || "");
  const paidDate = String(form.get("paidDate"));
  const paidTime = String(form.get("paidTime"));
  const confirmedAt = new Date(`${paidDate}T${paidTime}:00`).getTime();
  if (!Number.isFinite(confirmedAt) || paidDate > localDateString() || !Number.isInteger(amount) || amount < 0 || (amount === 0 && total > 0) || amount > total) {
    showToast("راجع المبلغ النقدي والتاريخ والوقت، ولا تدخل مبلغًا أكبر من إجمالي المستحق.");
    return;
  }
  if (amount < total && !["discount", "debt", "downgrade"].includes(shortageResolution)) {
    showToast("اختر طريقة معالجة المبلغ المتبقي قبل تسجيل الدفع النقدي.");
    return;
  }
  const siblingDiscount = discount;
  let remainingDiscount = siblingDiscount;
  let remainingAmount = amount;
  const allocations = balances.map(balance => {
    const discountAmount = Math.min(balance.remainingAmount, remainingDiscount);
    remainingDiscount -= discountAmount;
    const due = balance.remainingAmount - discountAmount;
    const paid = Math.min(due, remainingAmount);
    remainingAmount -= paid;
    return {
      ...balance,
      discountAmount,
      paid,
      completesSubscription: paid === due || ["discount", "debt", "downgrade"].includes(shortageResolution),
      shortageResolution: paid === due ? "" : shortageResolution,
      expectedStartDate: canChooseSubscriptionStartDate(balance.user)
        ? String(form.get(`expectedStartDate-${balance.user.id}`) || "")
        : expectedStartDateFor(balance.user)
    };
  });
  const invalidStartDate = allocations.find(item =>
    !isValidIsoDate(item.expectedStartDate)
    || (canChooseSubscriptionStartDate(item.user) && item.expectedStartDate < localDateString())
  );
  if (invalidStartDate) {
    showToast(`اختر تاريخ بداية صحيحًا من اليوم فصاعدًا لاشتراك ${invalidStartDate.user.name}.`);
    return;
  }
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
      activatedPlan = planForAmount(paid + allocation.previousCashPaid);
      if (!activatedPlan || activatedPlan.price >= plan.price) {
        throw new Error(`المبلغ المسجل لـ${user.name} لا يكفي لتخفيض الاشتراك إلى باقة أقل. سجّل مبلغًا أعلى أو اختر الخصم/المديونية.`);
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
    pending.forEach(item => { item.status = "تم استبداله بدفعة نقدية"; });
    if (completesSubscription) partialPayments.forEach(item => { item.status = "تم استكمال الدفع النقدي"; });
    if (paid > 0 || discountAmount > 0 || specialDiscountAmount > 0 || debtAddedAmount > 0) {
      const payment = {
        id: crypto.randomUUID(), playerId: user.id, playerName: user.name, planId: shortageResolution === "downgrade" ? activatedPlan.sessions / 4 : dayCount,
        expectedStartDate,
        planName: activatedPlan.name, amount: paid, ...(discountAmount ? { siblingDiscount: discountAmount } : {}),
        ...(specialDiscountAmount ? { specialDiscountAmount } : {}),
        ...(debtAddedAmount ? { debtAddedAmount } : {}),
        ...(shortageResolution ? { cashShortageResolution: shortageResolution } : {}),
        ...(shortageResolution === "downgrade" ? { originalPlanId: dayCount, originalPlanName: plan.name } : {}),
        reference: "دفع نقدي في الأكاديمية",
        method: "cash", methodLabel: "نقدي", status: completesSubscription ? "تم الدفع نقدًا" : paid > 0 ? "دفع جزئي نقدًا" : "تم تطبيق خصم إخوة",
        createdAt: Date.now(), confirmedAt, paidTime, date: egyptianDate.format(new Date(confirmedAt))
      };
      data.payments.push(payment);
    }
      allocation.activatedPlan = activatedPlan;
      allocation.targetDays = targetDays;
    });
    allocations.filter(item => item.completesSubscription).forEach(allocation => {
      allocation.chargedAttendance = activateSubscription(allocation.user, allocation.activatedPlan.sessions / 4, allocation.expectedStartDate);
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
    const paymentMessage = amount ? `تم تسجيل دفعة ${arabicDigits(amount)} ج.م نقدًا` : "تمت تسوية الرصيد بخصم الإخوة";
    const resolutionMessage = `${debtTotal ? ` وسُجلت مديونية ${arabicDigits(debtTotal)} ج.م` : ""}${specialDiscountTotal ? ` وطُبق خصم استثنائي ${arabicDigits(specialDiscountTotal)} ج.م` : ""}`;
    showToast(`${paymentMessage}${discountMessage}${resolutionMessage}.${activatedPlayers.length ? ` تم تفعيل اشتراك ${activatedPlayers.join(" و")} وخصم ${arabicDigits(chargedAttendance)} تدريب سابق.` : " لم يكتمل الاشتراك بعد."}`);
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
  if (!childNames.length || childNames.some(name => name.length < 2 || name.length > 80)) { showToast("أدخل اسمًا صحيحًا لكل ابن."); return; }
  const user = { role: "guardian", name: String(form.get("guardianName")).trim(), guardianPhone, whatsappPhone, email, password: String(form.get("password")), joinedAt: new Date().toISOString() };
  if (user.name.length < 2 || !email || String(form.get("password")).length < 6) { showToast("أكمل اسم ولي الأمر والبريد الإلكتروني وكلمة المرور."); return; }
  const players = childNames.map(name => ({
    id: crypto.randomUUID(),
    role: "member",
    guardianId: user.id,
    joinedAt: user.joinedAt,
    name,
    birthDate: "",
    guardian: user.name,
    guardianPhone,
    whatsappPhone,
    category: "جميع الفئات العمرية",
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
      byId("child-name-list").innerHTML = '<div class="child-name-row"><label>اسم الابن<input name="childName" required minlength="2" maxlength="80" placeholder="اسم الابن بالكامل"></label></div>';
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
  row.innerHTML = '<label>اسم الابن<input name="childName" required minlength="2" maxlength="80" placeholder="اسم الابن بالكامل"></label><button type="button" class="remove-child-button" data-remove-child aria-label="حذف اسم الابن">×</button>';
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

document.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const viewButton = target.closest("[data-view]");
  if (viewButton) {
    const allowedViews = currentUser.role === "coach"
      ? ["home", "schedule", "attendance", "subscription", "payments", "settings", "trainers", "trainerAttendance", "finances"]
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
  if (action.dataset.action === "go-back") {
    activeView = viewHistory.pop() || "home";
    renderView();
    return;
  }
  if (["new-session", "edit-session", "delete-session", "take-attendance", "day-off", "code-attendance", "cash-payment", "cash-debt-payment", "new-trainer", "mark-trainer-attendance", "new-expense", "new-revenue", "instapay-settings", "confirm-payment", "reject-payment", "receipt-preview", "approve-makeup", "reject-makeup", "delete-expense", "delete-revenue", "delete-guardian"].includes(action.dataset.action) && currentUser.role !== "coach") {
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
  if (event.target.id === "training-count" && currentUser?.role === "coach") {
    const form = byId("action-form");
    const currentCount = form.querySelectorAll(".training-exercise").length;
    const values = exerciseValuesFromForm(form, currentCount);
    const nextCount = Number(event.target.value);
    while (values.length < nextCount) values.push({ title: "", coachId: "", categories: [] });
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
  if (event.target.id === "trainer-player-search" && currentUser?.role === "trainer") renderTrainerPlayerSearch(event.target.value);
});

document.addEventListener("submit", event => {
  if (event.target.id === "member-sessions-form") {
    event.preventDefault();
    if (!["member", "guardian"].includes(currentUser?.role)) { showToast("اختيار مواعيد التدريب متاح للاعب أو ولي الأمر فقط."); return; }
    const user = userForMember();
    if (!user) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
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
    const weeklyDays = new FormData(event.target).getAll("weeklyDays").map(String).filter(day => data.workDays.includes(day));
    if (!weeklyDays.length) { showToast("اختر يومًا واحدًا على الأقل."); return; }
    const user = userForMember();
    if (!user) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
    if (hasPartialCashPayment(user)) { showToast("أكمل المبلغ النقدي المتبقي قبل تغيير أيام التدريب."); return; }
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
