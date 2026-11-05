const HOST = "com.demetrius.itsallgood";
const MAX_PARALLEL = 4;
const queue = [];
const inFlight = new Map();
let running = 0;
let pausedUntil = 0;
let signingIn = false;
let historyGeneration = 0;
let clearingHistory = false;

async function native(message) {
  const result = await browser.runtime.sendNativeMessage(HOST, message);
  if (!result || result.error) throw new Error(result?.error || "The extension did not respond.");
  return result;
}

async function settings(retrySession = false) {
  const stored = await browser.storage.local.get(["enabled", "lastError", "firstSignInNotice"]);
  const status = await native({ type: "status", retrySession });
  if (/keychain/i.test(stored.lastError || "")) {
    await browser.storage.local.remove("lastError");
    delete stored.lastError;
  }
  if (retrySession || status.sessionRecovered) {
    await browser.storage.local.remove("lastError");
    delete stored.lastError;
    pausedUntil = 0;
    await notifyTabs({ type: "refresh" }).catch(() => {});
  }
  return { ...status, enabled: stored.enabled !== false, lastError: stored.lastError, showWelcome: stored.firstSignInNotice };
}

function reply(promise) {
  return Promise.resolve(promise).catch(error => ({ error: error?.message || String(error) }));
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
  if (clearingHistory) { notifyActivity(); return; }
  while (running < MAX_PARALLEL && queue.length) {
    const item = queue.shift();
    if (item.generation !== historyGeneration) { item.resolve({ stale: true }); continue; }
    if (Date.now() < pausedUntil) {
      item.reject(new Error("Filtering is temporarily paused. Open the extension to check your connection."));
      continue;
    }
    running++;
    notifyActivity();
    native({ type: "classify", post: item.post }).then(result => {
      if (item.generation !== historyGeneration || result.stale) { item.resolve({ stale: true }); return; }
      browser.storage.local.remove("lastError").catch(() => {});
      item.resolve(result);
      if (!result.cached) notifyActivity(true);
    }, error => {
      if (item.generation !== historyGeneration) { item.resolve({ stale: true }); return; }
      console.error("Its All Good: classification failed", error.message);
      browser.storage.local.set({ lastError: error.message }).catch(() => {});
      // Avoid repeatedly consuming requests when the account or service cannot respond.
      pausedUntil = Date.now() + 30_000;
      item.reject(error);
    }).finally(() => { running--; drain(); });
  }
  notifyActivity();
}

function prioritize(id, priority = 1) {
  for (const item of queue) if (item.post.id === id) item.priority = priority;
  queue.sort((a, b) => b.priority - a.priority);
}

function classify(post, priority = false) {
  const generation = historyGeneration;
  const key = `${generation}:${post.id}:${post.fingerprint}`;
  if (inFlight.has(key)) {
    if (priority) prioritize(post.id);
    return inFlight.get(key);
  }
  const promise = new Promise((resolve, reject) => {
    queue.push({ post, resolve, reject, generation, priority: priority ? 1 : 0 });
    if (priority) prioritize(post.id);
    drain();
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function clearHistory() {
  if (clearingHistory) throw new Error("History is already being cleared.");
  clearingHistory = true;
  historyGeneration++;
  try {
    const result = await native({ type: "clear_history" });
    await notifyTabs({ type: "history_cleared" }).catch(() => {});
    notifyActivity(true);
    return result;
  } finally {
    clearingHistory = false;
    drain();
  }
}

async function signIn() {
  if (signingIn) throw new Error("Sign-in is already in progress.");
  signingIn = true;
  try {
    await native({ type: "sign_in" });
    const { welcomed } = await browser.storage.local.get("welcomed");
    if (!welcomed) await browser.storage.local.set({ firstSignInNotice: true, welcomed: true });
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
  // Older content scripts must keep receiving rejected promises, not error objects.
  const respond = value => message.protocol === 2 ? reply(value) : value;
  if (message.type === "settings" && (page || extensionPage)) return respond(settings());
  if (message.type === "classify" && page && message.post?.id && message.post?.fingerprint) return respond(classify(message.post, message.priority === true));
  if ((message.type === "prioritize" || message.type === "deprioritize") && page && /^\d{1,30}$/.test(message.id || "")) {
    prioritize(message.id, message.type === "prioritize" ? 1 : 0);
    return Promise.resolve({ ok: true });
  }
  if (!extensionPage) return;
  if (message.type === "retry_session") return respond(settings(true));
  if (message.type === "sign_in") return respond(signIn());
  if (message.type === "sign_out") return respond(native({ type: "sign_out" }).then(async result => {
    await browser.storage.local.remove(["firstSignInNotice", "showWelcome"]);
    await notifyTabs({ type: "refresh" });
    return result;
  }));
  if (message.type === "set_enabled") return respond(browser.storage.local.set({ enabled: !!message.enabled }).then(async () => {
    pausedUntil = 0;
    await notifyTabs({ type: "refresh" });
    return { ok: true };
  }));
  if (message.type === "dismiss_welcome") return respond(browser.storage.local.remove(["firstSignInNotice", "showWelcome"]).then(() => ({ ok: true })));
  if (message.type === "recent") return respond(native({ type: "recent", filter: message.filter || (message.hiddenOnly === false ? "all" : "hidden"), search: message.search || "", limit: message.limit || 100 }));
  if (message.type === "stats") return respond(native({ type: "stats" }).then(result => ({ ...result, checking: running, queued: queue.length })));
  if (message.type === "clear_history") return respond(clearHistory());
  if (message.type === "restore") return respond(native({ type: "restore", id: message.id }).then(async result => {
    await notifyTabs({ type: "restore", id: message.id });
    notifyActivity(true);
    return result;
  }));
});
