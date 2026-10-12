# إعداد Firebase لأكاديمية الاتحاد

يدعم الموقع الآن تسجيل البريد وكلمة المرور عبر Firebase Authentication، وحفظ بيانات الأكاديمية في Firestore، ومزامنة التغييرات مباشرةً، ورفع صور الإيصالات إلى Firebase Storage.

## إعداد لوحة Firebase

1. افتح مشروع `al-attihad-academy-68905` في Firebase Console.
2. من **Authentication → Sign-in method** فعّل **Email/Password** و**Anonymous**. الدخول المجهول مستخدم لملفات اللاعبين التي لا تملك بريدًا؛ تسجيل الدخول بكود اللاعب لن يعمل دون تفعيل Anonymous.
3. أنشئ قاعدة Firestore الافتراضية، ثم افتح **Storage → Get started** لإنشاء bucket فعليًا وحدد موقع التخزين. يجب أن يطابق اسم الـ bucket `storageBucket` في `firebase.js`.
4. انشر قواعد الوصول الموجودة في `firestore.rules` و`storage.rules` من تبويبي Firestore Rules وStorage Rules، أو شغّل `firebase deploy --only firestore:rules,storage:rules` بعد تسجيل الدخول إلى Firebase CLI واختيار المشروع.
5. أضف نطاق النشر إلى **Authentication → Settings → Authorized domains**، وشغّل الموقع من نطاق HTTPS أو localhost، وليس بفتحه كملف `file://`.

## إنشاء أول حساب للمشرف

دور المشرف لا يمكن منحه من نموذج عام. أنشئ حساب البريد الإلكتروني للمشرف من **Authentication → Users**، ثم في Firestore أنشئ المستند `users/{UID}` باستخدام UID نفسه وبالحقول:

```json
{
  "id": "UID_FROM_AUTHENTICATION",
  "role": "coach",
  "name": "حازم الدخاخني",
  "email": "COACH_EMAIL"
}
```

استخدم البريد `al.itthad.academy@gmail.com` لحساب المشرف في Authentication، وتأكد أن ملف `users/{UID}` لذلك الحساب يحمل `role: "coach"`. شاشة المشرف تطلب كلمة المرور فقط وتستخدم هذا البريد داخليًا. اضبط كلمة مرور الحساب في Firebase Authentication على كلمة المرور المعتمدة للمشرف. لا تُضمّن كلمة المرور في ملفات الموقع.

## قائمة المدربين

من لوحة المشرف أضف أسماء المدربين مباشرةً. تُحفظ كملفات في مجموعة `users` لاستخدامها في توزيع حصص التدريب وسجل حضور المدربين. لا يلزم للمدرب بريد أو حساب Firebase أو تسجيل دخول؛ المشرف يدير القائمة والحضور من حسابه.

## أماكن حفظ البيانات

- `users`: ملفات أولياء الأمور والمدربين والمشرف.
- `players` و`playerCodes` و`playerSessions`: ملفات اللاعبين وأكوادهم وربط جلسات دخول اللاعب المجهول.
- `sessions` و`settings`: المواعيد وأيام العمل والأسعار وبيانات التحويل.
- `attendance` و`attendanceExceptions` و`trainerAttendance`: الحضور والغياب وطلبات التعويض وحضور المدربين.
- `payments`: طلبات الدفع وحالات الموافقة ومرجع التحويل ومسار الإيصال.
- `expenses`: المصروفات.
- `receipts/{guardianId}/{paymentId}.jpg` في Storage: صور الإيصالات المضغوطة.

## بيانات النسخة المحلية القديمة

التسجيلات الجديدة والتغييرات بعد تسجيل الدخول تُحفظ سحابيًا. الحسابات القديمة في `localStorage` لا يمكن تحويل كلمات مرورها إلى Firebase Authentication تلقائيًا؛ يلزم إعادة تسجيل ولي الأمر بالبريد الجديد وإنشاء حسابات المدربين والمشرف في Authentication. استورد بيانات الأكاديمية القديمة إلى Firestore من لوحة موثوقة بعد مراجعتها، ولا تنسخ كلمات المرور القديمة إلى Firestore.

أكواد اللاعبين لا تعمل إلا إذا كان ملف اللاعب موجودًا في `players/{code}` ومفتاحه في `playerCodes/{code}` على Firestore؛ الأكواد المحفوظة محليًا فقط تحتاج إلى استيراد البيانات قبل استخدامها. إذا ظهر `permission-denied` فتحقق من نشر `firestore.rules` و`storage.rules`. رفع الإيصال يحتاج كذلك إلى تفعيل Storage وإنشاء bucket ونشر `storage.rules`.

## ملاحظة بشأن إيصالات التحويل

يحفظ التطبيق نسخة الإيصال في Storage ويربطها بطلب الدفع في Firestore. الإيصال مجرّد إثبات مرفق؛ يظل على المشرف مراجعة التحويل البنكي بنفسه قبل اعتماد الاشتراك.
