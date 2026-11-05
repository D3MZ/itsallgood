(() => {
  const BATCH_SIZE = 24;
  const MEMORY_LIMIT = 500;
  const EXPANSION_TIMEOUT = 30_000;
  const EXPANSION_SETTLE = 2_000;
  let remaining = BATCH_SIZE;
  let visibleRescues = 1;
  let active = false;
  let phase = "checking";
  let scheduled = false;
  let refreshTimer;
  let settleTimer;
  let nextSettle = Infinity;
  let historyRevision = 0;
  let waitingAfterClear = false;
  let applyTimer;
  const pendingChanges = [];
  const remembered = new Map();
  const restored = new Set();
  const retryAfter = new Map();
  const articles = new Set();
  const revisions = new WeakMap();
  const snapshots = new WeakMap();
  const expansions = new WeakMap();
  const unreadableSince = new WeakMap();
  const settleUntil = new WeakMap();
  const jobs = new WeakMap();
  const intersection = new IntersectionObserver(entries => {
    const distance = entry => {
      const rect = entry.boundingClientRect;
      return rect.bottom < 0 ? -rect.bottom : rect.top > innerHeight ? rect.top - innerHeight : 0;
    };
    for (const entry of entries.filter(entry => entry.isIntersecting).sort((a, b) => distance(a) - distance(b))) {
      if (!document.hidden) processPost(entry.target);
    }
  }, { rootMargin: "2400px 0px 3200px 0px" });
  const viewport = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (document.hidden || !active) continue;
      const article = entry.target;
      if (entry.isIntersecting && article.dataset.iagBusy !== "1" && !waitingAfterClear && remaining <= 0 && visibleRescues > 0) {
        remaining = BATCH_SIZE;
        visibleRescues--;
        schedule();
      }
      if (article.dataset.iagBusy === "1" && article.dataset.iagId) {
        browser.runtime.sendMessage({ type: entry.isIntersecting ? "prioritize" : "deprioritize", id: article.dataset.iagId }).catch(() => {});
      } else if (entry.isIntersecting) processPost(article);
    }
  });

  let currentPath = location.pathname;
  const absolute = value => {
    try { return new URL(value, location.origin).href; } catch { return null; }
  };
  async function send(type, extra = {}) {
    const result = await browser.runtime.sendMessage({ type, protocol: 2, ...extra });
    if (!result || result.error) throw new Error(result?.error || "The extension did not respond.");
    return result;
  }

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

  // X switches between thumbnail sizes for the same image as the page settles.
  function revisionOf(post) {
    const images = post.images.map(image => {
      const url = new URL(image.url);
      url.searchParams.delete("name");
      url.searchParams.delete("format");
      url.searchParams.sort();
      return [url.href, image.alt, image.quoted];
    });
    return JSON.stringify([post.id, post.handle, post.author, post.text, post.quotedText, post.quotedAuthors, post.linkedPreviews, post.links, images, post.context]);
  }

  function remember(post, revision, hidden) {
    remembered.delete(post.id);
    remembered.set(post.id, { revision, hidden });
    if (remembered.size > MEMORY_LIMIT) remembered.delete(remembered.keys().next().value);
  }

  // Apply nearby completions in the same frame rather than collapsing each row separately.
  function applyTogether(change) {
    return new Promise(resolve => {
      pendingChanges.push({ change, resolve });
      if (!applyTimer) applyTimer = setTimeout(() => {
        applyTimer = null;
        for (const item of pendingChanges.splice(0)) {
          try { item.change(); }
          catch (error) { console.error("Its All Good: unable to apply decision", error.message); }
          finally { item.resolve(); }
        }
      }, 150);
    });
  }

  async function processPost(article) {
    if (!active || document.hidden || !article.isConnected || article.dataset.iagBusy === "1") return;
    if (waitingAfterClear || remaining <= 0) {
      article.dataset.iagState = "paused";
      intersection.unobserve(article);
      if (waitingAfterClear) viewport.unobserve(article); else viewport.observe(article);
      return;
    }
    const snapshot = snapshots.get(article);
    const post = snapshot?.post || postFrom(article);
    if (!post || (retryAfter.get(post.id) || 0) > Date.now()) return;
    const revision = snapshot?.revision || revisionOf(post);
    const expectedHistory = historyRevision;
    if (!post.text && !post.quotedText && !post.images.length && !post.linkedPreviews.length && !post.links.length) {
      article.dataset.iagState = "error";
      intersection.unobserve(article);
      viewport.unobserve(article);
      return;
    }
    article.dataset.iagId = post.id;
    article.dataset.iagBusy = "1";
    remaining--;
    const job = {};
    jobs.set(article, job);
    try {
      const rect = article.getBoundingClientRect();
      const priority = rect.bottom > 0 && rect.top < innerHeight;
      const result = await send("classify", { post, priority });
      if (result.stale) {
        remaining = Math.min(BATCH_SIZE, remaining + 1);
        if (jobs.get(article) === job) { article.dataset.iagState = "pending"; schedule(); }
        return;
      }
      if (typeof result.hidden !== "boolean") throw new Error("Invalid filtering response.");
      if (result.cached) { remaining = Math.min(BATCH_SIZE, remaining + 1); schedule(); }
      await applyTogether(() => {
        const current = postFrom(article);
        if (jobs.get(article) !== job || !article.isConnected || !current || revisionOf(current) !== revision || !active) return;
        if (historyRevision !== expectedHistory) { schedule(); return; }
        retryAfter.delete(post.id);
        const hidden = restored.has(post.id) ? false : result.hidden;
        remember(post, revision, hidden);
        article.dataset.iagState = hidden ? "hidden" : "kept";
        intersection.unobserve(article);
        viewport.unobserve(article);
      });
    } catch (error) {
      remaining = Math.min(BATCH_SIZE, remaining + 1);
      if (jobs.get(article) === job) {
        console.error("Its All Good: unable to classify", error.message);
        retryAfter.set(post.id, Date.now() + 30_000);
        article.dataset.iagState = "error";
        intersection.unobserve(article);
        viewport.unobserve(article);
      }
    } finally {
      if (jobs.get(article) === job) {
        jobs.delete(article);
        delete article.dataset.iagBusy;
        if (!active || phase !== "active") {
          delete article.dataset.iagState;
          intersection.unobserve(article);
          viewport.unobserve(article);
        }
      }
    }
  }

  function forgetExpansion(article) {
    const expansion = expansions.get(article);
    if (!expansion) return;
    clearTimeout(expansion.timeout);
    clearTimeout(expansion.settleTimer);
    expansions.delete(article);
  }

  // Carry the visible decision over to the expanded revision of the same post.
  function preserveExpansion(article, post, revision) {
    const expansion = expansions.get(article);
    if (!expansion || article.dataset.iagState !== "kept" || post.id !== expansion.id || post.handle !== expansion.handle) return false;
    revisions.set(article, revision);
    snapshots.set(article, { post, revision });
    remember(post, revision, false);
    if (expansion.expanded || post.text !== expansion.text || post.quotedText !== expansion.quotedText) {
      expansion.expanded = true;
      clearTimeout(expansion.settleTimer);
      expansion.settleTimer = setTimeout(() => forgetExpansion(article), EXPANSION_SETTLE);
    }
    return true;
  }

  function resetArticle(article) {
    forgetExpansion(article);
    intersection.unobserve(article);
    viewport.unobserve(article);
    delete article.dataset.iagState;
    delete article.dataset.iagId;
    delete article.dataset.iagBusy;
    revisions.delete(article);
    snapshots.delete(article);
    unreadableSince.delete(article);
    settleUntil.delete(article);
    jobs.delete(article);
  }

  function resetFeed() {
    for (const article of articles) resetArticle(article);
    articles.clear();
  }

  function syncRoute() {
    const changed = currentPath !== location.pathname;
    if (changed) { resetFeed(); remaining = BATCH_SIZE; visibleRescues = 1; waitingAfterClear = false; currentPath = location.pathname; }
    syncMode();
    return changed;
  }

  function scan() {
    scheduled = false;
    syncRoute();
    if (phase === "off") { resetFeed(); remembered.clear(); return; }
    if (!active || phase !== "active") return;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      articles.add(article);
      if (article.dataset.iagState === "kept" || article.dataset.iagState === "hidden") continue;
      const post = postFrom(article);
      if (!post) {
        if (!unreadableSince.has(article)) unreadableSince.set(article, Date.now());
        if (Date.now() - unreadableSince.get(article) > 15_000) article.dataset.iagState = "error";
        continue;
      }
      unreadableSince.delete(article);
      const revision = revisionOf(post);
      if (revisions.get(article) !== revision) {
        resetArticle(article);
        revisions.set(article, revision);
        settleUntil.set(article, Date.now() + 400);
      }
      snapshots.set(article, { post, revision });
      if (article.dataset.iagId !== post.id) article.dataset.iagId = post.id;
      const cached = remembered.get(post.id);
      if (cached?.revision === revision) {
        const state = cached.hidden ? "hidden" : "kept";
        if (article.dataset.iagState !== state) article.dataset.iagState = state;
        intersection.unobserve(article);
        viewport.unobserve(article);
        continue;
      }
      if (!post.text && !post.quotedText && !post.images.length && !post.linkedPreviews.length && !post.links.length) {
        article.dataset.iagState = "error";
        intersection.unobserve(article);
        viewport.unobserve(article);
        continue;
      }
      if (article.dataset.iagState === "error") {
        if ((retryAfter.get(post.id) || 0) > Date.now()) continue;
        delete article.dataset.iagState;
      }
      if (waitingAfterClear && article.dataset.iagState !== "kept" && article.dataset.iagState !== "hidden") {
        article.dataset.iagState = "paused";
        intersection.unobserve(article);
        viewport.unobserve(article);
        continue;
      }
      if (article.dataset.iagState === "paused" && remaining > 0) delete article.dataset.iagState;
      if (!article.dataset.iagState) article.dataset.iagState = "pending";
      if (article.dataset.iagState !== "pending" || article.dataset.iagBusy) continue;
      if (remaining <= 0) { article.dataset.iagState = "paused"; intersection.unobserve(article); if (!document.hidden) viewport.observe(article); continue; }
      if (document.hidden) { intersection.unobserve(article); viewport.unobserve(article); continue; }
      const due = settleUntil.get(article) || 0;
      if (due > Date.now()) { scheduleSettling(due); continue; }
      intersection.observe(article);
      viewport.observe(article);
    }
    for (const article of articles) {
      if (!article.isConnected) { resetArticle(article); articles.delete(article); }
    }
  }

  function schedule() {
    if (!scheduled) { scheduled = true; setTimeout(scan, 40); }
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
      const settings = await send("settings");
      const wasActive = active;
      active = !!(settings.enabled && settings.signedIn);
      if (active && !wasActive) { remaining = BATCH_SIZE; visibleRescues = 1; waitingAfterClear = false; }
      phase = active ? "active" : "off";
    } catch (error) {
      active = false;
      phase = "error";
      console.error("Its All Good: settings unavailable", error.message);
      refreshTimer = setTimeout(refresh, 30_000);
    }
    syncMode();
    schedule();
  }

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === "refresh") refresh();
    if (message?.type === "restore") {
      restored.add(message.id);
      const cached = remembered.get(message.id);
      if (cached) cached.hidden = false;
      for (const article of articles) if (article.dataset.iagId === message.id) article.dataset.iagState = "kept";
    }
    if (message?.type === "history_cleared") { historyRevision++; waitingAfterClear = true; remembered.clear(); restored.clear(); schedule(); }
  });
  const observer = new MutationObserver(mutations => {
    let relevant = syncRoute();
    if (active) {
      const changed = new Set();
      for (const mutation of mutations) {
        const node = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        const article = node?.closest('article[data-testid="tweet"]');
        if (article) {
          relevant = true;
          snapshots.delete(article);
          if (article.dataset.iagState === "kept" || article.dataset.iagState === "hidden") changed.add(article);
        } else if (mutation.type === "childList") {
          for (const child of mutation.addedNodes) {
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const added = [...child.querySelectorAll('article[data-testid="tweet"]')];
            if (child.matches('article[data-testid="tweet"]')) added.push(child);
            for (const post of added) {
              relevant = true;
              snapshots.delete(post);
              if (post.dataset.iagState === "kept" || post.dataset.iagState === "hidden") changed.add(post);
            }
          }
          for (const child of mutation.removedNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && (child.matches('article[data-testid="tweet"]') || child.querySelector('article[data-testid="tweet"]'))) { relevant = true; break; }
          }
        }
      }
      // A recycled or edited post must be masked before the next paint.
      for (const article of changed) {
        const post = postFrom(article);
        const revision = post && revisionOf(post);
        if (!post || (revisions.get(article) !== revision && !preserveExpansion(article, post, revision))) resetArticle(article);
      }
    }
    if (relevant) schedule();
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["href", "datetime", "src", "srcset", "poster", "alt", "title", "role", "data-testid"] });
  // Expanding an already visible post should not hide it while its full text loads.
  window.addEventListener("click", event => {
    const control = event.target instanceof Element && event.target.closest('[data-testid="tweet-text-show-more-link"]');
    const article = control && control.closest('article[data-testid="tweet"]');
    if (!active || !article || article.dataset.iagState !== "kept") return;
    const post = postFrom(article);
    if (!post || post.id !== article.dataset.iagId) return;
    forgetExpansion(article);
    const expansion = { id: post.id, handle: post.handle, text: post.text, quotedText: post.quotedText };
    expansion.timeout = setTimeout(() => forgetExpansion(article), EXPANSION_TIMEOUT);
    expansions.set(article, expansion);
  }, true);
  window.addEventListener("popstate", () => { syncRoute(); schedule(); });
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && phase === "checking") refresh();
    else schedule();
  });
  const continueOnInteraction = event => {
    if (!event.isTrusted || !active) return;
    if (event.type === "keydown") {
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "."].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
    }
    if (event.type === "click" && !(event.target instanceof Element && event.target.closest('[data-testid="primaryColumn"]'))) return;
    if (event.type === "pointerdown" && event.clientX < document.documentElement.clientWidth - 20) return;
    remaining = BATCH_SIZE;
    visibleRescues = 1;
    waitingAfterClear = false;
    schedule();
  };
  window.addEventListener("wheel", continueOnInteraction, { passive: true });
  window.addEventListener("touchmove", continueOnInteraction, { passive: true });
  window.addEventListener("pointerdown", continueOnInteraction, { passive: true });
  window.addEventListener("click", continueOnInteraction, true);
  window.addEventListener("keydown", continueOnInteraction);
  setInterval(schedule, 5000);
  refresh();
})();
