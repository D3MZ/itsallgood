const HOST = "com.demetrius.itsallgood";
const MAX_PARALLEL = 4;
const queue = [];
const inFlight = new Map();
let running = 0;
let pausedUntil = 0;
let signingIn = false;

async function native(message) {
  const result = await browser.runtime.sendNativeMessage(HOST, message);
  if (!result || result.error) throw new Error(result?.error || "The extension did not respond.");
  return result;
}

async function settings(retryKeychain = false) {
  const stored = await browser.storage.local.get(["enabled", "lastError", "showWelcome"]);
  const status = await native({ type: "status", retryKeychain });
  if (status.sessionRecovered) await notifyTabs({ type: "refresh" });
  return { ...status, enabled: stored.enabled !== false, lastError: stored.lastError, showWelcome: stored.showWelcome };
}

async function notifyTabs(message) {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.filter(tab => /^https?:\/\/(x|twitter)\.com\//i.test(tab.url || ""))
    .map(tab => browser.tabs.sendMessage(tab.id, message).catch(() => {})));
}

function notifyActivity(saved = false) {
  browser.runtime.sendMessage({ type: "activity_changed", checking: running, queued: queue.length, saved }).catch(() => {});
}

function drain() {
  while (running < MAX_PARALLEL && queue.length) {
    const item = queue.shift();
    if (Date.now() < pausedUntil) {
      item.reject(new Error("Filtering is temporarily paused. Open the extension to check your connection."));
      continue;
    }
    running++;
    notifyActivity();
    native({ type: "classify", post: item.post }).then(result => {
      browser.storage.local.remove("lastError").catch(() => {});
      item.resolve(result);
      if (!result.cached) notifyActivity(true);
    }, error => {
      console.error("Its All Good: classification failed", error.message);
      browser.storage.local.set({ lastError: error.message }).catch(() => {});
      // Avoid repeatedly consuming requests when the account or service cannot respond.
      pausedUntil = Date.now() + 30_000;
      item.reject(error);
    }).finally(() => { running--; drain(); });
  }
  notifyActivity();
}

function classify(post) {
  const key = `${post.id}:${post.fingerprint}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = new Promise((resolve, reject) => {
    queue.push({ post, resolve, reject });
    drain();
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function signIn() {
  if (signingIn) throw new Error("Sign-in is already in progress.");
  signingIn = true;
  try {
    await native({ type: "sign_in" });
    const { welcomed } = await browser.storage.local.get("welcomed");
    if (!welcomed) await browser.storage.local.set({ showWelcome: true, welcomed: true });
    await browser.storage.local.remove("lastError");
    pausedUntil = 0;
    await notifyTabs({ type: "refresh" });
  } finally {
    signingIn = false;
  }
  return { ok: true };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if ((sender.id && sender.id !== browser.runtime.id) || !message || typeof message.type !== "string") return;
  const senderURL = sender.url || sender.tab?.url || "";
  const extensionPage = senderURL.startsWith(browser.runtime.getURL("")) || (!senderURL && !sender.tab);
  const page = /^https?:\/\/(x|twitter)\.com\//i.test(senderURL);
  if (message.type === "settings" && (page || extensionPage)) return settings(extensionPage);
  if (message.type === "classify" && page && message.post?.id && message.post?.fingerprint) return classify(message.post);
  if (!extensionPage) return;
  if (message.type === "sign_in") return signIn();
  if (message.type === "sign_out") return native({ type: "sign_out" }).then(async result => {
    await notifyTabs({ type: "refresh" });
    return result;
  });
  if (message.type === "set_enabled") return browser.storage.local.set({ enabled: !!message.enabled }).then(async () => {
    pausedUntil = 0;
    await notifyTabs({ type: "refresh" });
    return { ok: true };
  });
  if (message.type === "dismiss_welcome") return browser.storage.local.remove("showWelcome").then(() => ({ ok: true }));
  if (message.type === "recent") return native({ type: "recent", filter: message.filter || (message.hiddenOnly === false ? "all" : "hidden"), search: message.search || "", limit: message.limit || 100 });
  if (message.type === "stats") return native({ type: "stats" }).then(result => ({ ...result, checking: running, queued: queue.length }));
  if (message.type === "restore") return native({ type: "restore", id: message.id }).then(async result => {
    await notifyTabs({ type: "restore", id: message.id });
    notifyActivity(true);
    return result;
  });
});
