(() => {
  "use strict";

  const AUTH_TOKEN_KEY = "bloom.auth.token";

  async function requestJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    }
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed");
    }
    return payload;
  }

  const auth = {
    _listeners: [],
    _currentUser: null,
    async setPersistence() {
      return Promise.resolve();
    },
    onAuthStateChanged(cb) {
      this._listeners.push(cb);
      const run = async () => {
        const user = await this._restoreSession();
        cb(user);
      };
      void run();
      return () => {
        this._listeners = this._listeners.filter((listener) => listener !== cb);
      };
    },
    get currentUser() {
      return this._currentUser;
    },
    async signInWithEmailAndPassword(email, password) {
      const payload = await requestJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      this._setSession(payload);
      return { user: this._currentUser };
    },
    async createUserWithEmailAndPassword(email, password, displayName = "") {
      const payload = await requestJson("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name: displayName, email, password }),
      });
      this._setSession(payload);
      return { user: this._currentUser };
    },
    async signOut() {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      try {
        if (token) {
          await requestJson("/api/auth/logout", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      } catch (error) {
        console.error(error);
      }
      localStorage.removeItem(AUTH_TOKEN_KEY);
      this._currentUser = null;
      this._notify();
    },
    _setSession(payload) {
      const token = payload?.token;
      if (token) {
        localStorage.setItem(AUTH_TOKEN_KEY, token);
      }
      if (payload?.user) {
        this._currentUser = {
          uid: payload.user.id,
          displayName: payload.user.name || "",
          email: payload.user.email || "",
          createdAt: payload.user.createdAt || Date.now(),
          async updateProfile({ displayName }) {
            if (!displayName) return;
            const token = localStorage.getItem(AUTH_TOKEN_KEY);
            const response = await requestJson("/api/me/profile", {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}` },
              body: JSON.stringify({ name: displayName, email: this.email }),
            });
            this.displayName = response.user.name;
            this.email = response.user.email;
          },
          async updateEmail(email) {
            const token = localStorage.getItem(AUTH_TOKEN_KEY);
            const response = await requestJson("/api/me/profile", {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}` },
              body: JSON.stringify({ name: this.displayName, email }),
            });
            this.email = response.user.email;
          },
        };
        this._notify();
      }
    },
    _notify() {
      this._listeners.forEach((listener) => listener(this._currentUser));
    },
    async _restoreSession() {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      if (!token) {
        this._currentUser = null;
        return null;
      }
      try {
        const payload = await requestJson("/api/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        this._setSession(payload);
        return this._currentUser;
      } catch (error) {
        console.error(error);
        localStorage.removeItem(AUTH_TOKEN_KEY);
        this._currentUser = null;
        return null;
      }
    },
  };

  const uid = () => Math.random().toString(36).slice(2, 10);

  function createDefaultSettings() {
    return {
      theme: "pink",
      mode: "dark",
      compact: false,
      offline: false,
      fontSize: "md",
      notifications: false,
      language: "en",
    };
  }

  function defaultCategories() {
    return ["Personal", "School", "Work", "Ideas"];
  }

  /* ---------- state ---------- */
  let notes = [];
  let reminders = [];
  let currentUser = null; // { uid, name, email, avatar, createdAt }
  let reminderFilter = "all";
  let calDate = new Date();
  let selectedDay = null;
  let notesView = "all";
  let notesCategoryFilter = "";
  let notesTagFilter = "";
  let notesSort = "newest";

  let categories = defaultCategories();
  let tags = [];
  let checklistDraft = [];
  let pendingNoteColor = "";
  let settings = createDefaultSettings();

  /* ---------- migrate/normalize note shape ---------- */
  function migrateNote(n) {
    return {
      id: n.id,
      html: n.html || "",
      pinned: !!n.pinned,
      favorite: !!n.favorite,
      archived: !!n.archived,
      deleted: !!n.deleted,
      deletedAt: n.deletedAt || null,
      color: n.color || "",
      category: n.category || "Personal",
      tags: Array.isArray(n.tags) ? n.tags : [],
      checklist: Array.isArray(n.checklist) ? n.checklist : [],
      created: n.created || Date.now(),
      updated: n.updated || n.created || Date.now(),
    };
  }

  /* ---------- sync ---------- */
  let syncTimer = null;
  let syncPollTimer = null;

  function scheduleSync() {
    if (!currentUser || !currentUser.uid) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const token = localStorage.getItem(AUTH_TOKEN_KEY);
        await requestJson("/api/me/data", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            notes,
            reminders,
            categories,
            tags,
            settings,
          }),
        });
      } catch (error) {
        console.error("Sync failed:", error);
      }
    }, 400);
  }

  function applyUserDoc(data) {
    notes = (data.notes || []).map(migrateNote);
    reminders = data.reminders || [];
    categories = data.categories && data.categories.length ? data.categories : defaultCategories();
    tags = data.tags || [];
    settings = { ...createDefaultSettings(), ...(data.settings || {}) };
    currentUser = {
      ...currentUser,
      name: data.name || currentUser?.name || "User",
      email: data.email || currentUser?.email || "",
      avatar: data.avatar || null,
      createdAt: data.createdAt || currentUser?.createdAt || Date.now(),
    };
    if (auth.currentUser) {
      auth.currentUser.displayName = currentUser.name;
      auth.currentUser.email = currentUser.email;
    }
  }

  function detachSnapshotListener() {
    if (syncPollTimer) {
      clearInterval(syncPollTimer);
      syncPollTimer = null;
    }
  }

  function attachSnapshotListener() {
    detachSnapshotListener();
    if (!currentUser || !currentUser.uid) return;
    syncPollTimer = setInterval(async () => {
      try {
        const token = localStorage.getItem(AUTH_TOKEN_KEY);
        const payload = await requestJson("/api/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const remoteData = payload.data || {};
        applyUserDoc({ ...remoteData, name: payload.user.name, email: payload.user.email, createdAt: payload.user.createdAt });
        renderAccount();
        renderAll();
        applySettings();
        applyLanguage();
      } catch (error) {
        console.error("Snapshot sync error:", error);
      }
    }, 10000);
  }

  async function loadUserData(fbUser) {
    currentUser = {
      uid: fbUser.uid,
      name: fbUser.displayName || (fbUser.email ? fbUser.email.split("@")[0] : "User"),
      email: fbUser.email || "",
      avatar: null,
      createdAt: null,
    };
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const payload = await requestJson("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      applyUserDoc({ ...(payload.data || {}), name: payload.user.name, email: payload.user.email, createdAt: payload.user.createdAt });
    } catch (error) {
      console.error("Failed to load user data:", error);
      toast("Couldn't load your data. Check your connection.");
    }
    attachSnapshotListener();
    renderAccount();
    renderAll();
    applySettings();
    applyLanguage();
  }

  function resetLocalState() {
    detachSnapshotListener();
    clearTimeout(syncTimer);
    currentUser = null;
    notes = [];
    reminders = [];
    categories = defaultCategories();
    tags = [];
    settings = createDefaultSettings();
  }

  function friendlyAuthError(error) {
    const map = {
      "auth/email-already-in-use": "That email already has an account. Try signing in instead.",
      "auth/invalid-email": "That email address looks invalid.",
      "auth/weak-password": "Password should be at least 6 characters.",
      "auth/user-not-found": "No account found with that email.",
      "auth/wrong-password": "Incorrect password.",
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/too-many-requests": "Too many attempts. Please wait and try again.",
      "auth/network-request-failed": "Network error. Check your connection.",
      "auth/requires-recent-login": "Please sign out and back in, then try that again.",
    };
    return (error && (map[error.code] || error.message)) || "Something went wrong. Please try again.";
  }

  function persistNotes() {
    notes = notes.map(migrateNote);
    scheduleSync();
  }
  function persistReminders() { scheduleSync(); }
  function persistCategories() { scheduleSync(); }
  function persistTags() { scheduleSync(); }
  function persistSettings() { scheduleSync(); }

  /* ---------- elements ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const splash = $("#splash");
  const landing = $("#landing");
  const app = $(".app");

  /* ---------- boot sequence ---------- */
  function boot() {
    applySettings();

    const authReady = new Promise((resolve) => {
      const unsubscribe = auth.onAuthStateChanged((fbUser) => {
        unsubscribe();
        resolve(fbUser);
      });
    });

    authReady
      .then(async (fbUser) => {
        if (fbUser) await loadUserData(fbUser);
        setTimeout(() => {
          splash.classList.add("hidden");
          if (fbUser) {
            enterApp();
          } else {
            landing.classList.add("visible");
          }
        }, 900);
      })
      .catch(() => {
        setTimeout(() => {
          splash.classList.add("hidden");
          landing.classList.add("visible");
        }, 900);
      });

    // Keep reacting to sign-in/sign-out that happens after the initial load
    // (e.g. via the auth modal), separate from the one-shot promise above.
    auth.onAuthStateChanged(async (fbUser) => {
      if (fbUser && (!currentUser || currentUser.uid !== fbUser.uid)) {
        await loadUserData(fbUser);
        closeAuth();
        enterApp();
      } else if (!fbUser && currentUser) {
        resetLocalState();
        app.classList.remove("visible");
        landing.classList.add("visible");
      }
    });
  }

  function enterApp() {
    landing.classList.remove("visible");
    app.classList.add("visible");
    applySettings();
    applyLanguage();
    renderAccount();
    renderAll();
    startReminderWatcher();
  }

  /* ---------- settings ---------- */
  function applySettings() {
    document.documentElement.setAttribute("data-theme", settings.theme);
    document.documentElement.setAttribute("data-mode", settings.mode);
    document.documentElement.setAttribute("data-fontsize", settings.fontSize);
    document.body.toggleAttribute("data-compact", settings.compact);
    document.body.setAttribute("data-compact", settings.compact ? "1" : "0");
    $("#toggle-dark").checked = settings.mode === "dark";
    $("#toggle-compact").checked = settings.compact;
    $("#toggle-offline").checked = settings.offline;
    $("#toggle-notifications").checked = settings.notifications;
    $("#language-select").value = settings.language;
    $$(".theme-swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === settings.theme));
    $$("#font-size-options .filter").forEach((b) => b.classList.toggle("active", b.dataset.font === settings.fontSize));
  }

  $$(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.theme = btn.dataset.theme;
      applySettings();
      persistSettings();
    });
  });
  $("#toggle-dark").addEventListener("change", (e) => {
    settings.mode = e.target.checked ? "dark" : "light";
    applySettings();
    persistSettings();
  });
  $("#toggle-compact").addEventListener("change", (e) => {
    settings.compact = e.target.checked;
    applySettings();
    persistSettings();
  });
  $("#toggle-offline").addEventListener("change", (e) => {
    settings.offline = e.target.checked;
    applySettings();
    persistSettings();
    toast(settings.offline ? "Offline mode enabled" : "Offline mode disabled");
  });

  $$("#font-size-options .filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.fontSize = btn.dataset.font;
      applySettings();
      persistSettings();
    });
  });

  $("#toggle-notifications").addEventListener("change", async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    settings.notifications = e.target.checked;
    applySettings();
    persistSettings();
    toast(settings.notifications ? "Reminder notifications on" : "Reminder notifications off");
  });

  const uiStrings = {
    en: { dashboard: "Dashboard", notes: "Notes", reminders: "Reminders", calendar: "Calendar", focus: "Focus", favorites: "Favorites", trash: "Trash", addNote: "Add Note" },
    es: { dashboard: "Panel", notes: "Notas", reminders: "Recordatorios", calendar: "Calendario", focus: "Enfoque", favorites: "Favoritos", trash: "Papelera", addNote: "Añadir Nota" },
    fr: { dashboard: "Tableau de bord", notes: "Notes", reminders: "Rappels", calendar: "Calendrier", focus: "Concentration", favorites: "Favoris", trash: "Corbeille", addNote: "Ajouter Note" },
  };
  function applyLanguage() {
    const dict = uiStrings[settings.language] || uiStrings.en;
    $$(".nav-item").forEach((btn) => {
      const label = btn.querySelector("span:nth-child(2)");
      const key = btn.dataset.tab;
      if (label && dict[key]) label.textContent = dict[key];
    });
    const addNoteLabel = $("#add-note-btn span");
    if (addNoteLabel && dict.addNote) addNoteLabel.textContent = dict.addNote;
  }
  $("#language-select").addEventListener("change", (e) => {
    settings.language = e.target.value;
    applySettings();
    applyLanguage();
    persistSettings();
    toast("Language updated");
  });

  /* ---------- confirm dialog ---------- */
  const confirmOverlay = $("#confirm-overlay");
  let confirmResolver = null;
  function askConfirm(message, okLabel) {
    return new Promise((resolve) => {
      $("#confirm-message").textContent = message;
      $("#confirm-ok").textContent = okLabel || "Confirm";
      confirmResolver = resolve;
      confirmOverlay.classList.add("visible");
    });
  }
  function closeConfirm(result) {
    confirmOverlay.classList.remove("visible");
    if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
  }
  $("#confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => closeConfirm(false));
  confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay) closeConfirm(false); });

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 2200);
  }

  /* ---------- clock ---------- */
  function tickClock() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const date = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    $("#clock").textContent = time;
    $("#date").textContent = date;
    $("#topbar-clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 1000 * 15);

  /* ---------- landing actions ---------- */
  $("#landing-get-started").addEventListener("click", () => openAuth("signup"));
  $("#landing-signup").addEventListener("click", () => openAuth("signup"));
  $("#landing-login").addEventListener("click", () => openAuth("signin"));
  $("#open-signin").addEventListener("click", () => openAuth("signin"));
  $("#open-signup").addEventListener("click", () => openAuth("signup"));

  /* ---------- auth modal ---------- */
  const authOverlay = $("#auth-overlay");

  const authQuotes = [
    { text: "Small notes today become the big ideas of tomorrow.", author: "Bloom Notes" },
    { text: "A calm mind writes the clearest thoughts.", author: "Bloom Notes" },
    { text: "Capture it now, thank yourself later.", author: "Bloom Notes" },
  ];
  let authQuoteIndex = 0;
  let authQuoteTimer = null;

  function renderAuthQuote(i) {
    const textEl = document.querySelector(".auth-visual-quote-text");
    const authorEl = document.querySelector(".auth-visual-quote-author");
    const dots = $$("#auth-visual-dots span");
    if (!textEl) return;
    textEl.classList.add("auth-quote-fade");
    setTimeout(() => {
      textEl.textContent = authQuotes[i].text;
      authorEl.textContent = `— ${authQuotes[i].author}`;
      dots.forEach((d, di) => d.classList.toggle("active", di === i));
      textEl.classList.remove("auth-quote-fade");
    }, 250);
  }

  function startAuthQuotes() {
    authQuoteIndex = 0;
    renderAuthQuote(authQuoteIndex);
    clearInterval(authQuoteTimer);
    authQuoteTimer = setInterval(() => {
      authQuoteIndex = (authQuoteIndex + 1) % authQuotes.length;
      renderAuthQuote(authQuoteIndex);
    }, 4500);
  }
  function stopAuthQuotes() { clearInterval(authQuoteTimer); }

  function openAuth(tab) {
    authOverlay.classList.add("visible");
    switchAuthTab(tab);
    startAuthQuotes();
  }
  function closeAuth() { authOverlay.classList.remove("visible"); stopAuthQuotes(); }
  $("#auth-close").addEventListener("click", closeAuth);
  authOverlay.addEventListener("click", (e) => { if (e.target === authOverlay) closeAuth(); });

  function switchAuthTab(tab) {
    $$(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.authTab === tab));
    $("#signin-form").hidden = tab !== "signin";
    $("#signup-form").hidden = tab !== "signup";
    $("#signin-error").textContent = "";
    $("#signup-error").textContent = "";
  }
  $$(".auth-tab").forEach((t) => t.addEventListener("click", () => switchAuthTab(t.dataset.authTab)));

  const socialLabels = { "social-google": "Google", "social-facebook": "Facebook", "social-apple": "Apple" };
  Object.keys(socialLabels).forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener("click", () => {
        toast(`${socialLabels[id]} sign-up isn't available in this demo yet`);
      });
    }
  });

  $$(".auth-password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.pwToggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
    });
  });

  $("#signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#signin-email").value.trim();
    const password = $("#signin-password").value;
    $("#signin-error").textContent = "";
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.classList.add("btn-loading");
    try {
      await auth.signInWithEmailAndPassword(email, password);
      // auth.onAuthStateChanged (in boot()) loads the user's Firestore
      // data and calls enterApp() once it's ready.
    } catch (error) {
      $("#signin-error").textContent = friendlyAuthError(error);
    } finally {
      submitBtn.classList.remove("btn-loading");
    }
  });

  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#signup-name").value.trim();
    const email = $("#signup-email").value.trim();
    const pw = $("#signup-password").value;
    const confirm = $("#signup-confirm").value;
    if (pw !== confirm) {
      $("#signup-error").textContent = "Passwords don't match.";
      return;
    }
    $("#signup-error").textContent = "";
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.classList.add("btn-loading");
    try {
      await auth.createUserWithEmailAndPassword(email, pw, name);
      // auth.onAuthStateChanged (in boot()) picks this new session up
      // and loads the backed-up data for the new account.
    } catch (error) {
      $("#signup-error").textContent = friendlyAuthError(error);
    } finally {
      submitBtn.classList.remove("btn-loading");
    }
  });

  function renderAccount() {
    const signedOut = $("#topbar-signed-out");
    const signedIn = $("#topbar-signed-in");
    if (currentUser) {
      signedOut.hidden = true;
      signedIn.hidden = false;
      $("#account-signout").hidden = false;
      $("#account-name").textContent = currentUser.name;
      $("#account-email").textContent = currentUser.email;
      renderAvatarInto($("#account-avatar"), currentUser);
    } else {
      signedOut.hidden = false;
      signedIn.hidden = true;
      $("#account-signout").hidden = true;
    }
  }

  function renderAvatarInto(el, user) {
    if (user && user.avatar) {
      el.innerHTML = `<img src="${user.avatar}" alt="${escapeHtml(user.name || "")}" />`;
    } else {
      el.textContent = user && user.name ? user.name.charAt(0).toUpperCase() : "B";
    }
  }

  /* ---------- profile modal ---------- */
  const profileOverlay = $("#profile-overlay");
  function openProfile() {
    if (!currentUser) return;
    $("#profile-name").value = currentUser.name || "";
    $("#profile-email").value = currentUser.email || "";
    renderAvatarInto($("#profile-avatar-preview"), currentUser);
    $("#profile-stat-notes").textContent = notes.filter((n) => !n.deleted).length;
    $("#profile-stat-since").textContent = currentUser.createdAt
      ? new Date(currentUser.createdAt).toLocaleDateString([], { month: "long", year: "numeric" })
      : "—";
    profileOverlay.classList.add("visible");
  }
  function closeProfile() { profileOverlay.classList.remove("visible"); }
  $("#open-profile").addEventListener("click", openProfile);
  $("#profile-close").addEventListener("click", closeProfile);
  profileOverlay.addEventListener("click", (e) => { if (e.target === profileOverlay) closeProfile(); });

  $("#profile-avatar-upload-btn").addEventListener("click", () => $("#profile-avatar-input").click());
  $("#profile-avatar-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file || !currentUser) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Downscale to a small square so the avatar stays well under
        // Firestore's per-document size limit.
        const size = 128;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        currentUser.avatar = dataUrl;
        renderAvatarInto($("#profile-avatar-preview"), currentUser);
        scheduleSync();
      };
      img.onerror = () => toast("Couldn't read that image");
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  $("#profile-avatar-remove-btn").addEventListener("click", () => {
    if (!currentUser) return;
    currentUser.avatar = null;
    renderAvatarInto($("#profile-avatar-preview"), currentUser);
    scheduleSync();
  });

  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) return;
    const name = $("#profile-name").value.trim();
    const email = $("#profile-email").value.trim();
    if (!name || !email) return;
    const submitBtn = e.target.querySelector(".auth-submit");
    if (submitBtn) submitBtn.classList.add("btn-loading");
    try {
      const fbUser = auth.currentUser;
      if (fbUser && name !== currentUser.name) {
        await fbUser.updateProfile({ displayName: name });
      }
      if (fbUser && email !== currentUser.email) {
        await fbUser.updateEmail(email);
      }
      currentUser.name = name;
      currentUser.email = email;
      if (auth.currentUser) {
        auth.currentUser.displayName = name;
        auth.currentUser.email = email;
      }
      scheduleSync();
      renderAccount();
      closeProfile();
      toast("Profile updated");
    } catch (error) {
      toast(friendlyAuthError(error));
    } finally {
      if (submitBtn) submitBtn.classList.remove("btn-loading");
    }
  });

  $("#account-signout").addEventListener("click", async () => {
    try {
      await auth.signOut();
      // auth.onAuthStateChanged (in boot()) clears local state and
      // shows the landing page.
      toast("Signed out");
    } catch (error) {
      console.error(error);
      toast("Couldn't sign out. Try again.");
    }
  });

  /* ---------- tab navigation ---------- */
  const tabTitles = {
    dashboard: ["Dashboard", "Your Bloom activity at a glance."],
    notes: ["Notes", "Capture ideas before they fade."],
    reminders: ["Reminders", "Never lose track of what matters."],
    calendar: ["Calendar", "See everything on the days it happens."],
    focus: ["Focus", "One task at a time."],
    favorites: ["Favorites", "Your starred notes, all in one place."],
    trash: ["Trash", "Restore a note or clear it for good."],
  };

  function goTab(tab) {
    $$(".nav-item").forEach((n) => {
      const active = n.dataset.tab === tab;
      n.classList.toggle("active", active);
      n.setAttribute("aria-selected", active);
    });
    $$(".tab-panel").forEach((p) => { p.hidden = p.id !== `panel-${tab}`; });
    const [title, sub] = tabTitles[tab];
    $("#page-title").textContent = title;
    $("#page-subtitle").textContent = sub;
    if (tab === "calendar") renderCalendar();
    if (tab === "dashboard") renderDashboard();
    if (tab === "favorites") renderFavorites();
    if (tab === "trash") renderTrash();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => goTab(btn.dataset.tab)));
  $$("[data-jump]").forEach((btn) => btn.addEventListener("click", () => { goTab(btn.dataset.jump); closeDrawer(); }));
  $$("[data-jump-tab]").forEach((btn) => btn.addEventListener("click", () => goTab(btn.dataset.jumpTab)));

  /* ---------- options drawer ---------- */
  const drawer = $("#options-drawer");
  const drawerOverlay = $("#drawer-overlay");
  function openDrawer() {
    drawer.classList.add("visible");
    drawerOverlay.classList.add("visible");
    $("#burger-btn").setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    drawer.classList.remove("visible");
    drawerOverlay.classList.remove("visible");
    $("#burger-btn").setAttribute("aria-expanded", "false");
  }
  $("#burger-btn").addEventListener("click", openDrawer);
  $("#drawer-close").addEventListener("click", closeDrawer);
  drawerOverlay.addEventListener("click", closeDrawer);

  $("#drawer-export").addEventListener("click", () => {
    const data = { notes, reminders };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bloom-export.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("Data exported");
  });

  $("#drawer-reset").addEventListener("click", async () => {
    const ok = await askConfirm("Reset all notes and reminders? This can't be undone.", "Reset everything");
    if (!ok) return;
    notes = [];
    reminders = [];
    persistNotes();
    persistReminders();
    renderAll();
    toast("Everything reset");
  });

  /* ---------- categories & tags ---------- */
  function renderCategoryOptions() {
    const composerSelect = $("#note-category-select");
    const filterSelect = $("#notes-category-filter");
    const composerCurrent = composerSelect.value;
    const filterCurrent = filterSelect.value;
    composerSelect.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    filterSelect.innerHTML = `<option value="">All categories</option>` + categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (categories.includes(composerCurrent)) composerSelect.value = composerCurrent;
    if (categories.includes(filterCurrent)) filterSelect.value = filterCurrent;
  }

  function renderTagOptions() {
    const filterSelect = $("#notes-tag-filter");
    const current = filterSelect.value;
    filterSelect.innerHTML = `<option value="">All tags</option>` + tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
    if (tags.includes(current)) filterSelect.value = current;
  }

  $("#note-category-add-btn").addEventListener("click", () => {
    const name = prompt("New category name:");
    if (!name || !name.trim()) return;
    const clean = name.trim();
    if (!categories.includes(clean)) {
      categories.push(clean);
      persistCategories();
      renderCategoryOptions();
    }
    $("#note-category-select").value = clean;
    toast(`Category "${clean}" added`);
  });

  $("#notes-category-filter").addEventListener("change", (e) => { notesCategoryFilter = e.target.value; renderNotes(); });
  $("#notes-tag-filter").addEventListener("change", (e) => { notesTagFilter = e.target.value; renderNotes(); });
  $("#notes-sort").addEventListener("change", (e) => { notesSort = e.target.value; renderNotes(); });

  $$("#notes-view-filters .filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      notesView = btn.dataset.view;
      $$("#notes-view-filters .filter").forEach((f) => f.classList.toggle("active", f === btn));
      renderNotes();
    });
  });

  /* ---------- composer: color picker ---------- */
  $$("#note-color-picker .color-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      pendingNoteColor = dot.dataset.color;
      $$("#note-color-picker .color-dot").forEach((d) => d.classList.toggle("active", d === dot));
    });
  });

  /* ---------- composer: tags ---------- */
  let pendingNoteTags = [];
  function renderPendingTags() {
    $("#note-tags-preview").innerHTML = pendingNoteTags
      .map((t) => `<span class="tag-chip">${escapeHtml(t)}<button type="button" data-tag="${escapeHtml(t)}" aria-label="Remove tag">×</button></span>`)
      .join("");
    $$("#note-tags-preview button").forEach((btn) => {
      btn.addEventListener("click", () => {
        pendingNoteTags = pendingNoteTags.filter((t) => t !== btn.dataset.tag);
        renderPendingTags();
      });
    });
  }
  $("#note-tags-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,$/, "");
      if (val && !pendingNoteTags.includes(val)) {
        pendingNoteTags.push(val);
        if (!tags.includes(val)) { tags.push(val); persistTags(); renderTagOptions(); }
        renderPendingTags();
      }
      e.target.value = "";
    }
  });

  /* ---------- composer: checklist builder ---------- */
  $("#note-checklist-toggle").addEventListener("click", (e) => {
    const builder = $("#checklist-builder");
    builder.hidden = !builder.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!builder.hidden));
  });

  function renderChecklistBuilder() {
    const wrap = $("#checklist-builder-list");
    wrap.innerHTML = "";
    checklistDraft.forEach((item) => {
      const row = document.createElement("div");
      row.className = "checklist-builder-row";
      row.innerHTML = `<span>${escapeHtml(item.text)}</span><button type="button" data-id="${item.id}" aria-label="Remove task">×</button>`;
      row.querySelector("button").addEventListener("click", () => {
        checklistDraft = checklistDraft.filter((i) => i.id !== item.id);
        renderChecklistBuilder();
      });
      wrap.appendChild(row);
      (item.children || []).forEach((child) => {
        const subRow = document.createElement("div");
        subRow.className = "checklist-builder-row";
        subRow.style.paddingLeft = "18px";
        subRow.innerHTML = `<span>↳ ${escapeHtml(child.text)}</span><button type="button" aria-label="Remove subtask">×</button>`;
        subRow.querySelector("button").addEventListener("click", () => {
          item.children = item.children.filter((c) => c.id !== child.id);
          renderChecklistBuilder();
        });
        wrap.appendChild(subRow);
      });
    });
  }
  $("#checklist-task-add-btn").addEventListener("click", () => {
    const input = $("#checklist-task-input");
    const val = input.value.trim();
    if (!val) return;
    checklistDraft.push({ id: uid(), text: val, done: false, children: [] });
    input.value = "";
    renderChecklistBuilder();
  });
  $("#checklist-task-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#checklist-task-add-btn").click(); }
  });

  /* ---------- notes ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    if (document.queryCommandSupported && document.queryCommandSupported("styleWithCSS")) {
      document.execCommand("styleWithCSS", false, true);
    }
  });

  let editorSelectionRange = null;
  $$(".toolbar-btn").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const editor = $("#note-input");
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const container = range.commonAncestorContainer;
        if (editor.contains(container)) {
          editorSelectionRange = range.cloneRange();
          return;
        }
      }
      editorSelectionRange = null;
    });

    btn.addEventListener("click", () => {
      const editor = $("#note-input");
      editor.focus();
      const sel = window.getSelection();
      if (editorSelectionRange && sel) {
        sel.removeAllRanges();
        sel.addRange(editorSelectionRange);
      }
      const cmd = btn.dataset.cmd;
      const executeCommand = () => {
        if (cmd === "createLink") {
          const url = prompt("Link URL:");
          if (!url) return; // user cancelled — don't insert an empty link
          document.execCommand("createLink", false, url);
          updateToolbarState();
          return;
        }
        const value = btn.dataset.value || undefined;
        const execValue = cmd === "formatBlock" && value ? `<${value.toLowerCase()}>` : value;
        document.execCommand(cmd, false, execValue);
        updateToolbarState();
      };
      setTimeout(executeCommand, 0);
    });
  });

  function updateToolbarState() {
    const editor = $("#note-input");
    const sel = window.getSelection();
    const selectionInEditor = !!(
      sel && sel.anchorNode && editor.contains(
        sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode
      )
    );
    $$(".toolbar-btn").forEach((btn) => {
      if (!selectionInEditor) { btn.classList.remove("active"); return; }
      const cmd = btn.dataset.cmd;
      let isActive = false;
      try {
        if (cmd === "formatBlock") {
          const val = document.queryCommandValue("formatBlock") || "";
          isActive = val.toLowerCase() === (btn.dataset.value || "").toLowerCase();
        } else if (cmd === "createLink") {
          const node = sel.anchorNode;
          const el = node && (node.nodeType === 1 ? node : node.parentElement);
          isActive = !!(el && el.closest && el.closest("a"));
        } else {
          isActive = document.queryCommandState(cmd);
        }
      } catch {
        isActive = false;
      }
      btn.classList.toggle("active", isActive);
    });
  }

  const noteInput = $("#note-input");
  noteInput.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") addNote();
  });
  noteInput.addEventListener("paste", (e) => {
    const clipboard = e.clipboardData || window.clipboardData;
    const text = clipboard ? clipboard.getData("text/plain") : null;
    if (text) {
      e.preventDefault();
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      document.execCommand("insertHTML", false, escaped);
    }
  });
  noteInput.addEventListener("keyup", updateToolbarState);
  noteInput.addEventListener("mouseup", updateToolbarState);
  noteInput.addEventListener("input", updateToolbarState);
  noteInput.addEventListener("focus", updateToolbarState);
  noteInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== noteInput) updateToolbarState();
    }, 0);
  });
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === noteInput) updateToolbarState();
  });
  $("#add-note-btn").addEventListener("click", addNote);

  function resetComposerExtras() {
    pendingNoteColor = "";
    pendingNoteTags = [];
    checklistDraft = [];
    $$("#note-color-picker .color-dot").forEach((d) => d.classList.toggle("active", d.dataset.color === ""));
    renderPendingTags();
    renderChecklistBuilder();
    $("#checklist-builder").hidden = true;
    $("#note-checklist-toggle").setAttribute("aria-expanded", "false");
    $("#note-category-select").value = "Personal";
    $$(".toolbar-btn").forEach((b) => b.classList.remove("active"));
  }

  function addNote() {
    if (!currentUser) return;
    const rawHtml = noteInput.innerHTML.trim();
    const html = normalizeNoteHtml(rawHtml);
    const text = noteInput.textContent.trim();
    const hasChecklist = checklistDraft.length > 0;
    if (!text && !hasChecklist) return; // need at least a note or a checklist
    const btn = $("#add-note-btn");
    btn.classList.add("btn-loading");
    setTimeout(() => {
      const now = Date.now();
      notes.unshift({
        id: uid(),
        html,
        pinned: false,
        favorite: false,
        archived: false,
        deleted: false,
        deletedAt: null,
        color: pendingNoteColor,
        category: $("#note-category-select").value || "Personal",
        tags: [...pendingNoteTags],
        checklist: checklistDraft.map((i) => ({ ...i, children: [...(i.children || [])] })),
        created: now,
        updated: now,
      });
      noteInput.innerHTML = "";
      resetComposerExtras();

      // Clear search and reset view filters so the newly created note displays instantly
      $("#note-search").value = "";
      notesView = "all";
      notesCategoryFilter = "";
      notesTagFilter = "";
      if ($("#notes-category-filter")) $("#notes-category-filter").value = "";
      if ($("#notes-tag-filter")) $("#notes-tag-filter").value = "";
      $$("#notes-view-filters .filter").forEach((f) => f.classList.toggle("active", f.dataset.view === "all"));

      persistNotes();
      renderNotes();
      renderDashboard();
      btn.classList.remove("btn-loading");
      if (text && hasChecklist) toast("Note & checklist added");
      else if (hasChecklist) toast("Checklist added");
      else toast("Note added");
    }, 250);
  }

  $("#note-search").addEventListener("input", renderNotes);

  $("#clear-notes-btn").addEventListener("click", async () => {
    const active = notes.filter((n) => !n.deleted);
    if (!active.length) return;
    const ok = await askConfirm("Move all your notes to Trash?", "Move to Trash");
    if (!ok) return;
    notes.forEach((n) => { if (!n.deleted) { n.deleted = true; n.deletedAt = Date.now(); } });
    persistNotes();
    renderAll();
    toast("All notes moved to Trash");
  });

  $("#empty-trash-btn").addEventListener("click", async () => {
    const trashed = notes.filter((n) => n.deleted);
    if (!trashed.length) return;
    const ok = await askConfirm("Permanently delete all notes in Trash? This can't be undone.", "Delete forever");
    if (!ok) return;
    notes = notes.filter((n) => !n.deleted);
    persistNotes();
    renderAll();
    toast("Trash emptied");
  });

  function matchesNotesFilters(n) {
    const q = $("#note-search").value.trim().toLowerCase();
    if (q) {
      const haystack = (stripHtml(n.html) + " " + n.tags.join(" ") + " " + n.category).toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (notesCategoryFilter && n.category !== notesCategoryFilter) return false;
    if (notesTagFilter && !n.tags.includes(notesTagFilter)) return false;
    if (notesView === "pinned" && !n.pinned) return false;
    if (notesView === "favorites" && !n.favorite) return false;
    if (notesView === "archived") return n.archived && !n.deleted;
    return !n.archived && !n.deleted;
  }

  function sortNotes(list) {
    const arr = [...list];
    if (notesSort === "newest") arr.sort((a, b) => (b.pinned - a.pinned) || (b.created - a.created));
    else if (notesSort === "oldest") arr.sort((a, b) => (b.pinned - a.pinned) || (a.created - b.created));
    else if (notesSort === "az") arr.sort((a, b) => (b.pinned - a.pinned) || stripHtml(a.html).localeCompare(stripHtml(b.html)));
    else if (notesSort === "edited") arr.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    return arr;
  }

  function renderNotes() {
    const grid = $("#notes-grid");
    const filtered = notes.filter(matchesNotesFilters);
    grid.querySelectorAll(".note-card").forEach((el) => el.remove());

    const emptyEl = $("#notes-empty");
    if (emptyEl) {
      emptyEl.hidden = filtered.length > 0;
      emptyEl.style.display = filtered.length > 0 ? "none" : "";
    }

    sortNotes(filtered).forEach((note) => grid.appendChild(renderNoteCard(note)));
    $("#notes-count").textContent = notes.filter((n) => !n.archived && !n.deleted).length;
    $("#favorites-count").textContent = notes.filter((n) => n.favorite && !n.deleted).length;
    $("#trash-count").textContent = notes.filter((n) => n.deleted).length;
  }

  function renderFavorites() {
    const grid = $("#favorites-grid");
    grid.querySelectorAll(".note-card").forEach((el) => el.remove());
    const favs = sortNotes(notes.filter((n) => n.favorite && !n.deleted));

    const emptyEl = $("#favorites-empty");
    if (emptyEl) {
      emptyEl.hidden = favs.length > 0;
      emptyEl.style.display = favs.length > 0 ? "none" : "";
    }

    favs.forEach((note) => grid.appendChild(renderNoteCard(note)));
  }

  function renderTrash() {
    const grid = $("#trash-grid");
    grid.querySelectorAll(".note-card").forEach((el) => el.remove());
    const trashed = notes.filter((n) => n.deleted).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));

    const emptyEl = $("#trash-empty");
    if (emptyEl) {
      emptyEl.hidden = trashed.length > 0;
      emptyEl.style.display = trashed.length > 0 ? "none" : "";
    }

    trashed.forEach((note) => grid.appendChild(renderNoteCard(note)));
  }

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function checklistCounts(checklist) {
    let total = 0, done = 0;
    checklist.forEach((item) => {
      total += 1; if (item.done) done += 1;
      (item.children || []).forEach((c) => { total += 1; if (c.done) done += 1; });
    });
    return { total, done };
  }

  function renderNoteCard(note) {
    const card = document.createElement("div");
    card.className = "note-card" + (note.pinned ? " pinned" : "");
    card.dataset.color = note.color || "";
    const time = new Date(note.created).toLocaleDateString([], { month: "short", day: "numeric" });
    const editedLabel = note.updated && note.updated !== note.created
      ? `<span class="note-edited"> · Edited ${relativeTime(note.updated)}</span>` : "";

    const counts = checklistCounts(note.checklist);
    const inTrash = note.deleted;
    const inArchive = note.archived && !note.deleted;

    card.innerHTML = `
      <span class="note-category-badge">${escapeHtml(note.category || "Personal")}</span>
      <div class="note-body" data-id="${note.id}">${note.html}</div>
      ${note.tags && note.tags.length ? `<div class="note-tags-display">${note.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      ${note.checklist && note.checklist.length ? `
        <div class="note-checklist" data-id="${note.id}">
          <div class="note-checklist-progress">${counts.done}/${counts.total} completed</div>
          <div class="note-checklist-bar"><div class="note-checklist-bar-fill" style="width:${counts.total ? (counts.done / counts.total) * 100 : 0}%"></div></div>
          <div class="checklist-items"></div>
          <div class="checklist-add-row"><input type="text" placeholder="Add a task…" class="checklist-new-task" /><button type="button" class="checklist-new-task-btn">Add</button></div>
        </div>` : ""}
      <div class="note-meta">
        <span>${time}${editedLabel}</span>
        <div class="note-actions">
          ${!inTrash ? `
          <button class="edit-btn" title="Edit note" aria-label="Edit note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
          <button class="fav-btn ${note.favorite ? "active-fav" : ""}" title="Favorite" aria-label="Favorite note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${note.favorite ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </button>
          <button class="pin-btn ${note.pinned ? "active-pin" : ""}" title="Pin note" aria-label="Pin note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${note.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 5.5L19 9l-5 3 1 6-3-3.5L9 18l1-6-5-3 5.5-1.5z"></path></svg>
          </button>
          <button class="dup-btn" title="Duplicate note" aria-label="Duplicate note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="archive-btn" title="${inArchive ? "Restore from archive" : "Archive note"}" aria-label="Archive note">
            ${inArchive
              ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`}
          </button>
          <button class="del-btn" title="Move to trash" aria-label="Delete note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>` : `
          <button class="restore-btn" title="Restore note" aria-label="Restore note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
          </button>
          <button class="del-forever-btn" title="Delete forever" aria-label="Delete forever">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>`}
        </div>
      </div>`;

    if (note.checklist && note.checklist.length) {
      renderChecklistItems(card, note);
      card.querySelector(".checklist-new-task-btn").addEventListener("click", () => {
        const input = card.querySelector(".checklist-new-task");
        const val = input.value.trim();
        if (!val) return;
        note.checklist.push({ id: uid(), text: val, done: false, children: [] });
        input.value = "";
        note.updated = Date.now();
        persistNotes();
        rerenderNoteInPlace(note);
      });
      card.querySelector(".checklist-new-task").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); card.querySelector(".checklist-new-task-btn").click(); }
      });
    }

    function rerenderAllViews() {
      persistNotes();
      renderNotes();
      renderFavorites();
      renderTrash();
      renderDashboard();
      renderCalendar();
    }

    function rerenderNoteInPlace(n) {
      persistNotes();
      const fresh = renderNoteCard(n);
      card.replaceWith(fresh);
      renderDashboard();
    }

    if (!inTrash) {
      card.querySelector(".edit-btn").addEventListener("click", () => toggleNoteEdit(card, note));
      card.querySelector(".note-body").addEventListener("click", () => openNoteModal(note.id));
      card.querySelector(".fav-btn").addEventListener("click", () => { note.favorite = !note.favorite; rerenderAllViews(); });
      card.querySelector(".pin-btn").addEventListener("click", () => { note.pinned = !note.pinned; rerenderAllViews(); });
      card.querySelector(".dup-btn").addEventListener("click", () => {
        const now = Date.now();
        notes.unshift({ ...note, id: uid(), pinned: false, created: now, updated: now, checklist: note.checklist.map((i) => ({ ...i, id: uid(), children: (i.children || []).map((c) => ({ ...c, id: uid() })) })) });
        rerenderAllViews();
        toast("Note duplicated");
      });
      card.querySelector(".archive-btn").addEventListener("click", () => {
        note.archived = !note.archived;
        rerenderAllViews();
        toast(note.archived ? "Note archived" : "Note restored");
      });
      card.querySelector(".del-btn").addEventListener("click", async () => {
        const ok = await askConfirm("Move this note to Trash?", "Move to Trash");
        if (!ok) return;
        const target = notes.find((n) => n.id === note.id);
        if (!target) return;
        target.deleted = true;
        target.deletedAt = Date.now();
        card.remove();
        rerenderAllViews();
        toast("Note moved to Trash");
      });
    } else {
      card.querySelector(".restore-btn").addEventListener("click", () => {
        const target = notes.find((n) => n.id === note.id);
        if (!target) return;
        target.deleted = false;
        card.remove();
        rerenderAllViews();
        toast("Note restored");
      });
      card.querySelector(".del-forever-btn").addEventListener("click", async () => {
        const ok = await askConfirm("Permanently delete this note? This can't be undone.", "Delete forever");
        if (!ok) return;
        notes = notes.filter((n) => n.id !== note.id);
        card.remove();
        rerenderAllViews();
        toast("Note permanently deleted");
      });
    }
    return card;
  }

  function renderChecklistItems(card, note) {
    const wrap = card.querySelector(".checklist-items");
    if (!wrap) return;
    wrap.innerHTML = "";
    note.checklist.forEach((item) => {
      wrap.appendChild(buildChecklistRow(note, item, false));
      (item.children || []).forEach((child) => wrap.appendChild(buildChecklistRow(note, child, true, item)));
    });
  }

  function buildChecklistRow(note, item, isSub, parent) {
    const row = document.createElement("div");
    row.className = "checklist-item-row" + (isSub ? " sub" : "") + (item.done ? " done" : "");
    row.innerHTML = `
      <button type="button" class="checklist-item-check ${item.done ? "checked" : ""}" aria-label="Toggle task">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </button>
      <span>${escapeHtml(item.text)}</span>
      <button type="button" class="checklist-item-del" aria-label="Delete task">×</button>`;
    row.querySelector(".checklist-item-check").addEventListener("click", () => {
      item.done = !item.done;
      note.updated = Date.now();
      persistNotes();
      renderNotes(); renderFavorites(); renderTrash(); renderDashboard();
    });
    row.querySelector(".checklist-item-del").addEventListener("click", () => {
      if (isSub && parent) parent.children = parent.children.filter((c) => c.id !== item.id);
      else note.checklist = note.checklist.filter((i) => i.id !== item.id);
      note.updated = Date.now();
      persistNotes();
      renderNotes(); renderFavorites(); renderTrash(); renderDashboard();
    });
    return row;
  }

  function toggleNoteEdit(card, note) {
    const body = card.querySelector(".note-body");
    const isEditing = body.getAttribute("contenteditable") === "true";
    if (isEditing) {
      finishNoteEdit(body, note);
      return;
    }
    startNoteEdit(body, note);
  }

  function startNoteEdit(body, note) {
    body.setAttribute("contenteditable", "true");
    body.focus();
    let saveTimer = null;
    const onInput = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        note.html = body.innerHTML;
        note.updated = Date.now();
        persistNotes();
      }, 600);
    };
    const onPaste = (e) => {
      const clipboard = e.clipboardData || window.clipboardData;
      const text = clipboard ? clipboard.getData("text/plain") : null;
      if (text) {
        e.preventDefault();
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
        document.execCommand("insertHTML", false, escaped);
      }
    };
    body.addEventListener("input", onInput);
    body.addEventListener("paste", onPaste);
    body._onInput = onInput;
    body._onPaste = onPaste;
    const onBlur = () => finishNoteEdit(body, note);
    body.addEventListener("blur", onBlur, { once: true });
  }

  function finishNoteEdit(body, note) {
    body.setAttribute("contenteditable", "false");
    note.html = normalizeNoteHtml(body.innerHTML);
    note.updated = Date.now();
    persistNotes();
    renderNotes(); renderFavorites(); renderTrash(); renderDashboard();
    toast("Note saved");
  }

  /* ---------- note preview modal ---------- */
  const noteModalOverlay = $("#note-modal-overlay");
  let currentModalNoteId = null;

  function openNoteModal(noteId) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;

    currentModalNoteId = noteId;
    const time = new Date(note.created).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const editedTime = note.updated && note.updated !== note.created ? ` (Edited ${relativeTime(note.updated)})` : "";

    $("#note-modal-title").textContent = note.html.replace(/<[^>]*>/g, "").slice(0, 100) || "Untitled Note";
    $("#note-modal-date").textContent = time + editedTime;
    $("#note-modal-content").innerHTML = note.html;
    $("#note-modal-category").innerHTML = `<span class="note-category-badge">${escapeHtml(note.category || "Personal")}</span>`;

    if (note.pinned) {
      $("#note-modal-pinned").style.display = "inline";
    } else {
      $("#note-modal-pinned").style.display = "none";
    }

    if (note.tags && note.tags.length) {
      $("#note-modal-tags").innerHTML = note.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("");
    } else {
      $("#note-modal-tags").innerHTML = "";
    }

    if (note.checklist && note.checklist.length) {
      const checklistHtml = note.checklist.map((item) => `
        <div class="note-modal-checklist-item">
          <input type="checkbox" ${item.done ? "checked" : ""} disabled />
          <span>${escapeHtml(item.text)}</span>
        </div>
      `).join("");
      $("#note-modal-checklist").innerHTML = checklistHtml;
    } else {
      $("#note-modal-checklist").innerHTML = "";
    }

    updateNoteModalActions(note);
    noteModalOverlay.classList.add("visible");
    document.body.style.overflow = "hidden";
  }

  function closeNoteModal() {
    noteModalOverlay.classList.remove("visible");
    document.body.style.overflow = "";
    currentModalNoteId = null;
  }

  function updateNoteModalActions(note) {
    const inTrash = note.deleted;

    const editBtn = $("#note-modal-edit");
    const pinBtn = $("#note-modal-pin");
    const deleteBtn = $("#note-modal-delete");

    editBtn.onclick = () => {
      closeNoteModal();
      const body = document.querySelector(`.note-body[data-id="${note.id}"]`);
      if (body) startNoteEdit(body, note);
    };

    if (inTrash) {
      pinBtn.style.display = "none";
      editBtn.style.display = "none";
      deleteBtn.textContent = "🗑️ Delete Forever";
      deleteBtn.onclick = async () => {
        const ok = await askConfirm("Permanently delete this note? This can't be undone.", "Delete forever");
        if (!ok) return;
        notes = notes.filter((n) => n.id !== note.id);
        closeNoteModal();
        persistNotes();
        renderNotes(); renderFavorites(); renderTrash(); renderDashboard(); renderCalendar();
        toast("Note permanently deleted");
      };
    } else {
      pinBtn.style.display = "inline-flex";
      editBtn.style.display = "inline-flex";
      deleteBtn.textContent = "🗑️ Delete";

      pinBtn.textContent = note.pinned ? "📌 Unpin" : "📌 Pin";
      pinBtn.onclick = () => {
        note.pinned = !note.pinned;
        persistNotes();
        updateNoteModalActions(note);
        renderNotes(); renderFavorites(); renderDashboard();
      };

      deleteBtn.onclick = () => {
        note.deleted = true;
        note.deletedAt = Date.now();
        persistNotes();
        closeNoteModal();
        renderNotes(); renderFavorites(); renderTrash(); renderDashboard(); renderCalendar();
        toast("Note moved to Trash");
      };
    }
  }

  $("#note-modal-close").addEventListener("click", closeNoteModal);
  noteModalOverlay.addEventListener("click", (e) => {
    if (e.target === noteModalOverlay) closeNoteModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && noteModalOverlay.classList.contains("visible")) closeNoteModal();
  });

  /* ---------- reminders ---------- */
  $("#add-reminder-btn").addEventListener("click", () => {
    if (!currentUser) return;
    const text = $("#reminder-input").value.trim();
    const time = $("#reminder-time").value;
    if (!text) return;
    reminders.unshift({ id: uid(), text, time: time || null, done: false, notified: false, created: Date.now() });
    $("#reminder-input").value = "";
    $("#reminder-time").value = "";
    persistReminders();
    renderReminders();
    renderDashboard();
    toast("Reminder added");
  });

  $$("#reminder-filters .filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      reminderFilter = btn.dataset.filter;
      $$("#reminder-filters .filter").forEach((f) => f.classList.toggle("active", f === btn));
      renderReminders();
    });
  });

  $("#clear-reminders-btn").addEventListener("click", () => {
    reminders = reminders.filter((r) => !r.done);
    persistReminders();
    renderReminders();
    renderDashboard();
  });

  function isToday(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }

  function renderReminders() {
    const list = $("#reminders-list");
    list.querySelectorAll(".reminder-item").forEach((el) => el.remove());
    const now = Date.now();

    let filtered = reminders;
    if (reminderFilter === "today") filtered = reminders.filter((r) => isToday(r.time));
    if (reminderFilter === "upcoming") filtered = reminders.filter((r) => !r.done && r.time && new Date(r.time).getTime() > now);
    if (reminderFilter === "done") filtered = reminders.filter((r) => r.done);

    const emptyEl = $("#reminders-empty");
    if (emptyEl) {
      emptyEl.hidden = filtered.length > 0;
      emptyEl.style.display = filtered.length > 0 ? "none" : "";
    }

    filtered
      .slice()
      .sort((a, b) => (a.time ? new Date(a.time).getTime() : Infinity) - (b.time ? new Date(b.time).getTime() : Infinity))
      .forEach((r) => list.appendChild(renderReminderItem(r)));

    $("#reminders-count").textContent = reminders.filter((r) => !r.done).length;
  }

  function renderReminderItem(r) {
    const el = document.createElement("div");
    const overdue = !r.done && r.time && new Date(r.time).getTime() < Date.now();
    el.className = "reminder-item" + (r.done ? " done" : "") + (overdue ? " overdue" : "");
    const timeLabel = r.time
      ? new Date(r.time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "No time set";
    el.innerHTML = `
      <button class="reminder-check ${r.done ? "checked" : ""}" aria-label="Toggle done">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </button>
      <div class="reminder-text">
        <p class="reminder-title">${escapeHtml(r.text)}</p>
        <p class="reminder-time">${timeLabel}</p>
      </div>
      <button class="reminder-delete" aria-label="Delete reminder">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>`;
    el.querySelector(".reminder-check").addEventListener("click", () => {
      r.done = !r.done;
      persistReminders();
      renderReminders();
      renderDashboard();
    });
    el.querySelector(".reminder-delete").addEventListener("click", () => {
      reminders = reminders.filter((x) => x.id !== r.id);
      persistReminders();
      renderReminders();
      renderDashboard();
    });
    return el;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------- calendar ---------- */
  $("#cal-prev").addEventListener("click", () => { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); });
  $("#cal-next").addEventListener("click", () => { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); });

  function renderCalendar() {
    const grid = $("#calendar-grid");
    grid.innerHTML = "";
    const year = calDate.getFullYear();
    const month = calDate.getMonth();
    $("#cal-title").textContent = calDate.toLocaleDateString([], { month: "long", year: "numeric" });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const today = new Date();

    const remindersByDay = {};
    reminders.forEach((r) => {
      if (!r.time) return;
      const d = new Date(r.time);
      if (d.getFullYear() === year && d.getMonth() === month) {
        remindersByDay[d.getDate()] = (remindersByDay[d.getDate()] || 0) + 1;
      }
    });
    const notesByDay = {};
    notes.forEach((n) => {
      if (n.deleted) return;
      const d = new Date(n.created);
      if (d.getFullYear() === year && d.getMonth() === month) {
        notesByDay[d.getDate()] = (notesByDay[d.getDate()] || 0) + 1;
      }
    });

    const cells = [];
    for (let i = firstDay - 1; i >= 0; i--) {
      cells.push({ day: daysInPrevMonth - i, muted: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, muted: false });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ day: cells.length - (firstDay + daysInMonth) + 1, muted: true });
    }

    cells.forEach((c) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cal-day" + (c.muted ? " muted" : "");
      const isToday = !c.muted && c.day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
      if (isToday) cell.classList.add("today");
      if (!c.muted && selectedDay === c.day) cell.classList.add("selected");
      cell.innerHTML = `<span>${c.day}</span>`;
      if (!c.muted && remindersByDay[c.day]) {
        cell.innerHTML += `<span class="cal-dot"></span>`;
      }
      if (!c.muted && notesByDay[c.day]) {
        cell.innerHTML += `<span class="cal-dot cal-dot-note"></span>`;
      }
      if (!c.muted) {
        cell.addEventListener("click", () => {
          selectedDay = c.day;
          renderCalendar();
          showDayDetails(year, month, c.day);
        });
      }
      grid.appendChild(cell);
    });
  }

  function showDayDetails(year, month, day) {
    const panel = $("#cal-day-details");
    panel.hidden = false;
    const dateObj = new Date(year, month, day);
    $("#cal-day-title").textContent = dateObj.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const list = $("#cal-day-list");
    const dayReminders = reminders.filter((r) => r.time && new Date(r.time).toDateString() === dateObj.toDateString());
    const dayNotes = notes.filter((n) => !n.deleted && new Date(n.created).toDateString() === dateObj.toDateString());
    if (!dayReminders.length && !dayNotes.length) {
      list.innerHTML = `<p class="dash-empty">Nothing on this day.</p>`;
      return;
    }
    list.innerHTML = "";
    dayReminders.forEach((r) => {
      const row = document.createElement("div");
      row.className = "dash-row";
      row.innerHTML = `<span>⏰ ${escapeHtml(r.text)}</span><span>${new Date(r.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`;
      list.appendChild(row);
    });
    dayNotes.forEach((n) => {
      const row = document.createElement("div");
      row.className = "dash-row";
      row.innerHTML = `<span>📝 ${escapeHtml(stripHtml(n.html).slice(0, 50) || "Untitled note")}</span><span>${n.category}</span>`;
      list.appendChild(row);
    });
  }

  /* ---------- focus timer ---------- */
  const DURATIONS = { work: 25 * 60, short: 5 * 60, long: 15 * 60 };
  let timerMode = "work";
  let timerSeconds = DURATIONS.work;
  let timerRunning = false;
  let timerInterval = null;
  const CIRCUMFERENCE = 339.3;

  function updateTimerDisplay() {
    const m = Math.floor(timerSeconds / 60).toString().padStart(2, "0");
    const s = Math.floor(timerSeconds % 60).toString().padStart(2, "0");
    $("#timer-display").textContent = `${m}:${s}`;
    const progress = 1 - timerSeconds / DURATIONS[timerMode];
    $("#timer-progress").style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);
  }

  $$(".focus-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      timerMode = btn.dataset.mode;
      $$(".focus-mode").forEach((b) => b.classList.toggle("active", b === btn));
      pauseTimer();
      timerSeconds = DURATIONS[timerMode];
      updateTimerDisplay();
      $("#focus-status").textContent = timerMode === "work" ? "Time to focus." : "Take a breather.";
    });
  });

  function startTimer() {
    timerRunning = true;
    $("#timer-toggle").textContent = "Pause";
    $("#focus-status").textContent = timerMode === "work" ? "Focusing…" : "Relaxing…";
    timerInterval = setInterval(() => {
      timerSeconds -= 1;
      if (timerSeconds <= 0) {
        clearInterval(timerInterval);
        timerRunning = false;
        timerSeconds = 0;
        updateTimerDisplay();
        $("#timer-toggle").textContent = "Start Focus";
        $("#focus-status").textContent = "Session complete!";
        toast("Focus session complete");
        return;
      }
      updateTimerDisplay();
    }, 1000);
  }
  function pauseTimer() {
    timerRunning = false;
    clearInterval(timerInterval);
    $("#timer-toggle").textContent = "Start Focus";
  }
  $("#timer-toggle").addEventListener("click", () => (timerRunning ? pauseTimer() : startTimer()));
  $("#timer-reset").addEventListener("click", () => {
    pauseTimer();
    timerSeconds = DURATIONS[timerMode];
    updateTimerDisplay();
    $("#focus-status").textContent = timerMode === "work" ? "Time to focus." : "Take a breather.";
  });
  updateTimerDisplay();

  /* ---------- reminder due notifications ---------- */
  let reminderWatcherStarted = false;
  function startReminderWatcher() {
    if (reminderWatcherStarted) return;
    reminderWatcherStarted = true;
    checkDueReminders();
    setInterval(checkDueReminders, 30 * 1000);
  }
  function checkDueReminders() {
    const now = Date.now();
    let changed = false;
    reminders.forEach((r) => {
      if (!r.done && r.time && !r.notified && new Date(r.time).getTime() <= now) {
        r.notified = true;
        changed = true;
        toast(`Reminder due: ${r.text}`);
        if (settings.notifications && "Notification" in window && Notification.permission === "granted") {
          try { new Notification("Bloom Notes", { body: r.text }); } catch { /* ignore */ }
        }
      }
    });
    if (changed) { persistReminders(); renderReminders(); }
  }

  /* ---------- dashboard ---------- */
  function renderDashboard() {
    const now = new Date();
    $("#dash-greeting").textContent = currentUser ? `Welcome back, ${currentUser.name}` : "Welcome back";
    $("#dash-date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

    const liveNotes = notes.filter((n) => !n.deleted && !n.archived);
    const pinned = liveNotes.filter((n) => n.pinned);
    const activeReminders = reminders.filter((r) => !r.done);
    const completedChecklists = notes.filter((n) => !n.deleted && n.checklist.length && n.checklist.every((i) => i.done && (i.children || []).every((c) => c.done))).length;

    $("#dash-stats").innerHTML = [
      [liveNotes.length, "Total Notes"],
      [pinned.length, "Pinned Notes"],
      [completedChecklists, "Completed Checklists"],
      [activeReminders.length, "Active Reminders"],
    ].map(([value, label]) => `
        <div class="dash-stat">
          <div class="dash-stat-value">${value}</div>
          <div class="dash-stat-label">${label}</div>
        </div>`).join("");

    const recentWrap = $("#dash-recent-notes");
    const recent = [...liveNotes].sort((a, b) => b.updated - a.updated).slice(0, 4);
    recentWrap.innerHTML = recent.length
      ? recent.map((n) => `<div class="dash-row"><span>${escapeHtml(stripHtml(n.html).slice(0, 60) || "Untitled note")}</span><span>${relativeTime(n.updated)}</span></div>`).join("")
      : `<p class="dash-empty">No notes yet.</p>`;

    const pinnedWrap = $("#dash-pinned-notes");
    pinnedWrap.innerHTML = pinned.length
      ? pinned.slice(0, 4).map((n) => `<div class="dash-row"><span>${escapeHtml(stripHtml(n.html).slice(0, 60))}</span></div>`).join("")
      : `<p class="dash-empty">No pinned notes yet.</p>`;

    const upcoming = activeReminders
      .filter((r) => r.time)
      .sort((a, b) => new Date(a.time) - new Date(b.time))
      .slice(0, 4);
    const upcomingWrap = $("#dash-upcoming-reminders");
    upcomingWrap.innerHTML = upcoming.length
      ? upcoming.map((r) => `<div class="dash-row"><span>${escapeHtml(r.text)}</span><span>${new Date(r.time).toLocaleDateString([], { month: "short", day: "numeric" })}</span></div>`).join("")
      : `<p class="dash-empty">Nothing coming up.</p>`;
  }

  function stripHtml(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || "";
  }

  function normalizeNoteHtml(html) {
    const trimmed = html.trim();
    if (!trimmed) return "";
    const isEncodedSource = /&lt;\/?[a-z][^&]*&gt;/i.test(trimmed);
    if (isEncodedSource) {
      return trimmed.replace(/\r?\n/g, "<br>");
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("<html") || lower.includes("<head") || lower.includes("<body") || lower.includes("<script") || lower.includes("<style")) {
      return escapeHtml(trimmed).replace(/\r?\n/g, "<br>");
    }
    const doc = new DOMParser().parseFromString(trimmed, "text/html");
    return doc.body ? doc.body.innerHTML : escapeHtml(trimmed).replace(/\r?\n/g, "<br>");
  }

  /* ---------- render all ---------- */
  function renderAll() {
    renderCategoryOptions();
    renderTagOptions();
    renderNotes();
    renderFavorites();
    renderTrash();
    renderReminders();
    renderCalendar();
    renderDashboard();
  }

  boot();
})();