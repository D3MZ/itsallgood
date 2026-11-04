(() => {
  let active = false;
  let observer;
  let scheduled = false;
  const retryAfter = new Map();
  const articles = new Set();
  const revisions = new WeakMap();
  const jobs = new WeakMap();
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) processPost(entry.target);
    }
  }, { rootMargin: "700px 0px" });

  const onFeed = () => location.pathname === "/home" || location.pathname === "/";
  const absolute = value => {
    try { return new URL(value, location.origin).href; } catch { return null; }
  };

  function postFrom(article) {
    const time = article.querySelector("time[datetime]");
    const status = time?.closest('a[href*="/status/"]');
    const href = status?.getAttribute("href") || "";
    const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const text = textNodes.map(node => node.innerText.trim()).filter(Boolean);
    const images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .map(img => ({ url: img.currentSrc || img.src, alt: img.alt || "" }))
      .filter(image => {
        try { return new URL(image.url).hostname === "pbs.twimg.com"; } catch { return false; }
      });
    const urls = [...new Set([...article.querySelectorAll('a[href]')]
      .map(a => absolute(a.getAttribute("href")))
      .filter(url => url && /^https?:/.test(url)))].slice(0, 40);
    const metrics = {};
    for (const name of ["reply", "retweet", "unretweet", "like", "unlike", "bookmark", "removeBookmark"]) {
      const node = article.querySelector(`[data-testid="${name}"]`);
      if (node) metrics[name] = node.getAttribute("aria-label") || node.innerText.trim() || "0";
    }
    const author = article.querySelector('[data-testid="User-Name"]');
    const post = {
      id: match[2], url: `https://x.com/${match[1]}/status/${match[2]}`,
      handle: match[1], author: author?.innerText.trim().slice(0, 500) || "",
      text: text[0] || "", quotedText: text.slice(1).join("\n\n"),
      postedAt: time.getAttribute("datetime"), discoveredAt: new Date().toISOString(),
      images: images.slice(0, 4), urls, metrics,
      context: article.querySelector('[data-testid="socialContext"]')?.innerText.trim() || ""
    };
    // The revision excludes engagement counts, which change independently of content.
    post.fingerprint = JSON.stringify([post.text, post.quotedText, post.images, post.context]);
    return post;
  }

  async function processPost(article) {
    if (!active || !onFeed() || !article.isConnected || article.dataset.iagBusy === "1") return;
    const post = postFrom(article);
    if (!post || (retryAfter.get(post.id) || 0) > Date.now()) {
      delete article.dataset.iagState;
      return;
    }
    article.dataset.iagId = post.id;
    article.dataset.iagBusy = "1";
    const job = {};
    jobs.set(article, job);
    try {
      const result = await browser.runtime.sendMessage({ type: "classify", post });
      const current = postFrom(article);
      if (!article.isConnected || current?.id !== post.id || current.fingerprint !== post.fingerprint || !active || !onFeed()) return;
      article.dataset.iagState = result.hidden ? "hidden" : "kept";
      intersection.unobserve(article);
    } catch (error) {
      console.error("Its All Good: unable to classify", error.message);
      retryAfter.set(post.id, Date.now() + 30_000);
      if (jobs.get(article) === job) {
        delete article.dataset.iagState;
        intersection.unobserve(article);
      }
    } finally {
      if (jobs.get(article) === job) {
        jobs.delete(article);
        delete article.dataset.iagBusy;
      }
    }
  }

  function scan() {
    scheduled = false;
    if (!active || !onFeed()) {
      for (const article of articles) {
        delete article.dataset.iagState;
        delete article.dataset.iagId;
        intersection.unobserve(article);
      }
      articles.clear();
      return;
    }
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const post = postFrom(article);
      if (!post) continue;
      const revision = `${post.id}:${post.fingerprint}`;
      if (revisions.get(article) !== revision) {
        intersection.unobserve(article);
        delete article.dataset.iagState;
        delete article.dataset.iagBusy;
        jobs.delete(article);
        revisions.set(article, revision);
      }
      article.dataset.iagId = post.id;
      articles.add(article);
      if (article.dataset.iagState) continue;
      if ((retryAfter.get(post.id) || 0) > Date.now()) continue;
      article.dataset.iagState = "pending";
      intersection.observe(article);
    }
    for (const article of articles) if (!article.isConnected) articles.delete(article);
  }

  function schedule() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(scan); }
  }

  async function refresh() {
    try {
      const settings = await browser.runtime.sendMessage({ type: "settings" });
      active = !!(settings.enabled && settings.signedIn);
    } catch (error) {
      active = false;
      console.error("Its All Good: settings unavailable", error.message);
    }
    schedule();
  }

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "refresh") refresh();
    if (message?.type === "restore") {
      for (const article of articles) if (article.dataset.iagId === message.id) article.dataset.iagState = "kept";
    }
  });
  observer = new MutationObserver(schedule);
  observer.observe(document, { subtree: true, childList: true });
  window.addEventListener("popstate", schedule);
  window.addEventListener("pageshow", refresh);
  setInterval(schedule, 2000);
  refresh();
})();
