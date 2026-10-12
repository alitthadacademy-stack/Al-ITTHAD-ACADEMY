const COACH_PASSWORD = "20220105050";
const STORAGE_KEY = "alEtihadAcademy.portal.v1";
const WEEK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const DEFAULT_WORK_DAYS = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس"];
const DEFAULT_DAY_PRICES = { 1: 400, 2: 760, 3: 1020, 4: 1200, 5: 1400, 6: 1600, 7: 1800 };
const DEFAULT_INSTAPAY_NUMBER = "01017692213";
const AGE_CATEGORIES = ["براعم تحت ١٠", "ناشئين تحت ١٤", "شباب تحت ١٨", "شباب ١٨+", "جميع الفئات العمرية"];
const OWNER_NAME = "حازم الدخاخني";
const arabicDigits = value => String(value).replace(/\d/g, digit => "٠١٢٣٤٥٦٧٨٩"[digit]);
const egyptianDate = new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long", year: "numeric" });
const byId = id => document.getElementById(id);
const toast = byId("toast");
let toastTimeout;
let currentUser = null;
let activeView = "home";
let selectedPlayerId = null;
let data = loadData();

function emptyData() {
  return { users: [], sessions: [], payments: [], attendance: [], attendanceExceptions: [], trainerAttendance: [], expenses: [], instaPayAddress: DEFAULT_INSTAPAY_NUMBER, paymentDestinationType: "instapay", workDays: [...DEFAULT_WORK_DAYS], pricesByDays: { ...DEFAULT_DAY_PRICES } };
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
      if (user.role !== "member") return user;
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
          username: user.username,
          password: user.password,
          joinedAt: user.joinedAt || new Date().toISOString()
        });
      }
      return {
        ...user,
        guardianId,
        playerCode,
        joinedAt: user.joinedAt || new Date().toISOString(),
        weeklyDays: Array.isArray(user.weeklyDays) ? user.weeklyDays : workDays.slice(0, legacyDayCount),
        weeklyDaysCount: user.weeklyDaysCount || legacyDayCount,
        plan: legacyDayCount
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
        category: AGE_CATEGORIES.includes(session.category) ? session.category : "جميع الفئات العمرية"
      })),
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

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error("تعذر حفظ بيانات الأكاديمية في هذا المتصفح.", error);
    showToast("تعذر حفظ البيانات. تحقق من مساحة التخزين في المتصفح.");
    return false;
  }
}

saveData();

