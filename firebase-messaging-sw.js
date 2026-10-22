importScripts("https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyC9aS9Syk-aeAkRxdfVozcgn_ntufrDU7U",
  authDomain: "al-attihad-academy-68905.firebaseapp.com",
  projectId: "al-attihad-academy-68905",
  messagingSenderId: "6173840281",
  appId: "1:6173840281:web:a02c45aeafef1a455ff908",
  measurementId: "G-T993GGK10Z"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = payload.data?.title || "الاتحاد أكادمي";
  const body = payload.data?.body || "لديك تحديث جديد من الأكاديمية.";
  const icon = new URL("./app-icon.svg", self.location.href).href;
  return self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    tag: payload.data?.eventId || undefined,
    data: { url: payload.data?.url || "/" }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  if (target.origin !== self.location.origin) target.href = self.location.origin;
  event.waitUntil(self.clients.openWindow(target.href));
});
