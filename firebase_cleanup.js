/**
 * سكربت التنظيف التلقائي لقاعدة بيانات Firebase Realtime Database - لتطبيق CryptChat
 * 
 * هذا السكربت يقوم بتنظيف وإزالة البيانات المؤقتة والمنتهية الصلاحية من السيرفر لزيادة كفاءة التخزين وسرعته:
 * 1. حذف الحالات (Statuses) المنتهية الصلاحية التي تجاوزت 24 ساعة.
 * 2. حذف إشارات الاتصالات المؤقتة (ephemeral call signaling) التي تجاوزت 10 دقائق لتوفير المساحة وتجنب التداخل.
 * 3. تنظيف الرسائل القديمة (أكبر من 3 أيام مثلاً) لضمان سعة تخزينية دائمة ومجانية غير محدودة.
 * 4. تصفية وتحديث وضع المستخدمين غير النشطين.
 */

const admin = require("firebase-admin");

// مسار ملف مفتاح حساب الخدمة من Firebase Console
// قم بتحميل الملف من: Firebase Console -> Project Settings -> Service Accounts -> Generate New Private Key
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || "./serviceAccountKey.json";

let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (e) {
  console.log("⚠️  تنبيه: لم يتم العثور على ملف مفتاح الخدمة 'serviceAccountKey.json' في هذا المسار.");
  console.log("يرجى وضع ملف المفتاح في مجلد السكربت باسم 'serviceAccountKey.json' أو تعيين المتغير البيئي FIREBASE_SERVICE_ACCOUNT_KEY.");
  console.log("سيقوم السكربت الآن بمحاولة استخدام المصادقة التلقائية لـ Google Application Default Credentials...");
}

const dbUrl = "https://mewzk-dc7e0-default-rtdb.firebaseio.com";

const initConfig = {
  databaseURL: dbUrl
};

if (serviceAccount) {
  initConfig.credential = admin.credential.cert(serviceAccount);
} else {
  // المحاولة بالاعتماديات الافتراضية للبيئة
  try {
    initConfig.credential = admin.credential.applicationDefault();
  } catch (err) {
    console.error("❌ خطأ حرج: لا يمكن تهيئة Firebase - يرجى توفير ملف حساب الخدمة المعتمد.");
    process.exit(1);
  }
}

// تهيئة السيرفر
admin.initializeApp(initConfig);
const db = admin.database();

console.log(`⚡ تم الاتصال بنجاح بقاعدة بيانات CryptChat الجديدة: ${dbUrl}`);
console.log("-----------------------------------------");

async function runCleanup() {
  const now = Date.now();
  
  // 1. تنظيف الحالات المنتهية الصلاحية (أقدم من 24 ساعة)
  try {
    const statusesRef = db.ref("statuses");
    const snapshot = await statusesRef.once("value");
    const twentyFourHours = 5 * 60 * 60 * 1000;
    let deletedStatuses = 0;

    if (snapshot.exists()) {
      const statuses = snapshot.val();
      for (const key of Object.keys(statuses)) {
        const status = statuses[key];
        const age = now - (status.timestamp || now);
        if (age > twentyFourHours) {
          await statusesRef.child(key).remove();
          deletedStatuses++;
        }
      }
    }
    console.log(`✅ [تنظيف الحالات]: تم حذف عدد (${deletedStatuses}) حالة منتهية الصلاحية (عمرها تجاوز 5 ساعات).`);
  } catch (error) {
    console.error("❌ خطأ أثناء تنظيف الحالات:", error);
  }

  // 2. تنظيف قنوات الاتصال الصوتي وإشارات الرنين المؤقتة (أقدم من 10 دقائق)
  try {
    const callsIncomingRef = db.ref("calls_incoming");
    const callsIncomingSnap = await callsIncomingRef.once("value");
    const tenMinutes = 10 * 60 * 1000;
    let deletedCalls = 0;

    if (callsIncomingSnap.exists()) {
      const calls = callsIncomingSnap.val();
      for (const receiverTag of Object.keys(calls)) {
        const callData = calls[receiverTag];
        const timestamp = callData.timestamp || 0;
        if (timestamp > 0 && (now - timestamp) > tenMinutes) {
          await callsIncomingRef.child(receiverTag).remove();
          deletedCalls++;
        }
      }
    }
    console.log(`✅ [تنظيف الاتصالات]: تم حذف عدد (${deletedCalls}) إشارة رنين اتصال قديمة ومعلقة.`);
  } catch (error) {
    console.error("❌ خطأ أثناء تنظيف إشارات الرنين:", error);
  }

  // 3. تنظيف بث الصوت للاتصالات الجارية المنتهية (أقدم من 10 دقائق)
  try {
    const callsAudioRef = db.ref("calls_audio");
    const callsAudioSnap = await callsAudioRef.once("value");
    const tenMinutes = 10 * 60 * 1000;
    let deletedAudioNodes = 0;

    if (callsAudioSnap.exists()) {
      const audioNodes = callsAudioSnap.val();
      for (const nodeKey of Object.keys(audioNodes)) {
        const nodeData = audioNodes[nodeKey];
        // فحص طابع الرنين داخل العقد الفرعية (caller أو receiver)
        let maxTime = 0;
        if (nodeData.caller && nodeData.caller.timestamp) maxTime = Math.max(maxTime, nodeData.caller.timestamp);
        if (nodeData.receiver && nodeData.receiver.timestamp) maxTime = Math.max(maxTime, nodeData.receiver.timestamp);
        
        if (maxTime === 0 || (now - maxTime) > tenMinutes) {
          await callsAudioRef.child(nodeKey).remove();
          deletedAudioNodes++;
        }
      }
    }
    console.log(`✅ [تنظيف بث الصوت]: تم مسح عدد (${deletedAudioNodes}) غرفة محادثة صوتية مهجورة.`);
  } catch (error) {
    console.error("❌ خطأ أثناء تنظيف البث الصوتي وبينات الاتصالات:", error);
  }

  // 4. تنظيف الرسائل القديمة تلقائياً لتوفير مساحة التخزين (أقدم من 3 أيام)
  try {
    const messagesRef = db.ref("messages");
    const messagesSnap = await messagesRef.once("value");
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    let deletedMessages = 0;

    if (messagesSnap.exists()) {
      const chats = messagesSnap.val();
      for (const chatId of Object.keys(chats)) {
        const messagesMap = chats[chatId];
        for (const msgKey of Object.keys(messagesMap)) {
          const message = messagesMap[msgKey];
          const timestamp = message.timestamp || now;
          if ((now - timestamp) > threeDays) {
            await messagesRef.child(chatId).child(msgKey).remove();
            deletedMessages++;
          }
        }
        
        // التحقق من خلو الغرفة وحذفها بالكامل لتوفير المساحة
        const updatedChatSnap = await messagesRef.child(chatId).once("value");
        if (!updatedChatSnap.exists() || Object.keys(updatedChatSnap.val() || {}).length === 0) {
          await messagesRef.child(chatId).remove();
        }
      }
    }
    console.log(`✅ [تنظيف الرسائل]: تم تنظيف عدد (${deletedMessages}) رسالة قديمة مشفرة تجاوزت 3 أيام للحفاظ على انسيابية السيرفر وجاهزيته.`);
  } catch (error) {
    console.error("❌ خطأ أثناء تنظيف الرسائل القديمة:", error);
  }

  console.log("-----------------------------------------");
  console.log("🎉 اكتملت عملية الصيانة الدورية وتطهير البيانات بنجاح!");
  process.exit(0);
}

// بدء التشغيل المباشر
runCleanup();
