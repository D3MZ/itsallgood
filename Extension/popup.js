const $ = id => document.getElementById(id);
let hiddenOnly = true;

function showError(error) {
  $("error").textContent = error?.message || String(error);
  $("error").hidden = false;
}
function clearError() { $("error").hidden = true; }
async function send(type, extra = {}) { return browser.runtime.sendMessage({ type, ...extra }); }

async function loadSettings() {
  try {
    const state = await send("settings");
    $("signed-in").hidden = !state.signedIn;
    $("signed-out").hidden = state.signedIn;
    $("enabled").checked = state.enabled;
    $("enabled").disabled = !state.signedIn;
    $("welcome").hidden = !(state.signedIn && state.showWelcome);
    if (state.signedIn) {
      $("account").textContent = state.email || "ChatGPT";
      $("model").textContent = `${state.model || "Luna"} · Low thinking`;
    }
    if (state.lastError) showError(state.lastError);
    await loadPosts();
  } catch (error) { showError(error); }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function loadPosts() {
  try {
    const { posts } = await send("recent", { hiddenOnly });
    const list = $("posts");
    list.replaceChildren();
    if (!posts.length) { list.append(element("p", "empty", hiddenOnly ? "No hidden posts yet." : "No posts yet.")); return; }
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
      const reason = element("p", "reason", post.reason);
      const actions = element("div", "post-actions");
      actions.append(element("span", "", post.restored ? "Restored" : post.hidden ? "Hidden" : "Kept"));
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
      list.append(item);
    }
  } catch (error) { showError(error); }
}

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
$("got-it").addEventListener("click", async () => {
  try { await send("dismiss_welcome"); $("welcome").hidden = true; }
  catch (error) { showError(error); }
});
for (const [id, value] of [["hidden-tab", true], ["all-tab", false]]) {
  $(id).addEventListener("click", () => {
    hiddenOnly = value;
    $("hidden-tab").classList.toggle("selected", value);
    $("all-tab").classList.toggle("selected", !value);
    loadPosts();
  });
}
loadSettings();