function showToast(message) {
  toast.querySelector("p").textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("show"), 3200);
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

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function sessionStartTimestamp(session, isoDate) {
  const rawTime = normalizeDigits(session?.time || "").trim().toLocaleLowerCase("ar");
  const match = rawTime.match(/(\d{1,2})\s*[:٫]\s*(\d{2})/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const isPm = /مساء|(?:^|\s)م(?:\s|$)|pm/.test(rawTime);
  const isAm = /صباح|(?:^|\s)ص(?:\s|$)|am/.test(rawTime);
  if (hours > 23 || minutes > 59) return null;
  if (isPm && hours < 12) hours += 12;
  if (isAm && hours === 12) hours = 0;
  if ((isAm || isPm) && hours > 12) return null;
  const timestamp = new Date(`${isoDate}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function attendanceStatus(session, isoDate, timestamp, user) {
  const weekday = weekdayForDate(isoDate);
  if (!user.weeklyDays?.includes(weekday) || !sessionDays(session).includes(weekday)) return "معذور";
  const startsAt = sessionStartTimestamp(session, isoDate);
  if (startsAt !== null && timestamp >= startsAt + 30 * 60 * 1000) return "متأخر";
  return "حاضر";
}

function isPaidMember(user) {
  const sessionsLeft = user.sessionsLeft == null ? priceSummary(user.plan).plan.sessions : Number(user.sessionsLeft);
  return subscriptionState(user).className === "status-active" && sessionsLeft > 0;
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
  byId("auth-screen").hidden = false;
  byId("portal").hidden = true;
  byId("coach-auth").hidden = true;
  byId("member-auth").hidden = false;
  setAuthTab(mode);
}

function setAuthTab(mode) {
  const register = mode === "register";
  byId("login-form").hidden = register;
  byId("register-form").hidden = !register;
  document.querySelectorAll(".auth-tab").forEach(tab => tab.classList.toggle("selected", tab.dataset.authTab === mode));
  byId("auth-title").textContent = register ? "انضم إلى الأكاديمية" : "سجّل دخولك";
  byId("auth-subtitle").textContent = register ? "ابدأ رحلتك الرياضية مع فريق الاتحاد." : "ادخل إلى حسابك لمتابعة رحلتك الرياضية.";
}

function signIn(user) {
  currentUser = user;
  selectedPlayerId = user.role === "guardian" ? data.users.find(child => child.role === "member" && child.guardianId === user.id)?.id || null : user.role === "member" ? user.id : null;
  byId("auth-screen").hidden = true;
  byId("portal").hidden = false;
  byId("user-name").textContent = user.name;
  byId("user-avatar").textContent = user.name.trim().charAt(0);
  byId("user-role").textContent = user.role === "coach" ? "مشرف الأكاديمية" : user.role === "trainer" ? "مدرب الأكاديمية" : user.role === "guardian" ? "ولي أمر اللاعبين" : "ولي أمر اللاعب";
  document.querySelectorAll(".supervisor-only").forEach(item => { item.hidden = user.role !== "coach"; });
  document.querySelectorAll(".member-only").forEach(item => { item.hidden = !["member", "guardian"].includes(user.role); });
  document.querySelectorAll(".trainer-only").forEach(item => { item.hidden = user.role !== "trainer"; });
  activeView = "home";
  renderView();
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
  if (!children.some(child => child.id === selectedPlayerId)) selectedPlayerId = children[0].id;
  return `<section class="panel child-picker"><label for="selected-player">اللاعب المعروض</label><select id="selected-player">${children.map(child => `<option value="${escapeHtml(child.id)}" ${child.id === selectedPlayerId ? "selected" : ""}>${escapeHtml(child.name)} · كود ${escapeHtml(child.playerCode)}</option>`).join("")}</select><button class="small-action" data-action="new-player">＋ إضافة لاعب</button></section>`;
}

function sessionIncludesMember(session, user) {
  return session.category === "جميع الفئات العمرية" || session.category === user.category || user.category === "جميع الفئات العمرية";
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
  return ["تم التأكيد", "تم الدفع نقدًا", "دفع جزئي نقدًا", "تم استكمال الدفع النقدي"].includes(payment.status);
}

function sessionDays(session) {
  const days = Array.isArray(session.days) ? session.days : [session.day];
  return days.filter(day => WEEK_DAYS.includes(day));
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
  const remaining = daysUntil(user?.subscriptionEnd);
  if (remaining === null) return { label: "بانتظار تفعيل الاشتراك", className: "status-soon", remaining: null };
  if (remaining < 0 || user.sessionsLeft <= 0) return { label: "منتهي", className: "status-expired", remaining };
  if (remaining <= 7) return { label: "بحاجة إلى تجديد", className: "status-soon", remaining };
  return { label: "نشط", className: "status-active", remaining };
}

function canRequestPayment(user) {
  if (!user?.subscriptionEnd) return true;
  const sessionsLeft = Number(user.sessionsLeft ?? priceSummary(user.plan).plan.sessions);
  const remainingDays = daysUntil(user.subscriptionEnd);
  return sessionsLeft <= 1 || remainingDays === null || remainingDays <= 0;
}

function hasPendingPayment(user) {
  return data.payments.some(payment => payment.playerId === user?.id && payment.status === "بانتظار المراجعة");
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

function monthBounds(isoDate) {
  const [year, month] = isoDate.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${year}-${String(month).padStart(2, "0")}-01`, end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}` };
}

function canRequestMakeup(user, record) {
  if (record.status !== "غائب" || !record.isoDate || record.isoDate.slice(0, 7) !== localDateString().slice(0, 7)) return false;
  if (!user.subscriptionEnd || record.isoDate > user.subscriptionEnd || localDateString() > user.subscriptionEnd) return false;
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
  return `<section class="portal-welcome"><div><p class="eyebrow"><span class="live-dot"></span>${egyptianDate.format(new Date())}</p><h1>أهلًا يا ${escapeHtml(user.name.split(" ")[0])} <span class="wave">✦</span></h1><p class="welcome-subtitle">مستعد لتمرينك القادم؟ تقدمك يبدأ بخطوة.</p></div><span class="welcome-ball">🏀</span></section>
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

function sessionCards(sessions, showCoach = false, member = null) {
  if (!sessions.length) return '<div class="empty-state"><strong>لا توجد تدريبات مجدولة</strong><p>ستظهر التدريبات هنا عند إضافتها من الأكاديمية.</p></div>';
  return `<div class="schedule-list">${sessions.map(session => { const days = sessionDays(session); const playerCount = data.users.filter(user => user.role === "member" && sessionIncludesMember(session, user) && (user.weeklyDays || []).some(day => days.includes(day))).length; const categoryLabel = member ? (sessionMatchesMemberDays(session, member) ? "مناسب لأيام تدريبك" : "موعد متاح لفئتك") : session.category; return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(session.time)}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.place)} · ${escapeHtml(session.coach)}</span>${showCoach ? `<small>الفئة: ${escapeHtml(session.category)} · ${arabicDigits(playerCount)} لاعب مسجل</small>` : ""}</div>${showCoach ? `<div class="schedule-actions"><button type="button" data-action="take-attendance" data-session="${escapeHtml(session.id)}">كشف الحضور</button><button type="button" data-action="edit-session" data-session="${escapeHtml(session.id)}">تعديل</button><button type="button" data-action="delete-session" data-session="${escapeHtml(session.id)}">حذف</button></div>` : `<span class="schedule-category">${escapeHtml(categoryLabel)}</span>`}</article>`; }).join("")}</div>`;
}

function memberScheduleView() {
  const user = userForMember();
  if (!user) return "";
  const availableSessions = sessionsForMember(user).filter(session => sessionMatchesMemberDays(session, user));
  const selectedSessions = selectedSessionsForMember(user);
  const selectedIds = new Set(selectedSessions.map(session => session.id));
  const selectionForm = availableSessions.length ? `<section class="panel"><div class="panel-heading"><div><h2>اختر مواعيدك المفضلة</h2><p>اختر الوقت والمجموعة المناسبة من المواعيد المتاحة لأيام تدريبك. حفظ الموعد لا يفعّل الاشتراك؛ يلزم تأكيد الدفع.</p></div></div><form id="member-sessions-form"><div class="session-choice-list">${availableSessions.map(session => `<label class="session-choice"><input type="checkbox" name="sessionIds" value="${escapeHtml(session.id)}" ${selectedIds.has(session.id) ? "checked" : ""}><span><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(session.time)} · ${escapeHtml(session.place)} · ${escapeHtml(session.coach)}</small></span></label>`).join("")}</div><button class="primary-button" type="submit">حفظ المواعيد المختارة</button></form></section>` : `<section class="panel"><div class="empty-state"><p>لا توجد مواعيد لفئتك وأيام تدريبك حاليًا. تواصل مع المشرف أو راجع أيام الاشتراك.</p></div></section>`;
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
        const status = record?.status || (isPast ? "غائب" : isoDate === todayIsoDate ? "بانتظار التسجيل" : "موعد قادم");
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
      const badgeClass = label === "غائب" ? "status-expired" : label === "متأخر" || label === "استثناء" ? "status-soon" : label === "حاضر" ? "status-active" : "";
      const next = label === "متأخر" ? nextAppointment(today) : null;
      return `<div class="attendance-day-entry"><div><strong>${escapeHtml(item.session.title)}</strong><small>${escapeHtml(item.session.time)}</small></div><span class="subscription-badge ${badgeClass}">${escapeHtml(label)}</span>${item.record?.registeredAt && label !== "غائب" ? `<small>وقت الوصول: ${escapeHtml(item.record.registeredAt)}</small>` : ""}${next ? `<small>الموعد القادم: ${escapeHtml(weekdayForDate(localDateString(next.date)))} ${escapeHtml(egyptianDate.format(next.date))} · ${escapeHtml(next.session.time)}</small>` : ""}</div>`;
    }).join("") : '<small>لا يوجد موعد محدد</small>';
    return `<article class="attendance-day-card"><strong>${escapeHtml(day)}</strong><span class="attendance-day-date">${escapeHtml(egyptianDate.format(date))}</span>${entries}</article>`;
  }).join("")}</div>` : '<div class="empty-state"><p>لم تختر أيام تدريب أسبوعية بعد.</p></div>';
  const exceptions = records.filter(record => record.status === "معذور" || record.status === "استثناء");
  const exceptionList = exceptions.length ? `<div class="attendance-exception-list">${exceptions.map(record => `<div class="attendance-exception-row"><span class="subscription-badge status-soon">استثناء</span><strong>${escapeHtml(weekdayForDate(record.isoDate))} · ${escapeHtml(record.date)}</strong><span>${escapeHtml(record.sessionTitle)} · وصل الساعة ${escapeHtml(record.registeredAt || "—")}</span></div>`).join("")}</div>` : "";
  return `<section class="page-intro"><div><p class="eyebrow">حساب اللاعب</p><h1>الحضور والغياب</h1><p class="welcome-subtitle">تابع أيام تدريبك وتاريخ كل حصة وحالة حضورك ووقت وصولك.</p></div></section><section class="coach-code-value player-code-panel"><span>كود اللاعب</span><strong>${escapeHtml(user.playerCode)}</strong><button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(user.playerCode)}">نسخ الكود</button></section><section class="panel"><div class="panel-heading"><div><h2>كشف أيام التدريب لهذا الأسبوع</h2><p>أيامك المختارة وتاريخ كل يوم وحالة الحضور، مع وقت الوصول والموعد القادم عند التأخير.</p></div></div>${weekGrid}${exceptionList ? `<div class="attendance-exceptions"><h3>استثناءات الحضور في أيام أخرى</h3>${exceptionList}</div>` : ""}</section><section class="panel"><div class="panel-heading"><div><h2>مواعيد التمرين المرشحة</h2><p>كل مواعيد فئتك التي أضافها المشرف؛ الأيام المناسبة لاشتراكك مميزة.</p></div></div>${sessionCards(schedules, false, user)}</section><section class="panel"><div class="panel-heading"><div><h2>سجل الحضور والغياب</h2><p>يظهر هنا تاريخ الحصة وموعدها ووقت وصول اللاعب. يمكن طلب استثناء لتعويض غياب خلال الشهر الحالي، بعد موافقة المشرف.</p></div></div>${records.length ? `<div class="table-wrap"><table><thead><tr><th>التدريب</th><th>تاريخ الحصة وموعدها</th><th>وقت الحضور</th><th>الحالة / الاستثناء</th></tr></thead><tbody>${records.map(record => { const request = makeUpRequestFor(record); const exceptionLabel = request ? `استثناء ${request.status}` : ""; const exceptionAction = !request && canRequestMakeup(user, record) ? `<button class="small-action" data-action="request-makeup" data-attendance="${escapeHtml(record.id)}">طلب استثناء</button>` : ""; const statusLabel = record.status === "معذور" ? "استثناء" : record.status || "حاضر"; return `<tr><td>${escapeHtml(record.sessionTitle)}</td><td>${escapeHtml(record.date)} · ${escapeHtml(record.sessionTime || "—")}</td><td>${escapeHtml(record.registeredAt || "—")}</td><td><span class="subscription-badge ${record.status === "غائب" ? "status-expired" : record.status === "معذور" || record.status === "متأخر" ? "status-soon" : "status-active"}">${escapeHtml(statusLabel)}</span>${exceptionLabel ? `<small class="table-subtext">${escapeHtml(exceptionLabel)}${request.date ? ` · ${escapeHtml(request.date)} ${escapeHtml(request.time || "")} · ${escapeHtml(request.sessionTitle || "")}` : ""}</small>` : ""}${exceptionAction}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد سجلات حضور بعد.</p></div>'}</section>`;
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
  return `<section class="page-intro"><div><p class="eyebrow">باقتك وتدريباتك</p><h1>اشتراك ${escapeHtml(summary.plan.name)}</h1><p class="welcome-subtitle">اختر أيام حضورك الأسبوعية، ويُحسب الاشتراك حسب عددها.</p></div><span class="subscription-badge ${state.className}">${state.label}</span></section>
    <section class="pricing-hero"><span class="pricing-kicker">سعر الاشتراك الشهري</span><div class="pricing-number">${arabicDigits(summary.plan.price)} <small>ج.م / شهر · ${summary.sessions} تدريبات</small></div><p>سعر التدريب الواحد ${arabicDigits(summary.sessionPrice)} ج.م · يحدّد المدرب الأسعار من لوحة الأكاديمية.</p></section>
    <section class="member-stats plan-details"><article class="member-stat"><p>التدريبات المستخدمة</p><strong>${arabicDigits(user.sessionsUsed || 0)}</strong><small>تُخصم عند تأكيد الحضور</small></article><article class="member-stat"><p>تاريخ نهاية الاشتراك</p><strong>${endDate}</strong><small>الحالة: ${state.label}</small></article><article class="member-stat"><p>كود اللاعب</p><strong class="player-code">${escapeHtml(user.playerCode)}</strong><small>تاريخ الانضمام: ${joinedDate(user)}</small></article></section>
    <section class="panel plan-options"><div class="panel-heading"><div><h2>أيام تدريبك الأسبوعية</h2><p>اختر من أيام عمل الأكاديمية المحددة من المدرب.</p></div></div>${data.workDays.length ? `<form id="member-days-form"><div class="day-choice-grid member-day-grid">${daysInput}</div><p id="member-days-price" class="price-preview">${selectedDays.length ? `اشتراكك الحالي: ${arabicDigits(summary.plan.price)} ج.م شهريًا` : "اختر يومًا واحدًا على الأقل."}</p><button class="primary-button" type="submit">حفظ أيام التدريب <span>←</span></button></form>` : '<div class="empty-state"><p>لم يحدد المدرب أيام العمل بعد.</p></div>'}<div class="payment-cta"><strong>قيمة اشتراكك: ${arabicDigits(summary.plan.price)} ج.م شهريًا</strong><button class="primary-button" data-action="payment" ${selectedDays.length && hasChosenSession && canRequestPayment(user) && !pendingPayment && !hasPartialCashPayment(user) ? "" : "disabled"}>${pendingPayment ? "طلب الدفع قيد المراجعة" : hasPartialCashPayment(user) ? "أكمل الدفع النقدي لدى الأكاديمية" : !hasChosenSession ? "اختر مواعيدك أولًا" : canRequestPayment(user) ? "تجديد / دفع الاشتراك" : "الدفع متاح عند تبقي تمرين واحد"} <span>←</span></button></div></section>`;
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
  const paymentBlockedMessage = hasPartialCashPayment(user)
    ? "لديك دفعة نقدية جزئية. أكمل المبلغ المتبقي لدى الأكاديمية لتفعيل الاشتراك."
    : !hasChosenSession ? "اختر مواعيد التدريب أولًا من صفحة جدول التدريبات."
      : `لا يمكن الدفع الآن. يتاح التجديد عند تبقي تمرين واحد أو انتهاء الاشتراك. المتبقي حاليًا ${arabicDigits(user.sessionsLeft || 0)} تمرين.`;
  return `<section class="page-intro"><div><p class="eyebrow">إنستا باي / محفظة بنكية</p><h1>المدفوعات والاشتراك</h1><p class="welcome-subtitle">قدّم رقم التحويل وصورة الإيصال لمراجعتهما وتفعيل اشتراكك.</p></div></section>
    <section class="instapay-panel"><span class="instapay-brand">⇄</span><div><h2>ادفع اشتراكك عبر إنستا باي / محفظة بنكية</h2><p>${paymentAllowed ? "حوّل قيمة الباقة إلى بيانات الأكاديمية، ثم سجّل رقم التحويل وأرفق صورة الإيصال للمراجعة." : paymentBlockedMessage}</p><div class="instapay-hint"><span>رقم / عنوان التحويل</span>${address}</div><p class="payment-warning">ولي الأمر أو اللاعب: الدفع متاح عبر إنستا باي أو المحفظة البنكية فقط. تأكد من صحة بيانات التحويل قبل الإرسال؛ الأكاديمية غير مسؤولة عن أي تحويل خاطئ.</p></div><button class="primary-button" data-action="payment" ${paymentAllowed ? "" : "disabled"}>${paymentAllowed ? "تسجيل تحويل جديد" : "التجديد غير متاح الآن"} <span>←</span></button></section>
    <section class="panel payment-history"><div class="panel-heading"><div><h2>سجل طلبات الدفع</h2><p>حالة كل تحويل أو مبلغ نقدي مسجل</p></div></div>${payments.length ? `<div class="history-list">${payments.map(payment => `<div class="history-item"><span class="payment-icon">⇄</span><span><strong>${escapeHtml(payment.planName)} · ${arabicDigits(payment.amount)} ج.م</strong><small>${escapeHtml(paymentMethodLabel(payment))} · ${escapeHtml(payment.reference)} · ${escapeHtml(payment.date)}</small>${payment.reference && payment.method !== "cash" ? `<button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(payment.reference)}">نسخ رقم التحويل</button>` : ""}</span><span class="subscription-badge ${isRecordedPayment(payment) && payment.status !== "دفع جزئي نقدًا" ? "status-active" : "status-soon"}">${escapeHtml(payment.status)}</span></div>`).join("")}</div>` : '<div class="empty-state"><p>لا توجد طلبات دفع بعد.</p></div>'}</section>`;
}

function coachHomeView() {
  const activeUsers = data.users.filter(user => user.role === "member");
  const expiring = activeUsers.filter(user => {
    const remaining = daysUntil(user.subscriptionEnd);
    return remaining !== null && remaining >= 0 && remaining <= 7;
  });
  const pending = data.payments.filter(payment => payment.status === "بانتظار المراجعة");
  const today = localDateString();
  const presentToday = data.attendance.filter(item => item.isoDate === today && item.status !== "غائب").length;
  return `<section class="portal-welcome"><div><p class="eyebrow"><span class="live-dot"></span>${egyptianDate.format(new Date())}</p><h1>أهلًا ${OWNER_NAME} <span class="wave">✦</span></h1><p class="welcome-subtitle">إدارة الأكاديمية، المدربين، حضور اللاعبين والحسابات المالية.</p></div><button class="primary-button" data-action="new-session"><span>＋</span> إضافة تدريب</button></section>
    <section class="member-stats coach-stats"><article class="member-stat"><span class="member-stat-icon green-icon">♙</span><p>اللاعبون المسجلون</p><strong>${arabicDigits(activeUsers.length)} لاعب</strong><small>في قاعدة بيانات هذا الجهاز</small></article><article class="member-stat"><span class="member-stat-icon blue-icon">✓</span><p>الحضور اليوم</p><strong>${arabicDigits(presentToday)} لاعب</strong><small>مسجل بواسطة المشرف</small></article><article class="member-stat"><span class="member-stat-icon amber-icon">!</span><p>اشتراكات للتجديد</p><strong>${arabicDigits(expiring.length)} اشتراك</strong><small>خلال الأيام السبعة القادمة</small></article><article class="member-stat"><span class="member-stat-icon purple-icon">⇄</span><p>تحويلات للمراجعة</p><strong>${arabicDigits(pending.length)} طلب</strong><small>بانتظار تأكيد المشرف</small></article></section>
    <section class="portal-grid"><article class="panel"><div class="panel-heading"><div><h2>تدريبات الأكاديمية</h2><p>أيام العمل: ${escapeHtml(data.workDays.join("، ") || "لم تحدد بعد")}</p></div><button class="text-link" data-view="schedule">إدارة الجدول <span>←</span></button></div>${sessionCards(data.sessions.slice(0, 3), true)}</article><article class="panel"><div class="panel-heading"><div><h2>تنبيهات المتابعة</h2><p>اشتراكات ومدفوعات تحتاج إلى مراجعة</p></div></div><div class="coach-alerts"><button data-view="subscription"><span class="alert-badge amber-icon">!</span><span><strong>${arabicDigits(expiring.length)} اشتراك قريب الانتهاء</strong><small>راجع الاشتراكات وأبلغ أولياء الأمور.</small></span></button><button data-view="payments"><span class="alert-badge purple-icon">⇄</span><span><strong>${arabicDigits(pending.length)} دفعة بنكية أو إلكترونية</strong><small>تحقق من المراجع والإيصالات قبل التأكيد.</small></span></button><button data-view="settings"><span class="alert-badge green-icon">⚙</span><span><strong>تعديل أيام العمل والأسعار</strong><small>حدد مواعيد الأكاديمية وقيمة كل باقة.</small></span></button></div></article></section>`;
}

function coachScheduleView() {
  return `<section class="page-intro"><div><p class="eyebrow">إدارة الأكاديمية</p><h1>جدول التدريبات</h1><p class="welcome-subtitle">أيام العمل: ${escapeHtml(data.workDays.join("، ") || "لم تحدد بعد")}</p></div><button class="primary-button" data-action="new-session"><span>＋</span> إضافة تدريب</button></section><section class="panel schedule-panel"><div class="panel-heading"><div><h2>كل الحصص</h2><p>${arabicDigits(data.sessions.length)} حصص على الجدول</p></div></div>${sessionCards(data.sessions, true)}</section>`;
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
  return `<section class="page-intro"><div><p class="eyebrow">فريق الأكاديمية</p><h1>إدارة المدربين</h1><p class="welcome-subtitle">أنشئ حسابات المدربين، ثم عيّن كل مدرب إلى فئته في جدول التدريبات.</p></div><button class="primary-button" data-action="new-trainer">＋ إضافة مدرب</button></section><section class="panel">${trainers.length ? `<div class="table-wrap"><table><thead><tr><th>المدرب</th><th>اسم المستخدم</th><th>الحصص المسندة</th><th>الحضور اليوم</th></tr></thead><tbody>${trainers.map(trainer => { const sessions = data.sessions.filter(session => session.coachId === trainer.id); const attended = data.trainerAttendance.some(record => record.trainerId === trainer.id && record.isoDate === localDateString() && record.status === "حاضر"); return `<tr><td>${escapeHtml(trainer.name)}</td><td>${escapeHtml(trainer.username)}</td><td>${arabicDigits(sessions.length)} حصة</td><td><span class="subscription-badge ${attended ? "status-active" : "status-soon"}">${attended ? "حاضر" : "لم يسجل بعد"}</span></td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>أضف حسابات المدربين أولًا لإسناد الحصص إليهم.</p></div>'}</section>`;
}

function openTrainerForm() {
  if (currentUser?.role !== "coach") { showToast("إدارة حسابات المدربين من صلاحية المشرف فقط."); return; }
  openModal("إضافة مدرب إلى الأكاديمية", `<label>اسم المدرب<input name="name" required maxlength="80" placeholder="اسم المدرب بالكامل"></label><label>اسم المستخدم<input name="username" required minlength="3" autocomplete="off" placeholder="اسم الدخول للمدرب"></label><label>كلمة المرور<input name="password" type="text" required minlength="6" autocomplete="off" placeholder="٦ أحرف على الأقل"></label><p class="modal-explainer">ستظهر كلمة المرور التي تدخلها لتتمكن من مراجعتها قبل إنشاء الحساب. يدخل المدرب من نموذج تسجيل الدخول المعتاد، ولا يمكنه تأكيد التحويلات أو تسجيل الحضور بدلًا من المشرف.</p>`, "إنشاء حساب المدرب", form => saveTrainer(form), "إدارة المدربين");
}

function openPlayerForm() {
  if (currentUser?.role !== "guardian") { showToast("إضافة لاعب متاحة من حساب ولي الأمر فقط."); return; }
  if (!data.workDays.length) { showToast("لم يحدد المشرف أيام عمل الأكاديمية بعد."); return; }
  openModal("إضافة لاعب إلى حساب ولي الأمر", `<label>اسم اللاعب<input name="name" required maxlength="80" placeholder="اسم اللاعب بالكامل"></label><fieldset class="registration-birth-date"><legend>تاريخ ميلاد اللاعب</legend><div class="birth-date-fields"><label>اليوم<input name="birthDay" type="text" inputmode="numeric" pattern="[0-9٠-٩]{1,2}" maxlength="2" required placeholder="يوم"></label><label>الشهر<input name="birthMonth" type="text" inputmode="numeric" pattern="[0-9٠-٩]{1,2}" maxlength="2" required placeholder="شهر"></label><label>السنة<input name="birthYear" type="text" inputmode="numeric" pattern="[0-9٠-٩]{4}" maxlength="4" required placeholder="سنة"></label></div></fieldset><fieldset class="registration-days"><legend>أيام حضور اللاعب أسبوعيًا</legend><div class="day-choice-grid">${dayCheckboxes(data.workDays)}</div></fieldset><p class="modal-explainer">سيُنشأ كود رقمي ثابت للاعب تلقائيًا. يعرضه اللاعب للمشرف لتسجيل حضوره.</p>`, "حفظ اللاعب", form => savePlayer(form), "حساب ولي الأمر");
}

function openPlayerCodeLogin() {
  openModal("دخول اللاعب بكود الحضور", `<label>كود اللاعب الرقمي<input name="playerCode" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="أدخل الكود المكوّن من ٦ أرقام"></label><p class="modal-explainer">كود اللاعب ثابت، ويستخدم للدخول إلى حساب اللاعب ولتسجيل الحضور بواسطة المشرف.</p>`, "دخول اللاعب", form => {
    const code = normalizeDigits(String(form.get("playerCode")).trim());
    const player = data.users.find(user => user.role === "member" && user.playerCode === code);
    if (!player) { showToast("كود اللاعب غير صحيح."); return; }
    closeModal();
    signIn(player);
  }, "دخول اللاعب");
}

function savePlayer(form) {
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
  const user = {
    id: crypto.randomUUID(), role: "member", guardianId: guardian.id,
    playerCode: createPlayerCode(), joinedAt: new Date().toISOString(),
    name, birthDate, guardian: guardian.name, guardianPhone: guardian.guardianPhone,
    whatsappPhone: guardian.whatsappPhone, category: playerCategoryForBirthDate(birthDate),
    weeklyDays, weeklyDaysCount: weeklyDays.length, plan: weeklyDays.length,
    sessionsLeft: 0, sessionsUsed: 0, subscriptionEnd: null
  };
  data.users.push(user);
  if (!saveData()) { data.users.pop(); return; }
  selectedPlayerId = user.id;
  closeModal();
  renderView();
  showToast(`تمت إضافة ${name}. كود اللاعب ${user.playerCode} ثابت لهذا الحساب.`);
}

function saveTrainer(form) {
  if (currentUser?.role !== "coach") { showToast("إضافة مدرب متاحة للمشرف فقط."); return; }
  const name = String(form.get("name")).trim();
  const username = String(form.get("username")).trim();
  const password = String(form.get("password"));
  if (name.length < 2 || username.length < 3 || password.length < 6) { showToast("أدخل اسم المدرب واسم مستخدم وكلمة مرور صحيحة."); return; }
  if (data.users.some(user => user.username?.toLocaleLowerCase("ar") === username.toLocaleLowerCase("ar"))) { showToast("اسم المستخدم مستخدم بالفعل."); return; }
  const trainer = { id: crypto.randomUUID(), role: "trainer", name, username, password, joinedAt: new Date().toISOString() };
  data.users.push(trainer);
  if (saveData()) { closeModal(); renderView(); showToast(`تم إنشاء حساب المدرب ${name}.`); }
  else data.users.pop();
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
  const monthIncome = income.filter(payment => paymentDate(payment).slice(0, 7) === month);
  const monthExpenses = data.expenses.filter(expense => expense.date.slice(0, 7) === month);
  const totalIncome = income.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const totalExpenses = data.expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const filteredIncomeTotal = monthIncome.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const filteredExpensesTotal = monthExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const rows = [
    ...monthIncome.map(payment => ({ date: paymentDate(payment), title: `اشتراك ${payment.playerName} · ${paymentMethodLabel(payment)} · ${payment.paidTime || ""}`, amount: Number(payment.amount || 0), type: "إيراد" })),
    ...monthExpenses.map(expense => ({ date: expense.date, title: expense.description, amount: Number(expense.amount || 0), type: "مصروف", expenseId: expense.id }))
  ].sort((a, b) => b.date.localeCompare(a.date));
  return `<section class="page-intro"><div><p class="eyebrow">حسابات الأكاديمية</p><h1>الإيرادات والمصروفات</h1><p class="welcome-subtitle">الإيرادات تشمل الاشتراكات المؤكدة فقط؛ التحويلات قيد المراجعة لا تُحتسب ربحًا.</p></div><button class="primary-button" data-action="new-expense">＋ تسجيل مصروف</button></section><section class="finance-filter"><label>الشهر المعروض<input id="finance-month" type="month" value="${escapeHtml(month)}"></label></section><section class="member-stats coach-stats finance-stats"><article class="member-stat"><p>إيرادات هذا الشهر</p><strong>${arabicDigits(filteredIncomeTotal)} ج.م</strong><small>${arabicDigits(monthIncome.length)} دفعة مؤكدة</small></article><article class="member-stat"><p>مصروفات هذا الشهر</p><strong>${arabicDigits(filteredExpensesTotal)} ج.م</strong><small>${arabicDigits(monthExpenses.length)} مصروف</small></article><article class="member-stat"><p>صافي هذا الشهر</p><strong>${arabicDigits(filteredIncomeTotal - filteredExpensesTotal)} ج.م</strong><small>إيرادات الشهر ناقص مصروفاته</small></article><article class="member-stat"><p>صافي الربح منذ البداية</p><strong>${arabicDigits(totalIncome - totalExpenses)} ج.م</strong><small>الإيرادات ${arabicDigits(totalIncome)} − المصروفات ${arabicDigits(totalExpenses)}</small></article></section><section class="panel"><div class="panel-heading"><div><h2>حركة الشهر</h2><p>الإيرادات المسجلة والمصروفات حسب التاريخ</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th><th>إجراء</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.title)}</td><td><span class="subscription-badge ${row.type === "إيراد" ? "status-active" : "status-expired"}">${row.type}</span></td><td>${arabicDigits(row.amount)} ج.م</td><td>${row.expenseId ? `<button class="small-action" data-action="delete-expense" data-expense="${escapeHtml(row.expenseId)}">حذف المصروف</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد حركات مالية في هذا الشهر.</p></div>'}</section>`;
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
  if (saveData()) { renderView(); showToast("تم حذف المصروف وإعادة حساب صافي الربح."); }
  else data.expenses.splice(index, 0, expense);
}

function coachAttendanceView() {
  const records = [...data.attendance].sort((a, b) => b.timestamp - a.timestamp);
  const pendingMakeups = data.attendanceExceptions.filter(item => item.status === "بانتظار موافقة المشرف").sort((a, b) => b.createdAt - a.createdAt);
  const sessionButtons = data.sessions.length ? data.sessions.map(session => {
    const days = sessionDays(session);
    const count = data.users.filter(user => user.role === "member" && sessionIncludesMember(session, user) && (user.weeklyDays || []).some(day => days.includes(day))).length;
    return `<article class="schedule-card"><div class="schedule-day"><strong>${escapeHtml(days.join("، "))}</strong><span>${escapeHtml(session.time)}</span></div><span class="schedule-mark">🏀</span><div class="schedule-info"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.category)} · ${arabicDigits(count)} لاعب مسجل</span></div><button class="small-action" data-action="take-attendance" data-session="${escapeHtml(session.id)}">فتح كشف الحضور</button></article>`;
  }).join("") : '<div class="empty-state"><p>أضف حصة إلى الجدول لفتح كشف الحضور.</p></div>';
  const makeupRows = pendingMakeups.map(request => {
    const expired = localDateString() > monthBounds(request.absenceDate).end;
    return `<article class="roster-row"><div><strong>${escapeHtml(request.playerName)} · غياب ${escapeHtml(request.absenceDate)}</strong><small>طلب تعويض: ${escapeHtml(request.sessionTitle)} · ${escapeHtml(request.date)} الساعة ${escapeHtml(request.time)}</small></div><div class="roster-actions"><button class="small-action" data-action="approve-makeup" data-request="${escapeHtml(request.id)}" ${expired ? "disabled" : ""}>${expired ? "انتهى الشهر" : "موافقة"}</button><button class="small-action danger-action" data-action="reject-makeup" data-request="${escapeHtml(request.id)}">رفض</button></div></article>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">متابعة اللاعبين</p><h1>الحضور والغياب</h1><p class="welcome-subtitle">سجّل حضور اليوم ووقته بدقة، وراجع طلبات تعويض الغياب قبل نهاية الشهر.</p></div><button class="primary-button" data-action="code-attendance">تسجيل بالكود</button></section><section class="panel"><div class="panel-heading"><div><h2>طلبات استثناء وتعويض الغياب</h2><p>يعرض اليوم والمجموعة ووقت حضور اللاعب؛ يجب اعتماد الطلب قبل انتهاء شهر الغياب.</p></div><span class="subscription-badge ${pendingMakeups.length ? "status-soon" : "status-active"}">${arabicDigits(pendingMakeups.length)} طلبات معلقة</span></div>${pendingMakeups.length ? `<div class="roster-list">${makeupRows}</div>` : '<div class="empty-state"><p>لا توجد طلبات استثناء بانتظار الموافقة.</p></div>'}</section><section class="panel"><div class="panel-heading"><div><h2>كشف الحضور لكل مجموعة</h2><p>عدد اللاعبين يعرض المسجلين في الفئة وأيام المجموعة.</p></div></div><div class="schedule-list">${sessionButtons}</div></section><section class="panel"><div class="panel-heading"><div><h2>سجل الحضور والغياب</h2><p>أوقات التسجيل والحالة وروابط واتساب الجاهزة لأولياء الأمور</p></div></div>${records.length ? `<div class="table-wrap"><table><thead><tr><th>اللاعب</th><th>الحصة</th><th>التاريخ والوقت</th><th>الحالة</th><th>ولي الأمر</th></tr></thead><tbody>${records.map(record => { const user = data.users.find(item => item.id === record.playerId); const status = record.status || "حاضر"; const message = status === "غائب" ? `نحيطكم علمًا بغياب اللاعب ${record.playerName} عن ${record.sessionTitle} بتاريخ ${record.date}.` : `تم تسجيل ${status} للاعب ${record.playerName} في ${record.sessionTitle} بتاريخ ${record.date}${record.registeredAt ? ` الساعة ${record.registeredAt}` : ""}.${record.attendedUnpaid ? " الاشتراك غير مدفوع." : ""}`; const unpaidLabel = record.unpaidException && record.attendedUnpaid ? " · استثناء غير مدفوع" : record.attendedUnpaid ? " · غير مدفوع" : ""; const makeupLabel = record.makeupException ? " · تعويض معتمد" : ""; return `<tr><td>${escapeHtml(record.playerName)}</td><td>${escapeHtml(record.sessionTitle)}</td><td>${escapeHtml(record.date)}<br>${escapeHtml(record.registeredAt || "")}</td><td><span class="subscription-badge ${status === "غائب" ? "status-expired" : status === "متأخر" ? "status-soon" : "status-active"}">${escapeHtml(status)}${unpaidLabel}${makeupLabel}</span></td><td>${user ? guardianWhatsApp(user, message) : "لم يسجل رقمًا"}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا يوجد حضور مسجل حتى الآن.</p></div>'}</section>`;
}

function openMakeupRequest(attendanceId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الاستثناء متاحة من حساب اللاعب أو ولي الأمر فقط."); return; }
  const user = userForMember();
  const absence = data.attendance.find(record => record.id === attendanceId && record.playerId === user?.id);
  if (!user || !absence || !canRequestMakeup(user, absence)) { showToast("طلب التعويض غير متاح لهذا الغياب أو انتهت فترة تقديمه."); return; }
  const bounds = monthBounds(absence.isoDate);
  const maxDate = [localDateString(), user.subscriptionEnd, bounds.end].filter(Boolean).sort()[0];
  const sessions = sessionsForMember(user);
  if (!sessions.length) { showToast("لا توجد مجموعة مناسبة لتسجيل يوم التعويض."); return; }
  const sessionOptions = sessions.map(session => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(session.time)}</option>`).join("");
  const now = new Date();
  const timeNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal("طلب استثناء لتعويض الغياب", `<p class="modal-explainer">الغياب عن ${escapeHtml(absence.sessionTitle)} بتاريخ ${escapeHtml(absence.date)}. سجّل اليوم والمجموعة ووقت حضور اللاعب الفعلي. لا يمكن إرسال الطلب بعد نهاية الشهر أو بعد انتهاء الاشتراك، ويجب اعتماده من المشرف.</p><label>يوم حضور التعويض<input name="makeupDate" type="date" min="${bounds.start}" max="${maxDate}" required></label><label>مجموعة التدريب<select name="sessionId" required>${sessionOptions}</select></label><label>وقت وصول اللاعب<input name="makeupTime" type="time" value="${timeNow}" required></label>`, "إرسال طلب الاستثناء", form => saveMakeupRequest(form, absence.id), "الحضور والغياب");
}

function saveMakeupRequest(form, attendanceId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الاستثناء متاحة من حساب اللاعب أو ولي الأمر فقط."); return; }
  const user = userForMember();
  const absence = data.attendance.find(record => record.id === attendanceId && record.playerId === user?.id);
  const date = String(form.get("makeupDate"));
  const time = String(form.get("makeupTime"));
  const session = data.sessions.find(item => item.id === form.get("sessionId"));
  if (!user || !absence || !canRequestMakeup(user, absence)) { showToast("طلب التعويض غير متاح لهذا الغياب أو انتهت فترة تقديمه."); return; }
  const bounds = monthBounds(absence.isoDate);
  const dateValue = new Date(`${date}T12:00:00`);
  const timestamp = new Date(`${date}T${time}:00`).getTime();
  const maxDate = [localDateString(), user.subscriptionEnd, bounds.end].filter(Boolean).sort()[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || localDateString(dateValue) !== date || date < bounds.start || date > maxDate || date === absence.isoDate ||
      !/^\d{2}:\d{2}$/.test(time) || !Number.isFinite(timestamp) || timestamp > Date.now() ||
      !session || !sessionIncludesMember(session, user) || !sessionDays(session).includes(weekdayForDate(date))) {
    showToast("اختر يومًا آخر من شهر الغياب، ضمن الاشتراك، ووقتًا ومجموعة صحيحة.");
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
  const bounds = monthBounds(request.absenceDate);
  if (localDateString() > bounds.end || request.date < bounds.start || request.date > bounds.end ||
      request.date > localDateString() || request.date > (user.subscriptionEnd || "")) {
    showToast("انتهت فترة اعتماد الاستثناء أو أن التاريخ خارج شهر الغياب والاشتراك.");
    return;
  }
  if (data.attendance.some(record => record.playerId === user.id && record.sessionId === session.id && record.isoDate === request.date)) {
    showToast("يوجد تسجيل حضور لهذه المجموعة واللاعب في يوم التعويض بالفعل.");
    return;
  }
  const previousUser = { ...user, weeklyDays: [...(user.weeklyDays || [])] };
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
  request.status = "تمت الموافقة";
  request.reviewedAt = Date.now();
  data.attendance.push(record);
  if (saveData()) { renderView(); showToast(`تم اعتماد تعويض ${user.name} وتسجيل ${record.status} في ${request.sessionTitle} يوم ${request.date} الساعة ${request.time}.`); }
  else {
    data.attendance.pop();
    request.status = previousStatus;
    delete request.reviewedAt;
    Object.assign(user, previousUser);
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
      return `<article class="roster-row"><div><strong>${escapeHtml(player.name)}</strong><small>كود اللاعب: ${escapeHtml(player.playerCode)} · ${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} ${escapeHtml(session.time)}</small></div><button type="button" class="small-action" data-action="trainer-mark-attendance" data-player="${escapeHtml(player.id)}" data-session="${escapeHtml(session.id)}" ${alreadyRecorded ? "disabled" : ""}>${alreadyRecorded ? "تم التسجيل اليوم" : "تسجيل الحضور"}</button></article>`;
    }).join("");
  }).join("");
}

function openSearchedPlayerAttendanceForm(playerId, sessionId) {
  if (currentUser?.role !== "trainer") { showToast("تسجيل الحضور من صلاحية المدرب المسند إليه التدريب."); return; }
  const player = data.users.find(user => user.id === playerId && user.role === "member");
  const session = data.sessions.find(item => item.id === sessionId && item.coachId === currentUser.id);
  if (!player || !session || !sessionIncludesMember(session, player)) { showToast("اللاعب أو المجموعة غير متاحين لحسابك."); return; }
  const now = new Date();
  const timeNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal(`تسجيل حضور · ${player.name}`, `<p class="modal-explainer">المجموعة: ${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(session.time)}. سيظهر الحضور معذورًا إذا كان اليوم خارج أيام اللاعب أو المجموعة، ومتأخرًا بعد ٣٠ دقيقة.</p><input type="hidden" name="playerId" value="${escapeHtml(player.id)}"><input type="hidden" name="sessionId" value="${escapeHtml(session.id)}"><label>تاريخ الحضور<input type="date" name="attendanceDate" value="${localDateString()}" required></label><label>وقت حضور اللاعب<input type="time" name="attendanceTime" value="${timeNow}" required></label>`, "تأكيد الحضور", form => saveTrainerAttendanceForPlayer(form), "حضور اللاعبين");
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
  const options = data.sessions.map(session => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)} · ${escapeHtml(sessionDays(session).join("، "))} · ${escapeHtml(session.time)}</option>`).join("");
  if (!options) { showToast("أضف مجموعة تدريب إلى الجدول أولًا."); return; }
  openModal("تسجيل حضور بكود اللاعب", `<label>كود اللاعب<input name="playerCode" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="الكود الرقمي المكوّن من ٦ أرقام"></label><label>مجموعة التدريب<select name="sessionId" required>${options}</select></label><p class="modal-explainer">يُسجل حضور اليوم فور التأكيد. إذا كان اللاعب لم يدفع بعد، يمكنك تسجيله كاستثناء وسيُخصم التمرين عند تجديد الاشتراك وسداد كامل المبلغ.</p>`, "تسجيل الحضور الآن", form => saveCodeAttendance(form), "الحضور والغياب");
}

function saveCodeAttendance(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الحضور بالكود من صلاحية المشرف فقط."); return; }
  const code = normalizeDigits(String(form.get("playerCode")).trim());
  const player = data.users.find(user => user.role === "member" && user.playerCode === code);
  const session = data.sessions.find(item => item.id === form.get("sessionId"));
  if (!player) { showToast("كود اللاعب غير موجود. راجع الرقم وحاول مرة أخرى."); return; }
  if (!session || !sessionIncludesMember(session, player)) { showToast("المجموعة غير مناسبة لفئة اللاعب."); return; }
  registerPlayerAttendance(player, session);
}

function registerPlayerAttendance(player, session, dateTime = new Date()) {
  const isoDate = localDateString(dateTime);
  if (data.attendance.some(record => record.playerId === player.id && record.sessionId === session.id && record.isoDate === isoDate)) {
    showToast(`تم تسجيل حضور ${player.name} لهذه المجموعة في هذا التاريخ بالفعل.`);
    return;
  }
  const timestamp = dateTime.getTime();
  const weekday = weekdayForDate(isoDate);
  const isScheduled = player.weeklyDays?.includes(weekday) && sessionDays(session).includes(weekday);
  const status = !isScheduled ? "معذور" : attendanceStatus(session, isoDate, timestamp, player);
  const paid = isPaidMember(player);
  const record = {
    id: crypto.randomUUID(), playerId: player.id, playerName: player.name, sessionId: session.id,
    sessionTitle: session.title, sessionTime: session.time, guardianPhone: player.guardianPhone,
    timestamp, markedAt: Date.now(), isoDate, date: egyptianDate.format(dateTime),
    registeredAt: `${String(dateTime.getHours()).padStart(2, "0")}:${String(dateTime.getMinutes()).padStart(2, "0")}`,
    status, attendedUnpaid: !paid, unpaidException: !paid && status !== "غائب"
  };
  const previousUsed = player.sessionsUsed;
  const previousLeft = player.sessionsLeft;
  if (paid) consumeTraining(player);
  data.attendance.push(record);
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
  }
}

function openAttendanceRoster(sessionId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل حضور اللاعبين من صلاحية المشرف فقط."); return; }
  const session = data.sessions.find(item => item.id === sessionId);
  if (!session) { showToast("لم يتم العثور على حصة التدريب."); return; }
  const roster = data.users.filter(user => user.role === "member" && sessionIncludesMember(session, user));
  if (!roster.length) { showToast("لا يوجد لاعبون مسجلون في هذه الفئة."); return; }
  const today = new Date();
  const timeNow = `${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}`;
  const players = roster.map(user => {
    const isScheduled = user.weeklyDays?.includes(weekdayForDate(localDateString())) && sessionDays(session).includes(weekdayForDate(localDateString()));
    const alreadyRecorded = data.attendance.some(record => record.playerId === user.id && record.sessionId === session.id && record.isoDate === localDateString());
    return `<div class="roster-row"><div><strong>${escapeHtml(user.name)}</strong><small>كود اللاعب: ${escapeHtml(user.playerCode)} · ${isScheduled ? "يوم التدريب المسجل" : "يوم غير مقرر، حضوره معذور"}${alreadyRecorded ? " · سبق تسجيله اليوم" : ""}</small></div><select name="status-${escapeHtml(user.id)}"><option value="${isScheduled ? "غائب" : "غير مسجل"}">${isScheduled ? "غائب" : "لم يحضر"}</option><option value="حاضر">حاضر</option>${isScheduled ? '<option value="غائب">غائب</option>' : ""}</select><label>وقت الحضور<input type="time" name="time-${escapeHtml(user.id)}" value="${timeNow}"></label></div>`;
  }).join("");
  openModal(`كشف حضور ${session.title}`, `<p class="modal-explainer">حدد تاريخ الحصة وحالة كل لاعب. لا تسجل الغياب للاعب في يوم غير أيامه؛ حضوره في ذلك اليوم يظهر كمعذور. يمكن تسجيل الحضور غير المدفوع كاستثناء، وسيُخصم التمرين عند تجديد الاشتراك وسداد كامل المبلغ.</p><label>تاريخ الحصة<input name="attendanceDate" type="date" value="${localDateString()}" required></label><input type="hidden" name="sessionId" value="${escapeHtml(session.id)}"><div class="roster-list">${players}</div>`, "حفظ كشف الحضور", form => saveAttendanceRoster(form), "الحضور والغياب");
}

function saveAttendanceRoster(form) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الحضور متاح للمشرف فقط."); return; }
  const session = data.sessions.find(item => item.id === form.get("sessionId"));
  const isoDate = String(form.get("attendanceDate"));
  if (!session || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || Number.isNaN(new Date(`${isoDate}T12:00:00`).getTime())) { showToast("تحقق من الحصة وتاريخ كشف الحضور."); return; }
  const addedRecords = [];
  const skipped = [];
  const userAdjustments = [];
  data.users.filter(user => user.role === "member" && sessionIncludesMember(session, user)).forEach(user => {
    const selected = String(form.get(`status-${user.id}`));
    if (!["حاضر", "متأخر", "غائب"].includes(selected)) return;
    if (data.attendance.some(record => record.playerId === user.id && record.sessionId === session.id && record.isoDate === isoDate)) { skipped.push(user.name); return; }
    const timeText = String(form.get(`time-${user.id}`) || "");
    const [hours, minutes] = timeText.split(":").map(Number);
    const timestamp = timeText && Number.isInteger(hours) && Number.isInteger(minutes)
      ? new Date(`${isoDate}T${timeText}:00`).getTime()
      : Date.now();
    const weekday = weekdayForDate(isoDate);
    const isScheduled = user.weeklyDays?.includes(weekday) && sessionDays(session).includes(weekday);
    const status = selected === "غائب" && isScheduled ? "غائب" : !isScheduled ? "معذور" : attendanceStatus(session, isoDate, timestamp, user);
    const paid = status !== "غائب" && isPaidMember(user);
    const record = {
      id: crypto.randomUUID(), playerId: user.id, playerName: user.name, sessionId: session.id,
      sessionTitle: session.title, sessionTime: session.time, guardianPhone: user.guardianPhone,
      timestamp, markedAt: Date.now(), isoDate, date: egyptianDate.format(new Date(`${isoDate}T12:00:00`)),
      registeredAt: status === "غائب" ? "" : timeText, status, attendedUnpaid: status !== "غائب" && !paid,
      unpaidException: status !== "غائب" && !paid
    };
    addedRecords.push(record);
    if (paid) {
      userAdjustments.push({ user, sessionsUsed: user.sessionsUsed, sessionsLeft: user.sessionsLeft });
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
    });
  }
}

function coachPlayersView() {
  const users = data.users.filter(user => user.role === "member");
  const guardians = data.users.filter(user => user.role === "guardian");
  const guardianRows = guardians.map(guardian => {
    const children = childrenForGuardian(guardian.id);
    return `<tr><td>${escapeHtml(guardian.name)}</td><td>${escapeHtml(guardian.guardianPhone || "—")}<br>${escapeHtml(guardian.whatsappPhone || "—")}</td><td>${escapeHtml(guardian.username || "—")}</td><td>${children.map(child => `${escapeHtml(child.name)} · ${escapeHtml(child.birthDate || "—")} · كود ${escapeHtml(child.playerCode)}`).join("<br>") || "لا يوجد لاعبون"}</td><td><button class="small-action danger-action" data-action="delete-guardian" data-guardian="${escapeHtml(guardian.id)}">حذف ولي الأمر وأبنائه</button></td></tr>`;
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
    return `<tr><td class="player-code">${escapeHtml(user.playerCode)}</td><td>${escapeHtml(user.name)}<small class="table-subtext">${escapeHtml(guardian?.name || user.guardian || "")}</small></td><td>${escapeHtml(user.birthDate || "—")}<br>${escapeHtml(user.category)}</td><td>${escapeHtml((user.weeklyDays || []).join("، ") || "لم يختر")}<br>${schedules || "لا توجد مجموعة مرشحة"}</td><td>${arabicDigits(totalPaid)} ج.م${cashPartial ? `<small class="table-subtext">دفع نقدًا ${arabicDigits(cashPartial)} ج.م · المتبقي ${arabicDigits(cashRemaining)} ج.م لإكمال الاشتراك</small>` : ""}</td><td>${latestPayment ? `${escapeHtml(paymentMethodLabel(latestPayment))} · ${escapeHtml(latestPayment.date || "—")} · ${escapeHtml(latestPayment.paidTime || "—")}` : "لا توجد دفعات مؤكدة"}</td><td>${user.subscriptionEnd ? egyptianDate.format(new Date(`${user.subscriptionEnd}T12:00:00`)) : "غير مفعّل"}<br><span class="subscription-badge ${state.className}">${state.label}</span><br>متبقي ${arabicDigits(user.sessionsLeft || 0)} تمرين</td><td><button class="small-action" data-action="cash-payment" data-player="${escapeHtml(user.id)}" ${canRequestPayment(user) ? "" : "disabled"}>تسجيل دفع نقدي</button>${state.label === "منتهي" ? guardianWhatsApp(user, expiredMessage, "إشعار انتهاء الاشتراك") : ""}</td></tr>`;
  }).join("");
  return `<section class="page-intro"><div><p class="eyebrow">متابعة الحسابات والاشتراكات</p><h1>أولياء الأمور واللاعبون</h1><p class="welcome-subtitle">تظهر بيانات اللاعب وتاريخ ميلاده ومواعيده ومجموع ما دفعه. حذف الحساب لا يحذف السجلات المالية.</p></div></section><section class="panel"><div class="panel-heading"><div><h2>حسابات أولياء الأمور</h2><p>${arabicDigits(guardians.length)} ولي أمر · الحذف يزيل ولي الأمر وأطفاله فقط، وتبقى السجلات المالية محفوظة.</p></div></div>${guardians.length ? `<div class="table-wrap"><table><thead><tr><th>ولي الأمر</th><th>الهاتف / واتساب</th><th>اسم المستخدم</th><th>اللاعبون</th><th>إجراء الحساب</th></tr></thead><tbody>${guardianRows}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد حسابات أولياء أمور بعد.</p></div>'}</section><section class="panel"><div class="panel-heading"><div><h2>سجل اللاعبين والاشتراكات</h2><p>كل الدفعات تبقى مسجلة ولا يمكن حذفها من سجل الدفع.</p></div></div>${users.length ? `<div class="table-wrap"><table><thead><tr><th>كود اللاعب</th><th>اللاعب / ولي الأمر</th><th>تاريخ الميلاد والفئة</th><th>أيام التدريب والمواعيد</th><th>إجمالي ما دفع</th><th>آخر دفعة: الطريقة والتاريخ والوقت</th><th>الانتهاء والحالة</th><th>إجراء</th></tr></thead><tbody>${playerRows}</tbody></table></div>` : '<div class="empty-state"><p>لا يوجد لاعبون مسجلون بعد.</p></div>'}</section>`;
}

function deleteGuardian(guardianId) {
  if (currentUser?.role !== "coach") { showToast("حذف الحسابات متاح للمشرف فقط."); return; }
  const guardian = data.users.find(user => user.id === guardianId && user.role === "guardian");
  if (!guardian) { showToast("لم يتم العثور على حساب ولي الأمر."); return; }
  const children = childrenForGuardian(guardian.id);
  if (!window.confirm(`حذف حساب ${guardian.name} و${children.length} من أبنائه؟ سيبقى سجل الحضور والمدفوعات محفوظًا.`)) return;
  const deletedUsers = data.users.filter(user => user.id === guardian.id || user.guardianId === guardian.id);
  data.users = data.users.filter(user => user.id !== guardian.id && user.guardianId !== guardian.id);
  if (saveData()) { renderView(); showToast("تم حذف الحساب واللاعبين مع الإبقاء على سجلات الحضور والمدفوعات."); }
  else data.users.push(...deletedUsers);
}

function coachPaymentsView() {
  const payments = [...data.payments].sort((a, b) => b.createdAt - a.createdAt);
  return `<section class="page-intro"><div><p class="eyebrow">التحصيل المالي</p><h1>طلبات الدفع</h1><p class="welcome-subtitle">راجع رقم التحويل وصورة الإيصال يدويًا قبل تأكيد أي دفعة.</p></div><button class="primary-button" data-action="instapay-settings">بيانات التحويل</button></section>
    <section class="instapay-panel coach-instapay"><span class="instapay-brand">⇄</span><div><h2>بيانات التحويل الحالية</h2><p>${data.instaPayAddress ? escapeHtml(data.instaPayAddress) : "لم تتم إضافة بيانات الدفع بعد."}</p></div></section>
    <section class="panel">${payments.length ? `<div class="table-wrap"><table><thead><tr><th>اللاعب</th><th>الباقة والمبلغ</th><th>طريقة الدفع</th><th>مرجع / كود الدفع</th><th>الإيصال</th><th>تاريخ وساعة الدفع</th><th>الحالة والإجراء</th></tr></thead><tbody>${payments.map(payment => { const user = data.users.find(item => item.id === payment.playerId); const paid = ["تم التأكيد", "تم الدفع نقدًا", "تم استكمال الدفع النقدي"].includes(payment.status); const paidMessage = `تم تأكيد دفع اشتراك اللاعب ${payment.playerName} بقيمة ${payment.amount} ج.م وتفعيل الاشتراك.`; const paymentTime = payment.paidTime || new Date(payment.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }); return `<tr><td>${escapeHtml(payment.playerName)}</td><td>${escapeHtml(payment.planName)}<br><strong>${arabicDigits(payment.amount)} ج.م</strong></td><td>${escapeHtml(payment.method === "cash" ? "نقدي" : payment.methodLabel || "تحويل")}</td><td><strong class="payment-reference">${escapeHtml(payment.reference || "—")}</strong>${payment.reference && payment.method !== "cash" ? `<button class="copy-code" data-action="copy-text" data-copy="${escapeHtml(payment.reference)}">نسخ كود الدفع</button>` : ""}</td><td>${payment.receiptImage ? `<button type="button" class="receipt-preview" data-action="receipt-preview" data-receipt="${escapeHtml(payment.receiptImage)}" data-player="${escapeHtml(payment.playerName)}"><img class="receipt-thumbnail" src="${escapeHtml(payment.receiptImage)}" alt="إيصال تحويل ${escapeHtml(payment.playerName)}"><span>اضغط لتكبير الإيصال</span></button>` : "—"}</td><td>${escapeHtml(payment.date)}<br>${escapeHtml(paymentTime)}</td><td>${payment.status === "بانتظار المراجعة" ? `<button class="small-action" data-action="confirm-payment" data-payment="${escapeHtml(payment.id)}" ${user && canRequestPayment(user) ? "" : "disabled"}>مراجعة المبلغ وتأكيده</button>` : `<span class="subscription-badge ${paid ? "status-active" : "status-soon"}">${escapeHtml(payment.status)}</span>${paid && user ? guardianWhatsApp(user, paidMessage, "إشعار الدفع") : ""}`}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-state"><p>لا توجد تحويلات مسجلة حتى الآن.</p></div>'}</section>`;
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

function compressReceipt(file) {
  if (!(file instanceof File) || !file.size) return Promise.reject(new Error("أرفق صورة إيصال التحويل."));
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("صيغة الإيصال يجب أن تكون صورة."));
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error("حجم صورة الإيصال يجب ألا يتجاوز ١٠ ميجابايت."));
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objectUrl);
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error("تعذر تجهيز صورة الإيصال.")); return; }
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("تعذر قراءة صورة الإيصال."));
          reader.readAsDataURL(blob);
        }, "image/jpeg", 0.76);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        console.error("تعذر معالجة صورة الإيصال.", error);
        reject(new Error("تعذر تجهيز صورة الإيصال. جرّب صورة أخرى."));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("تعذر فتح صورة الإيصال."));
    };
    image.src = objectUrl;
  });
}

