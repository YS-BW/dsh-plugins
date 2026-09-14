// DSH Desktop 通知的原生投递层（Node-API addon）。
//
// 这是本插件唯一碰 macOS 原生 API 的地方。它**只在子进程里**被加载，子进程的可执行
// 文件是 DSH Desktop 的**主二进制**（用 ELECTRON_RUN_AS_NODE=1 跑 node 模式），所以
// Bundle.main 解析成 `/Applications/DSH Desktop.app`，通知的归属身份就是
// `io.dsh.desktop` —— 显示成「DSH Desktop」加官方图标。
//
// ## 为什么必须守卫 bundleIdentifier
//
// 没有 bundle 身份时，`+[UNUserNotificationCenter currentNotificationCenter]` 会抛
// `NSInternalInconsistencyException`（reason: bundleProxyForCurrentProcess is nil），
// 而且这个异常**穿透 @try/@catch 直接 SIGABRT 打死整个进程**（实测 exit 134）。
// 如果宿主是「自带真 node」的壳（比如 dsh-desktop-min），harness 进程就没有 bundle
// 身份，一次通知调用会把整个会话打死。所以任何 UN 调用之前先查身份。
//
// ## 为什么必须回报 settings
//
// `addNotificationRequest` 在**未授权**时照样返回成功：通知会进通知中心，但
// `alertSetting`/`soundSetting` 是 0，横幅不弹、声音不响 —— 完全静默。只报"投递成功"
// 等于骗人，所以 send 的结果里要带上授权与提醒设置的真实读数。
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <dispatch/dispatch.h>

/// 把 JS 字符串属性读进定长缓冲；读不到时保留 fallback。
static void readString(napi_env env, napi_value object, const char *key, char *out, size_t cap) {
  napi_value value;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, out, cap, &len) != napi_ok) out[0] = '\0';
}

/// 把 JS 布尔属性读出来；读不到时保留 fallback。
static bool readBool(napi_env env, napi_value object, const char *key, bool fallback) {
  napi_value value;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return fallback;
  bool result = fallback;
  if (napi_get_value_bool(env, value, &result) != napi_ok) return fallback;
  return result;
}

/// 给结果对象设一个字符串字段。
static void setString(napi_env env, napi_value object, const char *key, NSString *value) {
  napi_value js;
  napi_create_string_utf8(env, value == nil ? "" : [value UTF8String], NAPI_AUTO_LENGTH, &js);
  napi_set_named_property(env, object, key, js);
}

/// 给结果对象设一个布尔字段。
static void setBool(napi_env env, napi_value object, const char *key, bool value) {
  napi_value js;
  napi_get_boolean(env, value, &js);
  napi_set_named_property(env, object, key, js);
}

/// 给结果对象设一个整数字段。
static void setInt(napi_env env, napi_value object, const char *key, int32_t value) {
  napi_value js;
  napi_create_int32(env, value, &js);
  napi_set_named_property(env, object, key, js);
}

/// 取当前 bundle 标识；没有身份时返回 nil。
static NSString *currentBundleId(void) {
  NSBundle *bundle = [NSBundle mainBundle];
  NSString *identifier = [bundle bundleIdentifier];
  return identifier != nil && [identifier length] > 0 ? identifier : nil;
}

/// 同步读一次通知设置。
static UNNotificationSettings *readSettings(UNUserNotificationCenter *center, double seconds) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block UNNotificationSettings *captured = nil;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    captured = settings;
    dispatch_semaphore_signal(sem);
  }];
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)));
  return captured;
}

/// 把通知设置写进结果对象：授权状态与"横幅/声音到底开没开"。
static void attachSettings(napi_env env, napi_value out, UNNotificationSettings *settings) {
  if (settings == nil) {
    setInt(env, out, "authorizationStatus", -1);
    return;
  }
  setInt(env, out, "authorizationStatus", (int32_t)settings.authorizationStatus);
  setInt(env, out, "alertSetting", (int32_t)settings.alertSetting);
  setInt(env, out, "soundSetting", (int32_t)settings.soundSetting);
  setInt(env, out, "alertStyle", (int32_t)settings.alertStyle);
}

/// status() -> { bundleId, authorizationStatus, alertSetting, soundSetting, alertStyle }
static napi_value Status(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_object(env, &out);

  NSString *identifier = currentBundleId();
  if (identifier == nil) {
    setString(env, out, "bundleId", @"");
    setString(env, out, "error", @"no-bundle-identity");
    return out;
  }
  setString(env, out, "bundleId", identifier);

  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  if (center == nil) {
    setString(env, out, "error", @"center-nil");
    return out;
  }
  attachSettings(env, out, readSettings(center, 5.0));
  return out;
}

/// send({ title, body, sound }) -> { ok, bundleId, error?, authorizationStatus, alertSetting, soundSetting }
static napi_value Send(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {NULL};
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value out;
  napi_create_object(env, &out);

  NSString *identifier = currentBundleId();
  if (identifier == nil) {
    // 关键守卫：绝不带着空身份往下走，那会 SIGABRT 打死整个宿主进程。
    setString(env, out, "bundleId", @"");
    setString(env, out, "error", @"no-bundle-identity");
    setBool(env, out, "ok", false);
    return out;
  }
  setString(env, out, "bundleId", identifier);

  char title[512] = "DSH";
  char body[2048] = "";
  bool sound = true;
  if (argc > 0 && argv[0] != NULL) {
    readString(env, argv[0], "title", title, sizeof(title));
    readString(env, argv[0], "body", body, sizeof(body));
    sound = readBool(env, argv[0], "sound", true);
  }

  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  if (center == nil) {
    setString(env, out, "error", @"center-nil");
    setBool(env, out, "ok", false);
    return out;
  }

  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = [NSString stringWithUTF8String:title];
  content.body = [NSString stringWithUTF8String:body];
  if (sound) content.sound = [UNNotificationSound defaultSound];

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSError *failure = nil;
  __block bool timedOut = false;
  UNNotificationRequest *request =
    [UNNotificationRequest requestWithIdentifier:[[NSUUID UUID] UUIDString]
                                         content:content
                                         trigger:nil];
  [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    failure = error;
    dispatch_semaphore_signal(sem);
  }];
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
    timedOut = true;
  }

  if (timedOut) {
    setString(env, out, "error", @"timeout");
    setBool(env, out, "ok", false);
  } else if (failure != nil) {
    setString(env, out, "error",
              [NSString stringWithFormat:@"%@ code=%ld -- %@",
                                         [failure domain], (long)[failure code],
                                         [failure localizedDescription]]);
    setBool(env, out, "ok", false);
  } else {
    setBool(env, out, "ok", true);
  }

  // 即使投递成功也回报设置读数：未授权时 addNotificationRequest 照样返回成功，
  // 但横幅不会弹。把这个真相一并交出去，避免"报告成功、实际静默"。
  attachSettings(env, out, readSettings(center, 5.0));
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value send, status;
  napi_create_function(env, "send", NAPI_AUTO_LENGTH, Send, NULL, &send);
  napi_set_named_property(env, exports, "send", send);
  napi_create_function(env, "status", NAPI_AUTO_LENGTH, Status, NULL, &status);
  napi_set_named_property(env, exports, "status", status);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
