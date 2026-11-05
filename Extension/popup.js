const $ = id => document.getElementById(id);
const filters = [["hidden-tab", "hidden"], ["visible-tab", "visible"], ["all-tab", "all"]];
let selectedFilter = "hidden";
let searchTerm = "";
let postLimit = 100;
let postRequest = 0;
let statsRequest = 0;
let activityVersion = 0;
let searchTimer;
let activityTimer;

function showError(error) {
  $("error").textContent = error?.message || String(error);
  $("error").hidden = false;
}
function clearError() { $("error").hidden = true; }
async function send(type, extra = {}) {
  const result = await browser.runtime.sendMessage({ type, protocol: 2, ...extra });
  if (!result || result.error) throw new Error(result?.error || "The extension did not respond.");
  return result;
}

async function loadSettings(retrySession = false) {
  const history = Promise.all([loadPosts(), loadStats()]);
  try {
    const state = await send(retrySession ? "retry_session" : "settings");
    $("signed-in").hidden = !state.signedIn;
    $("signed-out").hidden = state.signedIn;
    $("enabled").checked = state.enabled;
    $("enabled").disabled = !state.signedIn;
    if (state.signedIn) {
      $("account").textContent = state.email || "ChatGPT";
      $("account-email").textContent = state.email || "ChatGPT";
      $("model").textContent = `${state.model || "Luna"} · Low thinking`;
    }
    setWelcomeOpen(state.signedIn && state.showWelcome);
    clearError();
    $("retry-session").hidden = true;
    if (state.lastError) showError(state.lastError);
  } catch (error) {
    $("enabled").disabled = true;
    $("retry-session").hidden = false;
    showError(error);
  }
  await history;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function loadPosts() {
  const request = ++postRequest;
  const filter = selectedFilter;
  const search = searchTerm;
  try {
    const { posts, hasMore, counts } = await send("recent", { filter, search, limit: postLimit });
    if (request !== postRequest) return;
    for (const [, name] of filters) {
      const count = counts?.[name];
      if (Number.isSafeInteger(count) && count >= 0) $(`${name}-count`).textContent = count > 999 ? "999+" : String(count);
    }
    const list = $("posts");
    const contents = document.createDocumentFragment();
    if (!posts.length) {
      const empty = search ? "No matching posts." : ({ hidden: "No hidden posts yet.", visible: "No visible posts yet.", all: "No posts yet." })[filter];
      contents.append(element("p", "empty", empty));
    }
    for (const post of posts) {
      const item = element("article", "post");
      const head = element("div", "post-head");
      const link = element("a", "", `@${post.handle}`);
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      const date = element("span", "", post.postedAt ? new Date(post.postedAt).toLocaleDateString() : "");
      head.append(link, date);
      const text = element("p", "post-text", post.text || (post.imageCount ? "Image post" : "Post"));
      const reason = element("p", "reason", post.incomplete ? "Post text wasn’t captured." : post.reason);
      const actions = element("div", "post-actions");
      const state = post.restored ? "Restored" : post.hidden ? "Hidden" : "Visible";
      actions.append(element("span", "", state + (post.outdated ? " · Earlier filter" : "")));
      if (post.hidden && !post.restored) {
        const restore = element("button", "text-button", "Restore");
        restore.addEventListener("click", async () => {
          restore.disabled = true;
          try { await send("restore", { id: post.id }); await loadPosts(); }
          catch (error) { showError(error); restore.disabled = false; }
        });
        actions.append(restore);
      }
      item.append(head, text, reason, actions);
      contents.append(item);
    }
    if (hasMore) {
      const more = element("button", "text-button more", "Load more");
      more.addEventListener("click", () => { postLimit += 100; loadPosts(); });
      contents.append(more);
    }
    const scrollTop = list.scrollTop;
    list.replaceChildren(contents);
    list.scrollTop = scrollTop;
  } catch (error) { if (request === postRequest) showError(error); }
}

async function loadStats() {
  const request = ++statsRequest;
  const version = activityVersion;
  try {
    const stats = await send("stats");
    if (request !== statsRequest) return;
    $("processed-count").textContent = stats.processed;
    if (version === activityVersion) {
      $("checking-count").textContent = stats.checking;
      $("queue-count").textContent = stats.queued;
    }
  } catch (error) { if (request === statsRequest) showError(error); }
}

const accountDetails = document.querySelector(".account-details");
document.addEventListener("click", event => {
  if (!accountDetails.contains(event.target)) accountDetails.open = false;
});
accountDetails.addEventListener("focusout", event => {
  if (!accountDetails.contains(event.relatedTarget)) accountDetails.open = false;
});
accountDetails.addEventListener("keydown", event => {
  if (event.key === "Escape" && accountDetails.open) {
    event.preventDefault();
    accountDetails.open = false;
  }
});

$("retry-session").addEventListener("click", async () => {
  $("retry-session").disabled = true;
  try { await loadSettings(true); }
  finally { $("retry-session").disabled = false; }
});
$("enabled").addEventListener("change", async event => {
  clearError();
  try { await send("set_enabled", { enabled: event.target.checked }); }
  catch (error) { event.target.checked = !event.target.checked; showError(error); }
});
$("sign-in").addEventListener("click", async () => {
  clearError();
  $("sign-in").disabled = true;
  try { await send("sign_in"); await loadSettings(); }
  catch (error) { showError(error); }
  finally { $("sign-in").disabled = false; }
});
$("sign-out").addEventListener("click", async () => {
  clearError();
  try {
    const result = await send("sign_out");
    await loadSettings();
    if (result.warning) showError(result.warning);
  } catch (error) { showError(error); }
});
function setWelcomeOpen(open) {
  if ($("welcome").hidden === !open) return;
  $("welcome").hidden = !open;
  if (open) $("got-it").focus();
  else if (!$("signed-in").hidden) $("sign-out").focus();
}
async function dismissWelcome() {
  $("got-it").disabled = true;
  try { await send("dismiss_welcome"); setWelcomeOpen(false); }
  catch (error) { showError(error); }
  finally { $("got-it").disabled = false; }
}
$("got-it").addEventListener("click", dismissWelcome);
$("welcome").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); dismissWelcome(); }
  if (event.key !== "Tab") return;
  const first = $("welcome-usage");
  const last = $("got-it");
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function showClearConfirmation(show) {
  $("clear-confirmation").hidden = !show;
  $("clear-history").setAttribute("aria-expanded", String(show));
  $(show ? "cancel-clear" : "clear-history").focus();
}
$("clear-history").addEventListener("click", () => showClearConfirmation(true));
$("cancel-clear").addEventListener("click", () => showClearConfirmation(false));
$("confirm-clear").addEventListener("click", async () => {
  clearError();
  $("confirm-clear").disabled = true;
  $("cancel-clear").disabled = true;
  try {
    await send("clear_history");
    searchTerm = "";
    $("search").value = "";
    showClearConfirmation(false);
    selectFilter("all");
    await loadStats();
  } catch (error) { showError(error); }
  finally { $("confirm-clear").disabled = false; $("cancel-clear").disabled = false; }
});
function selectFilter(value) {
  selectedFilter = value;
  postLimit = 100;
  for (const [id, filter] of filters) {
    const selected = filter === value;
    $(id).classList.toggle("selected", selected);
    $(id).setAttribute("aria-selected", String(selected));
    $(id).tabIndex = selected ? 0 : -1;
    if (selected) $("posts").setAttribute("aria-labelledby", id);
  }
  $("posts").scrollTop = 0;
  clearTimeout(searchTimer);
  loadPosts();
}
for (const [id, value] of filters) $(id).addEventListener("click", () => selectFilter(value));
$("filters").addEventListener("keydown", event => {
  const index = filters.findIndex(([, value]) => value === selectedFilter);
  let next = index;
  if (event.key === "ArrowLeft") next = (index + filters.length - 1) % filters.length;
  else if (event.key === "ArrowRight") next = (index + 1) % filters.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = filters.length - 1;
  else return;
  event.preventDefault();
  selectFilter(filters[next][1]);
  $(filters[next][0]).focus();
});
$("search").addEventListener("input", event => {
  searchTerm = event.target.value.trim();
  postLimit = 100;
  postRequest++;
  $("posts").scrollTop = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadPosts, 200);
});
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "activity_changed" || (sender.id && sender.id !== browser.runtime.id)) return;
  activityVersion++;
  $("checking-count").textContent = message.checking;
  $("queue-count").textContent = message.queued;
  if (message.saved && !activityTimer) {
    activityTimer = setTimeout(() => {
      activityTimer = null;
      loadStats();
      loadPosts();
    }, 500);
  }
});
loadSettings();