function requestPayment(planId) {
  if (!["member", "guardian"].includes(currentUser?.role)) { showToast("طلبات الدفع متاحة من حساب ولي الأمر فقط."); return; }
  const player = userForMember();
  if (!player) { showToast("أضف لاعبًا إلى الحساب أولًا."); return; }
  if (!selectedSessionsForMember(player).length) { showToast("اختر مواعيد التدريب أولًا من صفحة جدول التدريبات."); return; }
  if (hasPartialCashPayment(player)) { showToast("أكمل المبلغ النقدي المتبقي قبل تسجيل تحويل إلكتروني."); return; }
  if (!canRequestPayment(player)) { showToast(`يمكن تجديد اشتراك ${player.name} عند تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  if (!data.instaPayAddress) { showToast("لم تضف الأكاديمية بيانات التحويل بعد. تواصل مع المدرب."); return; }
  const dayCount = Number(planId);
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) { showToast("اختر عددًا صحيحًا من أيام التدريب."); return; }
  const plan = priceSummary(dayCount).plan;
  if (hasPendingPayment(player)) { showToast("لدى هذا اللاعب طلب دفع قيد المراجعة بالفعل."); return; }
  openModal("تسجيل تحويل ومراجعة الإيصال", `<p class="modal-explainer">الباقة: ${plan.name} · المبلغ المستحق: ${arabicDigits(plan.price)} ج.م. طريقة الدفع الوحيدة: إنستا باي / محفظة بنكية. أرفق صورة التحويل وأدخل رقم العملية كما يظهر في التطبيق. لن يتفعّل الاشتراك قبل تأكيد الأكاديمية.</p><p class="payment-warning">ولي الأمر أو اللاعب: تأكد من التحويل إلى بيانات الأكاديمية الصحيحة. الأكاديمية غير مسؤولة عن أي تحويل خاطئ.</p><label>رقم التحويل / مرجع العملية<input name="reference" required minlength="4" placeholder="رقم العملية كما يظهر في التطبيق"></label><div class="payment-destination"><span>رقم التحويل إلى الأكاديمية</span><strong>${escapeHtml(data.instaPayAddress)}</strong></div><label>صورة إيصال التحويل<input name="receipt" type="file" accept="image/*" required></label><label>المبلغ المحوّل<input name="amount" type="number" value="${plan.price}" readonly></label>`, "إرسال للمراجعة", async form => {
    const reference = String(form.get("reference")).trim();
    if (reference.length < 4) { showToast("أدخل رقم التحويل الصحيح."); return; }
    const receiptImage = await compressReceipt(form.get("receipt"));
    const payment = { id: crypto.randomUUID(), playerId: player.id, playerName: player.name, planId, planName: plan.name, amount: Number(form.get("amount")), reference, receiptImage, method: "instapay", methodLabel: "إنستا باي / محفظة بنكية", status: "بانتظار المراجعة", createdAt: Date.now(), date: egyptianDate.format(new Date()) };
    data.payments.push(payment);
    if (saveData()) { closeModal(); renderView(); showToast("تم إرسال رقم التحويل وصورة الإيصال للمراجعة."); }
    else data.payments.pop();
  }, "إنستا باي");
}

function openSessionForm(existingSession = null) {
  if (currentUser?.role !== "coach") { showToast("إدارة جدول التدريبات من صلاحية المشرف فقط."); return; }
  const dayOptions = dayCheckboxes(data.workDays, sessionDays(existingSession || {}), "sessionDays");
  if (!data.workDays.length) { showToast("حدد أيام عمل الأكاديمية أولًا من الإعدادات."); return; }
  const trainers = data.users.filter(user => user.role === "trainer");
  if (!trainers.length) { showToast("أضف حساب مدرب من صفحة إدارة المدربين قبل إنشاء الحصة."); return; }
  const trainerOptions = trainers.map(trainer => `<option value="${escapeHtml(trainer.id)}" ${existingSession?.coachId === trainer.id ? "selected" : ""}>${escapeHtml(trainer.name)}</option>`).join("");
  const session = existingSession || {};
  const categoryOptions = AGE_CATEGORIES.map(category => `<option value="${escapeHtml(category)}" ${session.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("");
  openModal(existingSession ? "تعديل موعد تدريب كرة السلة" : "إضافة تدريب كرة السلة", `<label>اسم الحصة<input name="title" required value="${escapeHtml(session.title || "")}" placeholder="تدريب كرة السلة"></label><div class="form-row"><label>المدرب<select name="coachId" required>${trainerOptions}</select></label><label>الفئة العمرية<select name="category" required>${categoryOptions}</select></label></div><fieldset class="registration-days"><legend>أيام تدريب المجموعة</legend><div class="day-choice-grid">${dayOptions}</div></fieldset><label>الوقت<input name="time" required value="${escapeHtml(session.time || "")}" placeholder="٥:٠٠ مساءً"></label><label>الملعب<input name="place" required value="${escapeHtml(session.place || "")}" placeholder="ملعب الأكاديمية"></label><p class="modal-explainer">أيام المجموعة تظل ثابتة حتى يعدلها المشرف. يُحسب التأخير بعد ٣٠ دقيقة، وتظهر المواعيد المرشحة للاعب وولي أمره.</p>`, existingSession ? "حفظ التعديل" : "حفظ التدريب", form => saveSession(form, existingSession?.id), "جدول التدريبات");
}

function saveSession(form, sessionId) {
  if (currentUser?.role !== "coach") { showToast("إدارة التدريب من صلاحية المشرف فقط."); return; }
  const days = form.getAll("sessionDays").map(String).filter(day => data.workDays.includes(day));
  if (!days.length) { showToast("اختر يوم تدريب واحدًا على الأقل."); return; }
  const trainer = data.users.find(user => user.id === form.get("coachId") && user.role === "trainer");
  if (!trainer) { showToast("اختر مدربًا مسجلًا في الأكاديمية."); return; }
  const category = String(form.get("category"));
  if (!AGE_CATEGORIES.includes(category)) { showToast("اختر فئة عمرية صحيحة."); return; }
  const session = { id: sessionId || crypto.randomUUID(), title: String(form.get("title")).trim(), coach: trainer.name, coachId: trainer.id, days, day: days[0], time: String(form.get("time")).trim(), place: String(form.get("place")).trim(), category };
  if (sessionId) {
    const index = data.sessions.findIndex(item => item.id === sessionId);
    if (index < 0) { showToast("لم يتم العثور على موعد التدريب."); return; }
    data.sessions[index] = session;
  } else {
    data.sessions.push(session);
  }
  if (saveData()) { closeModal(); activeView = "schedule"; renderView(); showToast(sessionId ? "تم تحديث موعد التدريب." : "تمت إضافة التدريب إلى الجدول."); }
}

function activateSubscription(user, planId) {
  const dayCount = Number(planId);
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) throw new Error("باقة الدفع غير صالحة لتفعيل الاشتراك.");
  const plan = priceSummary(dayCount).plan;
  user.plan = dayCount;
  user.weeklyDaysCount = dayCount;
  if ((user.weeklyDays || []).length !== dayCount) user.weeklyDays = data.workDays.slice(0, dayCount);
  user.sessionsLeft = plan.sessions;
  user.sessionsUsed = 0;
  const currentEnd = user.subscriptionEnd && daysUntil(user.subscriptionEnd) > 0 ? new Date(`${user.subscriptionEnd}T12:00:00`) : new Date();
  currentEnd.setDate(currentEnd.getDate() + 30);
  user.subscriptionEnd = currentEnd.toISOString().slice(0, 10);
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
  const user = data.users.find(item => item.id === payment.playerId);
  if (!user) { showToast("تعذر العثور على اللاعب المرتبط بطلب الدفع."); return; }
  if (!selectedSessionsForMember(user).length) { showToast("لا يمكن تفعيل الاشتراك قبل اختيار مواعيد التدريب."); return; }
  if (!canRequestPayment(user)) { showToast(`لا يمكن تفعيل تجديد ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  openModal(`مراجعة تحويل ${user.name}`, `<p class="modal-explainer">قيمة الطلب المسجلة ${arabicDigits(payment.amount)} ج.م. أدخل المبلغ الذي وصل فعليًا؛ سيُحدد الاشتراك تلقائيًا بأعلى باقة سعرها لا يتجاوز المبلغ المحوّل. عند تأكيد الدفع تُحدّث أيام التدريب وعدد الحصص حسب الباقة.</p><label>المبلغ المحوّل فعليًا<input name="receivedAmount" type="number" min="1" step="1" value="${Number(payment.amount)}" required></label><p class="price-preview" id="payment-plan-preview">سيتم تحديد الأيام حسب المبلغ الفعلي.</p>`, "تأكيد المبلغ وتفعيل الاشتراك", form => applyPaymentConfirmation(form, payment.id), "تأكيد التحويلات");
}

function applyPaymentConfirmation(form, paymentId) {
  if (currentUser?.role !== "coach") { showToast("تأكيد التحويلات من صلاحية المشرف فقط."); return; }
  const payment = data.payments.find(item => item.id === paymentId && item.status === "بانتظار المراجعة");
  const user = payment && data.users.find(item => item.id === payment.playerId);
  const receivedAmount = Number(form.get("receivedAmount"));
  if (!payment || !user) { showToast("طلب الدفع أو اللاعب غير متاح."); return; }
  if (!Number.isInteger(receivedAmount) || receivedAmount < 1) { showToast("أدخل مبلغ التحويل الفعلي كعدد صحيح موجب."); return; }
  if (!canRequestPayment(user)) { showToast(`لا يمكن تفعيل تجديد ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const plan = planForAmount(receivedAmount);
  if (!plan) { showToast(`المبلغ لا يكفي لأقل باقة متاحة (${arabicDigits(priceSummary(1).plan.price)} ج.م).`); return; }
  const selectedIds = Array.isArray(user.selectedSessionIds) ? user.selectedSessionIds : [];
  const chosenSessions = sessionsForMember(user).filter(session => selectedIds.includes(session.id));
  const priorDays = user.weeklyDays || [];
  const preferredDays = [
    ...data.workDays.filter(day => priorDays.includes(day) && chosenSessions.some(session => sessionDays(session).includes(day))),
    ...data.workDays.filter(day => chosenSessions.some(session => sessionDays(session).includes(day))),
    ...priorDays,
    ...data.workDays
  ];
  const assignedDays = [...new Set(preferredDays)].slice(0, plan.sessions / 4);
  if (assignedDays.length !== plan.sessions / 4 || !chosenSessions.some(session => sessionDays(session).some(day => assignedDays.includes(day)))) {
    showToast("لا توجد مواعيد مختارة تناسب أيام الباقة التي يغطيها المبلغ. حدّث مواعيد اللاعب أولًا.");
    return;
  }
  const previousPayment = { ...payment };
  const previousUser = { ...user, weeklyDays: [...priorDays] };
  const replacedPayments = data.payments.filter(item => item.playerId === user.id && item.id !== payment.id && item.status === "بانتظار المراجعة").map(item => ({ payment: item, status: item.status }));
  const previousAttendance = data.attendance.filter(record => record.playerId === user.id && record.attendedUnpaid).map(record => ({ record, chargedByPaymentAt: record.chargedByPaymentAt }));
  user.weeklyDays = assignedDays;
  user.weeklyDaysCount = assignedDays.length;
  user.plan = assignedDays.length;
  payment.amount = receivedAmount;
  payment.planId = assignedDays.length;
  payment.planName = priceSummary(assignedDays.length).plan.name;
  payment.status = "تم التأكيد";
  payment.confirmedAt = Date.now();
  payment.paidTime = new Date(payment.confirmedAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  payment.date = egyptianDate.format(new Date(payment.confirmedAt));
  replacedPayments.forEach(item => { item.payment.status = "تم استبداله بدفعة مؤكدة أخرى"; });
  let chargedAttendance = 0;
  try {
    chargedAttendance = activateSubscription(user, assignedDays.length);
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
    showToast(`تم تأكيد ${arabicDigits(receivedAmount)} ج.م وتفعيل باقة ${arabicDigits(assignedDays.length)} أيام، وخصم ${arabicDigits(chargedAttendance)} تدريب سابق غير مدفوع.`);
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

function recordCashPayment(playerId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الدفع النقدي من صلاحية المشرف فقط."); return; }
  const user = data.users.find(item => item.id === playerId && item.role === "member");
  if (!user) { showToast("لم يتم العثور على اللاعب."); return; }
  if (!selectedSessionsForMember(user).length) { showToast("اطلب من اللاعب اختيار مواعيد التدريب قبل تسجيل الدفع وتفعيل الاشتراك."); return; }
  if (!canRequestPayment(user)) { showToast(`لا يمكن تجديد اشتراك ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const pendingPayments = data.payments.filter(item => item.playerId === user.id && item.status === "بانتظار المراجعة");
  const dayCount = user.weeklyDays?.length || user.weeklyDaysCount;
  const plan = priceSummary(dayCount).plan;
  const partialPayments = data.payments.filter(item => item.playerId === user.id && item.planId === dayCount && item.status === "دفع جزئي نقدًا");
  const remainingAmount = Math.max(0, plan.price - partialPayments.reduce((total, item) => total + Number(item.amount || 0), 0));
  if (!remainingAmount) { showToast("اكتمل مبلغ الاشتراك نقدًا بالفعل. لا يمكن تسجيل دفعة أخرى له."); return; }
  const now = new Date();
  const paidDate = localDateString(now);
  const paidTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  openModal(`تسجيل دفع نقدي · ${user.name}`, `<p class="modal-explainer">سعر الاشتراك ${arabicDigits(plan.price)} ج.م. المسجل نقدًا حتى الآن ${arabicDigits(plan.price - remainingAmount)} ج.م، والمتبقي لإكماله ${arabicDigits(remainingAmount)} ج.م. لا يتفعل الاشتراك إلا بعد استكمال كامل السعر.${pendingPayments.length ? " سيتم إغلاق التحويلات المعلقة عند تسجيل الدفع النقدي." : ""}</p><label>المبلغ النقدي المستلم<input name="amount" type="number" min="1" max="${remainingAmount}" step="1" value="${remainingAmount}" required></label><div class="form-row"><label>تاريخ الدفع<input name="paidDate" type="date" max="${localDateString()}" value="${paidDate}" required></label><label>ساعة الدفع<input name="paidTime" type="time" value="${paidTime}" required></label></div>`, "تسجيل الدفع النقدي", form => saveCashPayment(form, user.id), "المدفوعات");
}

function saveCashPayment(form, playerId) {
  if (currentUser?.role !== "coach") { showToast("تسجيل الدفع النقدي من صلاحية المشرف فقط."); return; }
  const user = data.users.find(item => item.id === playerId && item.role === "member");
  if (!user) { showToast("لم يتم العثور على اللاعب."); return; }
  if (!selectedSessionsForMember(user).length) { showToast("لا يمكن تسجيل الدفع قبل اختيار مواعيد التدريب."); return; }
  if (!canRequestPayment(user)) { showToast(`لا يمكن تجديد اشتراك ${user.name} قبل تبقي تمرين واحد أو انتهاء الاشتراك.`); return; }
  const dayCount = user.weeklyDays?.length || user.weeklyDaysCount;
  const plan = priceSummary(dayCount).plan;
  const partialPayments = data.payments.filter(item => item.playerId === user.id && item.planId === dayCount && item.status === "دفع جزئي نقدًا");
  const previousCashPaid = partialPayments.reduce((total, item) => total + Number(item.amount || 0), 0);
  const remainingAmount = plan.price - previousCashPaid;
  const amount = Number(form.get("amount"));
  const paidDate = String(form.get("paidDate"));
  const paidTime = String(form.get("paidTime"));
  const confirmedAt = new Date(`${paidDate}T${paidTime}:00`).getTime();
  if (!Number.isFinite(confirmedAt) || paidDate > localDateString() || !Number.isInteger(amount) || amount <= 0 || amount > remainingAmount) {
    showToast("راجع المبلغ النقدي والتاريخ والوقت، ولا تدخل مبلغًا أكبر من المتبقي.");
    return;
  }
  const completesSubscription = amount === remainingAmount;
  const pendingPayments = data.payments.filter(item => item.playerId === user.id && item.status === "بانتظار المراجعة");
  const payment = {
    id: crypto.randomUUID(), playerId: user.id, playerName: user.name, planId: dayCount,
    planName: plan.name, amount, reference: "دفع نقدي في الأكاديمية",
    method: "cash", methodLabel: "نقدي", status: completesSubscription ? "تم الدفع نقدًا" : "دفع جزئي نقدًا",
    createdAt: Date.now(), confirmedAt, paidTime, date: egyptianDate.format(new Date(confirmedAt))
  };
  const previousUser = { ...user, weeklyDays: [...(user.weeklyDays || [])] };
  const previousPaymentStatuses = [...pendingPayments, ...(completesSubscription ? partialPayments : [])].map(item => ({ payment: item, status: item.status }));
  const previousAttendance = data.attendance.filter(record => record.playerId === user.id && record.attendedUnpaid).map(record => ({ record, chargedByPaymentAt: record.chargedByPaymentAt }));
  data.payments.push(payment);
  pendingPayments.forEach(item => { item.status = "تم استبداله بدفعة نقدية"; });
  if (completesSubscription) partialPayments.forEach(item => { item.status = "تم استكمال الدفع النقدي"; });
  let chargedAttendance = 0;
  if (completesSubscription) {
    try {
      chargedAttendance = activateSubscription(user, dayCount);
    } catch (error) {
      data.payments.pop();
      previousPaymentStatuses.forEach(item => { item.payment.status = item.status; });
      previousAttendance.forEach(item => { item.record.attendedUnpaid = true; delete item.record.chargedByPaymentAt; });
      showToast(error.message);
      return;
    }
  }
  if (saveData()) { closeModal(); renderView(); showToast(completesSubscription ? `تم استكمال الدفع النقدي وتفعيل اشتراك ${user.name} وخصم ${arabicDigits(chargedAttendance)} تدريب سابق.` : `تم تسجيل ${arabicDigits(amount)} ج.م نقدًا للاعب ${user.name}. يتبقى ${arabicDigits(remainingAmount - amount)} ج.م ولا يتفعل الاشتراك قبل سداد كامل السعر.`); }
  else {
    data.payments.pop();
    previousPaymentStatuses.forEach(item => { item.payment.status = item.status; });
    Object.assign(user, previousUser);
    previousAttendance.forEach(item => {
      item.record.attendedUnpaid = true;
      if (item.chargedByPaymentAt === undefined) delete item.record.chargedByPaymentAt;
      else item.record.chargedByPaymentAt = item.chargedByPaymentAt;
    });
  }
}

byId("login-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const user = data.users.find(item => item.username?.toLocaleLowerCase("ar") === String(form.get("username")).trim().toLocaleLowerCase("ar") && item.password === form.get("password") && ["guardian", "trainer"].includes(item.role));
  if (!user) { showToast("بيانات الدخول غير صحيحة أو الحساب غير مسجل. دخول المشرف من الزر المخصص."); return; }
  signIn(user);
});

byId("register-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const username = String(form.get("username")).trim();
  if (data.users.some(user => user.username?.toLocaleLowerCase("ar") === username.toLocaleLowerCase("ar"))) { showToast("اسم المستخدم مستخدم بالفعل، اختر اسمًا آخر."); return; }
  const guardianPhone = String(form.get("guardianPhone")).replace(/\s/g, "");
  const whatsappPhone = String(form.get("whatsappPhone")).replace(/\s/g, "");
  if (!/^01\d{9}$/.test(guardianPhone)) { showToast("أدخل رقم هاتف مصري صحيحًا مكوّنًا من ١١ رقمًا."); return; }
  if (!/^01\d{9}$/.test(whatsappPhone)) { showToast("أدخل رقم واتساب مصريًا صحيحًا مكوّنًا من ١١ رقمًا."); return; }
  const user = { id: crypto.randomUUID(), role: "guardian", name: String(form.get("guardianName")).trim(), guardianPhone, whatsappPhone, username, password: String(form.get("password")), joinedAt: new Date().toISOString() };
  if (user.name.length < 2 || username.length < 3 || String(form.get("password")).length < 6) { showToast("أكمل اسم ولي الأمر واسم المستخدم وكلمة المرور."); return; }
  data.users.push(user);
  if (!saveData()) { data.users.pop(); return; }
  event.currentTarget.reset();
  signIn(user);
  showToast("تم إنشاء حساب ولي الأمر. أضف بيانات اللاعب للبدء.");
  openPlayerForm();
});

byId("player-code-entry").addEventListener("click", openPlayerCodeLogin);
byId("coach-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  if (String(form.get("password")) !== COACH_PASSWORD) { showToast("كلمة مرور المشرف غير صحيحة."); return; }
  signIn({ id: "coach-hazem", role: "coach", name: OWNER_NAME });
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
    activeView = viewButton.dataset.view;
    byId("portal-sidebar").classList.remove("open");
    renderView();
    return;
  }
  const action = target.closest("[data-action]");
  if (!action) return;
  if (["new-session", "edit-session", "delete-session", "take-attendance", "code-attendance", "cash-payment", "new-trainer", "mark-trainer-attendance", "new-expense", "instapay-settings", "confirm-payment", "receipt-preview", "approve-makeup", "reject-makeup", "delete-expense", "delete-guardian"].includes(action.dataset.action) && currentUser.role !== "coach") {
    showToast("هذا الإجراء متاح لمشرف الأكاديمية فقط.");
    return;
  }
  if (action.dataset.action === "payment" && ["member", "guardian"].includes(currentUser.role)) {
    const player = userForMember();
    if (player) requestPayment(player.weeklyDays.length || player.weeklyDaysCount);
  }
  if (action.dataset.action === "new-player") openPlayerForm();
  if (action.dataset.action === "new-session") {
    openSessionForm();
  }
  if (action.dataset.action === "edit-session") {
    const session = data.sessions.find(item => item.id === action.dataset.session);
    if (!session) { showToast("لم يتم العثور على موعد التدريب."); return; }
    openSessionForm(session);
  }
  if (action.dataset.action === "delete-session") {
    const session = data.sessions.find(item => item.id === action.dataset.session);
    if (!session) { showToast("لم يتم العثور على موعد التدريب."); return; }
    if (!window.confirm(`هل تريد حذف حصة ${session.title} أيام ${sessionDays(session).join("، ")}؟`)) return;
    data.sessions = data.sessions.filter(item => item.id !== session.id);
    if (saveData()) { renderView(); showToast("تم حذف موعد التدريب."); }
  }
  if (action.dataset.action === "take-attendance") openAttendanceRoster(action.dataset.session);
  if (action.dataset.action === "code-attendance") openCodeAttendanceForm();
  if (action.dataset.action === "request-makeup") openMakeupRequest(action.dataset.attendance);
  if (action.dataset.action === "approve-makeup") reviewMakeupRequest(action.dataset.request, true);
  if (action.dataset.action === "reject-makeup") reviewMakeupRequest(action.dataset.request, false);
  if (action.dataset.action === "receipt-preview") {
    openModal(`إيصال تحويل ${action.dataset.player}`, `<div class="receipt-preview-modal"><img src="${escapeHtml(action.dataset.receipt)}" alt="إيصال تحويل ${escapeHtml(action.dataset.player)}"></div>`, "إغلاق", closeModal, "مراجعة التحويلات");
  }
  if (action.dataset.action === "trainer-mark-attendance") openSearchedPlayerAttendanceForm(action.dataset.player, action.dataset.session);
  if (action.dataset.action === "cash-payment") recordCashPayment(action.dataset.player);
  if (action.dataset.action === "delete-guardian") deleteGuardian(action.dataset.guardian);
  if (action.dataset.action === "new-trainer") openTrainerForm();
  if (action.dataset.action === "mark-trainer-attendance") openTrainerAttendanceForm();
  if (action.dataset.action === "new-expense") openExpenseForm();
  if (action.dataset.action === "instapay-settings") {
    if (currentUser.role !== "coach") { showToast("إعداد التحويل من صلاحية المشرف فقط."); return; }
    openModal("رقم إنستا باي للأكاديمية", `<label>رقم التحويل عبر إنستا باي<input value="${DEFAULT_INSTAPAY_NUMBER}" readonly></label><p class="modal-explainer">يستخدم اللاعبون الرقم الثابت 01017692213 للتحويل. يراجع المشرف رقم العملية وصورة الإيصال ثم يؤكد الدفع.</p>`, "تم", () => {
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
  if (action.dataset.action === "confirm-payment") confirmPayment(action.dataset.payment);
  if (action.dataset.action === "delete-expense") deleteExpense(action.dataset.expense);
  if (action.classList.contains("request-plan")) requestPayment(action.dataset.plan);
});

document.addEventListener("change", event => {
  if (event.target.id === "selected-player" && currentUser?.role === "guardian") {
    selectedPlayerId = event.target.value;
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
  if (event.target.name === "receivedAmount" && currentUser?.role === "coach") {
    const amount = Number(event.target.value);
    const plan = Number.isInteger(amount) && amount > 0 ? planForAmount(amount) : null;
    const preview = byId("payment-plan-preview");
    if (preview) preview.textContent = plan
      ? `الباقة التي يغطيها المبلغ: ${plan.name} · ${arabicDigits(plan.price)} ج.م · ${arabicDigits(plan.sessions)} حصة`
      : `الحد الأدنى لتفعيل الاشتراك ${arabicDigits(priceSummary(1).plan.price)} ج.م.`;
  }
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
byId("logout-button").addEventListener("click", () => { currentUser = null; selectedPlayerId = null; showAuth(); });
byId("portal-notifications").addEventListener("click", () => {
  if (currentUser.role === "coach") {
    const pending = data.payments.filter(payment => payment.status === "بانتظار المراجعة").length;
    const expired = data.users.filter(user => user.role === "member" && subscriptionState(user).label === "منتهي").length;
    const unpaidArrivals = data.attendance.filter(record => record.isoDate === localDateString() && record.attendedUnpaid).length;
    showToast(`${arabicDigits(pending)} دفعة للمراجعة، ${arabicDigits(expired)} اشتراك منتهٍ، ${arabicDigits(unpaidArrivals)} حضور دون دفع اليوم.`);
  } else if (currentUser.role === "trainer") {
    const sessions = data.sessions.filter(session => session.coachId === currentUser.id).length;
    showToast(`لديك ${arabicDigits(sessions)} حصة مسندة إليك. تسجيل الحضور والتحويلات لدى المشرف.`);
  } else {
    const user = userForMember();
    if (!user) { showToast("أضف لاعبًا إلى حساب ولي الأمر أولًا."); return; }
    const notices = memberNotifications(user);
    showToast(notices.length ? notices[0] : "لا توجد تنبيهات جديدة. تابع جدول تدريباتك.");
  }
});
byId("profile-button").addEventListener("click", () => { currentUser = null; selectedPlayerId = null; showAuth(); });
