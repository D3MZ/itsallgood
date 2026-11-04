(() => {
  const BATCH_SIZE = 12;
  let remaining = BATCH_SIZE;
  let active = false;
  let phase = "checking";
  let scheduled = false;
  let refreshTimer;
  let settleTimer;
  let nextSettle = Infinity;
  const retryAfter = new Map();
  const articles = new Set();
  const revisions = new WeakMap();
  const unreadableSince = new WeakMap();
  const settleUntil = new WeakMap();
  const jobs = new WeakMap();
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && !document.hidden) processPost(entry.target);
    }
  }, { rootMargin: "700px 0px" });

  let currentPath = location.pathname;
  const absolute = value => {
    try { return new URL(value, location.origin).href; } catch { return null; }
  };

  function syncMode() {
    if (!document.documentElement) return;
    if (document.documentElement.dataset.iagMode !== phase) document.documentElement.dataset.iagMode = phase;
  }

  // Unlike innerText, this works while the post is invisible and preserves line breaks and emoji.
  function textOf(node) {
    let result = "";
    function visit(part) {
      if (part.nodeType === Node.TEXT_NODE) result += part.nodeValue;
      else if (part.nodeType === Node.ELEMENT_NODE) {
        if (part.tagName === "BR") result += "\n";
        else if (part.tagName === "IMG") result += part.getAttribute("alt") || "";
        else for (const child of part.childNodes) visit(child);
      }
    }
    if (node) visit(node);
    return result.trim();
  }

  syncMode();

  function postFrom(article) {
    const time = article.querySelector("time[datetime]");
    const status = time?.closest('a[href*="/status/"]');
    const href = status?.getAttribute("href") || "";
    const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    const isQuoted = node => {
      const container = node.closest('[role="link"]');
      return !!(container && article.contains(container) && container.querySelector('[data-testid="User-Name"]'));
    };
    const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const text = textNodes.filter(node => !isQuoted(node)).map(textOf).filter(Boolean).join("\n\n");
    const quotedText = textNodes.filter(isQuoted).map(textOf).filter(Boolean).join("\n\n");
    const photos = [...article.querySelectorAll('[data-testid="tweetPhoto"] img, [data-testid="videoPlayer"] img')]
      .map(img => ({ url: img.currentSrc || img.src, alt: img.alt || "", quoted: isQuoted(img) }));
    const posters = [...article.querySelectorAll('video[poster]')]
      .map(video => ({ url: video.poster, alt: "Video preview", quoted: isQuoted(video) }));
    const images = [...new Map([...photos, ...posters].filter(image => {
      try {
        const url = new URL(image.url);
        return url.protocol === "https:" && url.hostname === "pbs.twimg.com";
      } catch { return false; }
    }).map(image => [image.url, image])).values()];
    const urls = [...new Set([...article.querySelectorAll('a[href]')]
      .map(a => absolute(a.getAttribute("href")))
      .filter(url => url && /^https?:/.test(url)))].slice(0, 40);
    const metrics = {};
    for (const name of ["reply", "retweet", "unretweet", "like", "unlike", "bookmark", "removeBookmark"]) {
      const node = article.querySelector(`[data-testid="${name}"]`);
      if (node) metrics[name] = node.getAttribute("aria-label") || textOf(node) || "0";
    }
    const authors = [...article.querySelectorAll('[data-testid="User-Name"]')];
    const linkedPreviews = [...article.querySelectorAll('[data-testid="card.wrapper"]')]
      .map(textOf).filter(Boolean).map(text => text.slice(0, 2000)).slice(0, 4);
    const links = [...article.querySelectorAll('[data-testid="tweetText"] a[href], a[data-testid="card.wrapper"][href], [data-testid="card.wrapper"] a[href]')]
      .map(link => {
        try {
          const url = new URL(link.getAttribute("href"), location.origin);
          if (!/^https?:$/.test(url.protocol)) return null;
          if (["x.com", "twitter.com"].includes(url.hostname) && !url.pathname.includes("/status/")) return null;
          url.username = ""; url.password = ""; url.search = ""; url.hash = "";
          return { url: url.href, label: (link.title || textOf(link)).slice(0, 300) };
        } catch { return null; }
      }).filter(Boolean).slice(0, 12);
    const post = {
      id: match[2], url: `https://x.com/${match[1]}/status/${match[2]}`,
      handle: match[1], author: textOf(authors.find(node => !isQuoted(node))).slice(0, 500),
      text, quotedText,
      quotedAuthors: authors.filter(isQuoted).map(node => textOf(node).slice(0, 500)).slice(0, 4),
      linkedPreviews, links,
      postedAt: time.getAttribute("datetime"), discoveredAt: new Date().toISOString(),
      images: images.slice(0, 4), urls, metrics,
      context: textOf(article.querySelector('[data-testid="socialContext"]'))
    };
    // Version 3 applies the stricter effort policy and includes authorship evidence.
    // Engagement counts are excluded because they change independently of content.
    post.fingerprint = JSON.stringify([3, post.handle, post.author, post.text, post.quotedText, post.quotedAuthors, post.linkedPreviews, post.links, post.images, post.context]);
    return post;
  }

  async function processPost(article) {
    if (!active || document.hidden || !article.isConnected || article.dataset.iagBusy === "1") return;
    if (remaining <= 0) { article.dataset.iagState = "paused"; intersection.unobserve(article); return; }
    const post = postFrom(article);
    if (!post || (retryAfter.get(post.id) || 0) > Date.now()) return;
    if (!post.text && !post.quotedText && !post.images.length && !post.linkedPreviews.length && !post.links.length) {
      article.dataset.iagState = "error";
      intersection.unobserve(article);
      return;
    }
    article.dataset.iagId = post.id;
    article.dataset.iagBusy = "1";
    remaining--;
    const job = {};
    jobs.set(article, job);
    try {
      const result = await browser.runtime.sendMessage({ type: "classify", post });
      if (result.cached) { remaining = Math.min(BATCH_SIZE, remaining + 1); schedule(); }
      const current = postFrom(article);
      if (jobs.get(article) !== job || !article.isConnected || current?.id !== post.id || current.fingerprint !== post.fingerprint || !active) return;
      retryAfter.delete(post.id);
      article.dataset.iagState = result.hidden ? "hidden" : "kept";
      intersection.unobserve(article);
    } catch (error) {
      remaining = Math.min(BATCH_SIZE, remaining + 1);
      if (jobs.get(article) === job) {
        console.error("Its All Good: unable to classify", error.message);
        retryAfter.set(post.id, Date.now() + 30_000);
        article.dataset.iagState = "error";
        intersection.unobserve(article);
      }
    } finally {
      if (jobs.get(article) === job) {
        jobs.delete(article);
        delete article.dataset.iagBusy;
        if (!active || phase !== "active") {
          delete article.dataset.iagState;
          intersection.unobserve(article);
        }
      }
    }
  }

  function resetArticle(article) {
    intersection.unobserve(article);
    delete article.dataset.iagState;
    delete article.dataset.iagId;
    delete article.dataset.iagBusy;
    revisions.delete(article);
    unreadableSince.delete(article);
    settleUntil.delete(article);
    jobs.delete(article);
  }

  function resetFeed() {
    for (const article of articles) resetArticle(article);
    articles.clear();
  }

  function syncRoute() {
    if (currentPath !== location.pathname) { resetFeed(); remaining = BATCH_SIZE; currentPath = location.pathname; }
    syncMode();
  }

  function scan() {
    scheduled = false;
    syncRoute();
    if (phase === "off") { resetFeed(); return; }
    if (!active || phase !== "active") return;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      articles.add(article);
      const post = postFrom(article);
      if (!post) {
        if (!unreadableSince.has(article)) unreadableSince.set(article, Date.now());
        if (Date.now() - unreadableSince.get(article) > 15_000) article.dataset.iagState = "error";
        continue;
      }
      unreadableSince.delete(article);
      const revision = `${post.id}:${post.fingerprint}`;
      if (revisions.get(article) !== revision) {
        resetArticle(article);
        revisions.set(article, revision);
        settleUntil.set(article, Date.now() + 900);
      }
      article.dataset.iagId = post.id;
      if (!post.text && !post.quotedText && !post.images.length && !post.linkedPreviews.length && !post.links.length) {
        article.dataset.iagState = "error";
        intersection.unobserve(article);
        continue;
      }
      if (article.dataset.iagState === "error") {
        if ((retryAfter.get(post.id) || 0) > Date.now()) continue;
        delete article.dataset.iagState;
      }
      if (article.dataset.iagState === "paused" && remaining > 0) delete article.dataset.iagState;
      if (!article.dataset.iagState) article.dataset.iagState = "pending";
      if (article.dataset.iagState !== "pending" || article.dataset.iagBusy) continue;
      if (remaining <= 0) { article.dataset.iagState = "paused"; intersection.unobserve(article); continue; }
      if (document.hidden) { intersection.unobserve(article); continue; }
      const due = settleUntil.get(article) || 0;
      if (due > Date.now()) { scheduleSettling(due); continue; }
      intersection.observe(article);
    }
    for (const article of articles) {
      if (!article.isConnected) { resetArticle(article); articles.delete(article); }
    }
  }

  function schedule() {
    if (!scheduled) { scheduled = true; setTimeout(scan, 0); }
  }

  function scheduleSettling(due) {
    if (due >= nextSettle) return;
    clearTimeout(settleTimer);
    nextSettle = due;
    settleTimer = setTimeout(() => { nextSettle = Infinity; schedule(); }, Math.max(0, due - Date.now()));
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    phase = "checking";
    syncMode();
    if (document.hidden) return;
    try {
      const settings = await browser.runtime.sendMessage({ type: "settings" });
      const wasActive = active;
      active = !!(settings.enabled && settings.signedIn);
      if (active && !wasActive) remaining = BATCH_SIZE;
      phase = active ? "active" : "off";
    } catch (error) {
      active = false;
      phase = "error";
      console.error("Its All Good: settings unavailable", error.message);
      // A denied Keychain prompt should not reopen repeatedly without user action.
      if (!/keychain/i.test(error.message || String(error))) refreshTimer = setTimeout(refresh, 30_000);
    }
    syncMode();
    schedule();
  }

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "refresh") refresh();
    if (message?.type === "restore") {
      for (const article of articles) if (article.dataset.iagId === message.id) article.dataset.iagState = "kept";
    }
  });
  const observer = new MutationObserver(mutations => {
    syncRoute();
    if (active) {
      const changed = new Set();
      for (const mutation of mutations) {
        const node = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        const article = node?.closest('article[data-testid="tweet"]');
        if (article && (article.dataset.iagState === "kept" || article.dataset.iagState === "hidden")) changed.add(article);
      }
      for (const article of changed) {
        const post = postFrom(article);
        if (!post || revisions.get(article) !== `${post.id}:${post.fingerprint}`) resetArticle(article);
      }
    }
    schedule();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["href", "datetime", "src", "srcset", "poster"] });
  window.addEventListener("popstate", () => { syncRoute(); schedule(); });
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && phase === "checking") refresh();
    else schedule();
  });
  const continueOnScroll = event => {
    if (!event.isTrusted || !active) return;
    if (event.type === "keydown") {
      if (!["ArrowDown", "PageDown", "End", " "].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
    }
    remaining = BATCH_SIZE;
    schedule();
  };
  window.addEventListener("wheel", continueOnScroll, { passive: true });
  window.addEventListener("touchmove", continueOnScroll, { passive: true });
  window.addEventListener("keydown", continueOnScroll);
  setInterval(schedule, 2000);
  refresh();
})();
