(() => {
  "use strict";

  const PERSONAL_KEY = "fundRadar:personal:v1";
  const CATALOG_URL = "https://fund.eastmoney.com/js/fundcode_search.js";
  const REALTIME_URL = "https://fundgz.1234567.com.cn/js";
  const REALTIME_INTERVAL_MS = 60000;

  function readPersonal() {
    try {
      const value = JSON.parse(localStorage.getItem(PERSONAL_KEY));
      if (value && Array.isArray(value.funds)) {
        return { version: 1, funds: value.funds, needsSeed: false };
      }
    } catch (_) {
      // A broken local preference should not prevent the PWA from starting.
    }
    return { version: 1, funds: [], needsSeed: true };
  }

  state.personal = readPersonal();
  state.catalog = [];
  state.catalogStatus = "idle";
  state.searchTerm = "";
  state.liveFunds = {};
  state.lastRealtimeAt = "";

  if (!tabs.some((item) => item.key === "watchlist")) {
    tabs.splice(2, 0, { key: "watchlist", label: "自选" });
  }

  const baseRenderDashboard = renderDashboard;
  const baseRenderFunds = renderFunds;
  const baseRenderData = renderData;

  function savePersonal() {
    const value = { version: 1, funds: state.personal.funds };
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(value));
    state.personal.needsSeed = false;
  }

  function seedPersonalFromPublishedData() {
    if (!state.personal.needsSeed || !state.data) return;
    state.personal.funds = (state.data.funds || []).map((fund) => ({
      code: fund.code,
      name: fund.name || fund.alias || fund.code,
      alias: fund.alias || "",
      holding_amount: asNumber(fund.holding_amount) || 0,
      cost_nav: asNumber(fund.cost_nav),
      target_weight: asNumber(fund.target_weight),
      alerts: { up: null, down: null },
      last_alerts: {}
    }));
    savePersonal();
  }

  function fundByCode(code) {
    return (state.data && state.data.funds || []).find((fund) => fund.code === code);
  }

  function personalByCode(code) {
    return state.personal.funds.find((fund) => fund.code === code);
  }

  function watchedFunds() {
    return state.personal.funds.map((settings) => {
      const published = fundByCode(settings.code) || {};
      const live = state.liveFunds[settings.code] || {};
      return {
        code: settings.code,
        name: settings.name || published.name || settings.code,
        ...published,
        ...live,
        alias: settings.alias || published.alias,
        personal: settings
      };
    });
  }

  function currency(value) {
    const number = asNumber(value);
    if (number === null) return "--";
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(number);
  }

  function portfolioSnapshot(funds = watchedFunds()) {
    const rows = [];
    let totalCost = 0;
    let totalMarket = 0;
    let dailyProfit = 0;

    funds.forEach((fund) => {
      const settings = fund.personal || {};
      const amount = asNumber(settings.holding_amount) || 0;
      const costNav = asNumber(settings.cost_nav);
      const currentNav = asNumber((fund.estimate || {}).value) ?? asNumber(fund.nav);
      let targetWeight = asNumber(settings.target_weight);
      if (targetWeight !== null && targetWeight > 1) targetWeight /= 100;
      if (!(amount > 0 && costNav > 0 && currentNav !== null)) return;

      const units = amount / costNav;
      const marketValue = units * currentNav;
      const profit = marketValue - amount;
      const latestNav = asNumber(fund.nav);
      let today = latestNav === null ? null : units * (currentNav - latestNav);
      const pct = asNumber((fund.estimate || {}).pct);
      if (today === null && pct !== null && pct > -100) {
        today = marketValue * pct / (100 + pct);
      }
      rows.push({ fund, amount, marketValue, profit, today, targetWeight });
      totalCost += amount;
      totalMarket += marketValue;
      if (today !== null) dailyProfit += today;
    });

    rows.forEach((row) => {
      row.actualWeight = totalMarket ? row.marketValue / totalMarket : null;
      row.drift = row.targetWeight === null || row.actualWeight === null
        ? null
        : (row.actualWeight - row.targetWeight) * 100;
    });

    const totalProfit = totalMarket - totalCost;
    return {
      rows,
      totalCost,
      totalMarket,
      totalProfit,
      totalReturn: totalCost ? totalProfit / totalCost * 100 : null,
      dailyProfit
    };
  }

  function renderPortfolioHero(snapshot) {
    return `
      <section class="hero">
        <div class="hero-main">
          <div>
            <div class="eyebrow">今日预估收益</div>
            <div class="big-number ${pctClass(snapshot.dailyProfit)}">${currency(snapshot.dailyProfit)}</div>
          </div>
          <div class="hero-status">
            <span class="status-pill good">${snapshot.rows.length} 笔持仓</span>
            <span class="status-pill">本机私有</span>
          </div>
        </div>
        <div class="metric-strip">
          <div class="metric"><b>${currency(snapshot.totalMarket)}</b><span>当前市值</span></div>
          <div class="metric"><b class="${pctClass(snapshot.totalProfit)}">${currency(snapshot.totalProfit)}</b><span>累计收益</span></div>
          <div class="metric"><b class="${pctClass(snapshot.totalReturn)}">${fmtPct(snapshot.totalReturn)}</b><span>收益率</span></div>
        </div>
      </section>
    `;
  }

  renderDashboard = function renderPersonalDashboard(data) {
    const funds = watchedFunds();
    const snapshot = portfolioSnapshot(funds);
    if (!snapshot.rows.length) {
      return `${baseRenderDashboard(data)}
        <section class="section">
          <div class="section-head"><h2>个人持仓</h2><span>尚未配置</span></div>
          <div class="watch-card">
            <strong>设置投入金额和成本净值后显示收益看板</strong>
            <div class="scope-note">进入“自选”，点击基金的“持仓与提醒”。数据只保存在当前设备。</div>
          </div>
        </section>`;
    }

    const movers = funds
      .map((fund) => ({ fund, pct: asNumber((fund.estimate || {}).pct) }))
      .filter((item) => item.pct !== null)
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const drifts = snapshot.rows
      .filter((row) => row.drift !== null)
      .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));

    return `
      ${renderPortfolioHero(snapshot)}
      <section class="section">
        <div class="section-head"><h2>今日波动</h2><span>${state.lastRealtimeAt || freshText(data)}</span></div>
        <div class="list">
          ${movers.map(({ fund, pct }) => `
            <div class="row">
              <div class="row-main"><strong>${escapeHtml(compactName(fund))}</strong><span>${escapeHtml(fund.code)} · ${escapeHtml((fund.estimate || {}).time || "等待实时估值")}</span></div>
              <div class="row-value ${pctClass(pct)}">${fmtPct(pct)}</div>
            </div>`).join("") || `<div class="empty">暂无实时估值</div>`}
        </div>
      </section>
      <section class="section">
        <div class="section-head"><h2>目标配置偏离</h2><span>百分比点</span></div>
        <div class="list">
          ${drifts.map((row) => `
            <div class="row">
              <div class="row-main"><strong>${escapeHtml(compactName(row.fund))}</strong><span>实际 ${(row.actualWeight * 100).toFixed(1)}% · 目标 ${(row.targetWeight * 100).toFixed(1)}%</span></div>
              <div class="row-value ${Math.abs(row.drift) >= 5 ? "pos" : "muted"}">${row.drift > 0 ? "+" : ""}${row.drift.toFixed(2)}</div>
            </div>`).join("") || `<div class="empty">为持仓设置目标占比后显示偏离</div>`}
        </div>
      </section>`;
  };

  function catalogMatches() {
    const term = state.searchTerm.trim().toLowerCase();
    if (!term) return [];
    const exactCode = /^\d{6}$/.test(term)
      ? [{ code: term, name: `基金 ${term}`, pinyin: "", type: "" }]
      : [];
    const fromCatalog = state.catalog.filter((item) =>
      item.code.includes(term) || item.name.toLowerCase().includes(term) || item.pinyin.includes(term)
    );
    const merged = [...fromCatalog];
    exactCode.forEach((item) => {
      if (!merged.some((known) => known.code === item.code)) merged.unshift(item);
    });
    return merged.slice(0, 20);
  }

  function renderWatchlist() {
    const funds = watchedFunds();
    const matches = catalogMatches();
    const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    const catalogLabel = state.catalogStatus === "ready"
      ? `全市场目录 ${state.catalog.length} 只`
      : state.catalogStatus === "loading" ? "正在加载全市场目录" : "可直接输入6位基金代码";

    return `
      <section class="section" style="margin-top:0">
        <div class="section-head"><h2>添加自选基金</h2><span>${catalogLabel}</span></div>
        <form class="search-panel" id="fundSearchForm">
          <input class="text-input" id="fundSearch" value="${escapeHtml(state.searchTerm)}" placeholder="基金代码、名称或拼音" autocomplete="off" inputmode="search">
          <button class="command-button" type="submit">搜索</button>
        </form>
        <div class="scope-note">目录覆盖全市场公募基金，可覆盖理财通在售公募产品；平台是否当前可买、限购或下架，请在理财通下单前复核。</div>
      </section>
      ${state.searchTerm ? `
        <section class="section">
          <div class="section-head"><h2>搜索结果</h2><span>${matches.length} 项</span></div>
          <div class="list">
            ${matches.map((item) => {
              const added = Boolean(personalByCode(item.code));
              return `<div class="row">
                <div class="row-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.code)}${item.type ? ` · ${escapeHtml(item.type)}` : ""}</span></div>
                <button class="secondary-button add-fund" data-code="${item.code}" data-name="${escapeHtml(item.name)}" ${added ? "disabled" : ""}>${added ? "已添加" : "添加"}</button>
              </div>`;
            }).join("") || `<div class="empty">没有匹配结果，可输入完整6位基金代码直接添加</div>`}
          </div>
        </section>` : ""}
      <section class="section">
        <div class="section-head"><h2>观察队列</h2><span>${funds.length} 只 · 60秒刷新</span></div>
        <div class="list fund-list">
          ${funds.map((fund) => {
            const settings = fund.personal || {};
            const pct = asNumber((fund.estimate || {}).pct);
            const alerts = settings.alerts || {};
            const alertText = [
              asNumber(alerts.up) !== null ? `涨至 ${fmtPct(alerts.up)}` : "",
              asNumber(alerts.down) !== null ? `跌至 ${fmtPct(alerts.down)}` : ""
            ].filter(Boolean).join(" / ") || "未设置提醒";
            return `<div class="watch-card">
              <div class="watch-head">
                <div class="row-main"><strong>${escapeHtml(compactName(fund))}</strong><span>${escapeHtml(fund.code)} · ${escapeHtml(fund.name || "等待行情")}</span></div>
                <div class="fund-change ${pctClass(pct)}">${fmtPct(pct)}</div>
              </div>
              <div class="watch-meta">
                <span>估值 ${fmtNumber((fund.estimate || {}).value)}</span>
                <span>净值 ${fmtNumber(fund.nav)}</span>
                <span>${escapeHtml((fund.estimate || {}).time || fund.nav_date || "等待刷新")}</span>
                <span>${escapeHtml(alertText)}</span>
              </div>
              <div class="watch-actions">
                <button class="secondary-button edit-fund" data-code="${fund.code}">持仓与提醒</button>
                <button class="danger-button remove-fund" data-code="${fund.code}">移除</button>
              </div>
            </div>`;
          }).join("") || `<div class="empty">观察队列为空，请搜索并添加基金</div>`}
        </div>
      </section>
      <section class="section">
        <div class="section-head"><h2>提醒权限</h2><span>${permission === "granted" ? "已允许" : permission === "denied" ? "已拒绝" : "未开启"}</span></div>
        <div class="watch-card">
          <strong>页面打开时检查涨跌幅阈值</strong>
          <div class="scope-note">浏览器后台策略可能暂停定时检查，因此首版不能承诺关闭页面后仍准时推送。</div>
          <div class="watch-actions"><button class="command-button" id="notificationBtn" ${permission === "unsupported" || permission === "denied" ? "disabled" : ""}>${permission === "granted" ? "通知已开启" : "开启浏览器通知"}</button></div>
        </div>
      </section>`;
  }

  renderFunds = function renderWatchedFundDetails(data) {
    return baseRenderFunds({ ...data, funds: watchedFunds() });
  };

  renderData = function renderPersonalData(data) {
    return `${baseRenderData(data)}
      <section class="section">
        <div class="section-head"><h2>个人功能状态</h2><span>仅本机</span></div>
        <div class="fund-card" style="padding:0 14px">
          <div class="data-line"><strong>观察队列</strong><code>${state.personal.funds.length}只基金</code></div>
          <div class="data-line"><strong>实时刷新</strong><code>页面可见时每60秒；最近刷新 ${escapeHtml(state.lastRealtimeAt || "尚未完成")}</code></div>
          <div class="data-line"><strong>基金目录</strong><code>${state.catalogStatus === "ready" ? `全市场 ${state.catalog.length} 只` : "打开自选页后加载"}</code></div>
          <div class="data-line"><strong>理财通范围</strong><code>全市场目录覆盖候选产品；可买、限购及下架状态须在腾讯理财通复核</code></div>
        </div>
      </section>`;
  };

  function renderFeatureApp() {
    renderNav();
    const data = state.data;
    if (!data) {
      $("#view").innerHTML = `<div class="empty">加载中</div>`;
      return;
    }
    seedPersonalFromPublishedData();
    $("#subtitle").textContent = `${freshText(data)} · ${state.personal.funds.length}只自选`;
    const map = {
      dashboard: renderDashboard,
      overlap: renderOverlap,
      watchlist: renderWatchlist,
      funds: renderFunds,
      data: renderData
    };
    $("#view").innerHTML = (map[state.tab] || renderDashboard)(data);
    bindFeatureEvents();
    if (state.tab === "watchlist" && state.catalogStatus === "idle") loadCatalog();
  }

  render = renderFeatureApp;

  function bindFeatureEvents() {
    const searchForm = $("#fundSearchForm");
    if (searchForm) {
      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        state.searchTerm = $("#fundSearch").value.trim();
        render();
      });
    }
    document.querySelectorAll(".add-fund").forEach((button) => {
      button.addEventListener("click", () => addFund(button.dataset.code, button.dataset.name));
    });
    document.querySelectorAll(".edit-fund").forEach((button) => {
      button.addEventListener("click", () => openSettings(button.dataset.code));
    });
    document.querySelectorAll(".remove-fund").forEach((button) => {
      button.addEventListener("click", () => removeFund(button.dataset.code));
    });
    const notificationButton = $("#notificationBtn");
    if (notificationButton) notificationButton.addEventListener("click", requestNotifications);
  }

  function loadCatalog() {
    if (state.catalogStatus === "loading" || state.catalogStatus === "ready") return;
    state.catalogStatus = "loading";
    const script = document.createElement("script");
    const previous = window.r;
    const finish = (status) => {
      clearTimeout(timer);
      script.remove();
      state.catalogStatus = status;
      if (state.tab === "watchlist") render();
    };
    const timer = setTimeout(() => finish("error"), CONFIG.requestTimeoutMs);
    script.src = `${CATALOG_URL}?ts=${Date.now()}`;
    script.async = true;
    script.onload = () => {
      const rows = Array.isArray(window.r) && window.r !== previous ? window.r : [];
      state.catalog = rows
        .filter((row) => Array.isArray(row) && /^\d{6}$/.test(String(row[0] || "")))
        .map((row) => ({
          code: String(row[0]),
          pinyin: `${row[1] || ""} ${row[4] || ""}`.toLowerCase(),
          name: String(row[2] || row[0]),
          type: String(row[3] || "")
        }));
      finish(state.catalog.length ? "ready" : "error");
    };
    script.onerror = () => finish("error");
    document.head.appendChild(script);
  }

  function addFund(code, name) {
    if (!/^\d{6}$/.test(code) || personalByCode(code)) return;
    state.personal.funds.push({
      code,
      name: name || code,
      alias: "",
      holding_amount: 0,
      cost_nav: null,
      target_weight: null,
      alerts: { up: null, down: null },
      last_alerts: {}
    });
    savePersonal();
    state.searchTerm = "";
    render();
    refreshOneFund(code).then(() => render());
    showToast(`已添加 ${code}`);
  }

  function removeFund(code) {
    const fund = personalByCode(code);
    if (!fund || !window.confirm(`从观察队列移除 ${fund.alias || fund.name || code}？`)) return;
    state.personal.funds = state.personal.funds.filter((item) => item.code !== code);
    delete state.liveFunds[code];
    savePersonal();
    render();
  }

  function openSettings(code) {
    const fund = personalByCode(code);
    if (!fund) return;
    const alerts = fund.alerts || {};
    const target = asNumber(fund.target_weight);
    const dialog = $("#settingsDialog");
    dialog.innerHTML = `
      <form class="settings-form" id="settingsForm">
        <h2>${escapeHtml(fund.alias || fund.name || code)}</h2>
        <p>${escapeHtml(code)} · 金额、成本和提醒仅保存在当前设备，不会上传。</p>
        <label class="field">显示名称<input class="text-input" name="alias" value="${escapeHtml(fund.alias || "")}" placeholder="可选"></label>
        <div class="field-grid">
          <label class="field">投入本金（元）<input class="text-input" name="holding_amount" type="number" min="0" step="0.01" value="${asNumber(fund.holding_amount) || ""}" placeholder="10000"></label>
          <label class="field">平均成本净值<input class="text-input" name="cost_nav" type="number" min="0" step="0.0001" value="${asNumber(fund.cost_nav) || ""}" placeholder="1.1234"></label>
          <label class="field">目标占比（%）<input class="text-input" name="target_weight" type="number" min="0" max="100" step="0.1" value="${target === null ? "" : target <= 1 ? target * 100 : target}" placeholder="40"></label>
          <label class="field">上涨提醒（%）<input class="text-input" name="alert_up" type="number" step="0.01" value="${asNumber(alerts.up) ?? ""}" placeholder="2.00"></label>
          <label class="field">下跌提醒（%）<input class="text-input" name="alert_down" type="number" step="0.01" value="${asNumber(alerts.down) ?? ""}" placeholder="-2.00"></label>
        </div>
        <div class="dialog-actions">
          <button class="secondary-button" type="button" id="cancelSettings">取消</button>
          <button class="command-button" type="submit">保存</button>
        </div>
      </form>`;
    $("#cancelSettings").addEventListener("click", () => dialog.close());
    $("#settingsForm").addEventListener("submit", (event) => saveSettings(event, code));
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function optionalFormNumber(form, name) {
    const value = form.elements[name].value.trim();
    return value === "" ? null : Number(value);
  }

  function saveSettings(event, code) {
    event.preventDefault();
    const form = event.currentTarget;
    const fund = personalByCode(code);
    if (!fund) return;
    const amount = optionalFormNumber(form, "holding_amount");
    const costNav = optionalFormNumber(form, "cost_nav");
    const targetPct = optionalFormNumber(form, "target_weight");
    const up = optionalFormNumber(form, "alert_up");
    const down = optionalFormNumber(form, "alert_down");
    if ([amount, costNav, targetPct, up, down].some((value) => value !== null && !Number.isFinite(value))) {
      showToast("请检查数字格式");
      return;
    }
    if ((amount !== null && amount < 0) || (costNav !== null && costNav <= 0) || (targetPct !== null && (targetPct < 0 || targetPct > 100))) {
      showToast("本金不能为负，成本须大于0，目标占比须在0至100之间");
      return;
    }
    fund.alias = form.elements.alias.value.trim();
    fund.holding_amount = amount || 0;
    fund.cost_nav = costNav;
    fund.target_weight = targetPct === null ? null : targetPct / 100;
    fund.alerts = { up, down };
    fund.last_alerts = fund.last_alerts || {};
    savePersonal();
    $("#settingsDialog").close();
    render();
    evaluateAlerts([watchedFunds().find((item) => item.code === code)]);
    showToast("持仓与提醒已保存");
  }

  async function requestNotifications() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    render();
    showToast(Notification.permission === "granted" ? "浏览器通知已开启" : "通知未获授权");
  }

  function mapRealtime(payload) {
    return {
      code: String(payload.fundcode || ""),
      name: payload.name,
      nav: asNumber(payload.dwjz),
      nav_date: payload.jzrq,
      estimate: {
        value: asNumber(payload.gsz),
        pct: asNumber(payload.gszzl),
        time: payload.gztime,
        is_estimated: true,
        source: "tiantian_fundgz_browser"
      },
      ok: true,
      stale: false
    };
  }

  function refreshOneFund(code) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const previousCallback = window.jsonpgz;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.remove();
        window.jsonpgz = previousCallback;
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("实时估值超时")), CONFIG.requestTimeoutMs);
      window.jsonpgz = (payload) => {
        const live = mapRealtime(payload || {});
        if (live.code !== code) return;
        state.liveFunds[code] = live;
        const personal = personalByCode(code);
        if (personal && live.name) personal.name = live.name;
        finish(resolve, live);
      };
      script.src = `${REALTIME_URL}/${code}.js?rt=${Date.now()}`;
      script.async = true;
      script.onerror = () => finish(reject, new Error("实时估值加载失败"));
      document.head.appendChild(script);
    });
  }

  async function refreshPersonalFunds() {
    if (!state.data || document.visibilityState === "hidden") return;
    const codes = state.personal.funds.map((fund) => fund.code);
    for (const code of codes) {
      try {
        await refreshOneFund(code);
      } catch (_) {
        // Keep the latest published or locally cached value for individual failures.
      }
    }
    state.lastRealtimeAt = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    savePersonal();
    evaluateAlerts(watchedFunds());
    render();
  }

  function localDateKey() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function evaluateAlerts(funds) {
    (funds || []).filter(Boolean).forEach((fund) => {
      const settings = fund.personal || personalByCode(fund.code);
      if (!settings) return;
      const pct = asNumber((fund.estimate || {}).pct);
      if (pct === null) return;
      const alerts = settings.alerts || {};
      const checks = [
        { direction: "up", threshold: asNumber(alerts.up), hit: (value, threshold) => value >= threshold, label: "上涨" },
        { direction: "down", threshold: asNumber(alerts.down), hit: (value, threshold) => value <= threshold, label: "下跌" }
      ];
      settings.last_alerts = settings.last_alerts || {};
      checks.forEach((check) => {
        if (check.threshold === null || !check.hit(pct, check.threshold)) return;
        const key = `${localDateKey()}:${check.threshold}`;
        if (settings.last_alerts[check.direction] === key) return;
        settings.last_alerts[check.direction] = key;
        const title = `${compactName(fund)} ${check.label}提醒`;
        const body = `当前估值 ${fmtPct(pct)}，已触及 ${fmtPct(check.threshold)}`;
        showToast(`${title}：${body}`);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          if (navigator.serviceWorker && navigator.serviceWorker.ready) {
            navigator.serviceWorker.ready.then((registration) => registration.showNotification(title, { body, tag: `fund-${fund.code}-${check.direction}` })).catch(() => new Notification(title, { body }));
          } else {
            new Notification(title, { body });
          }
        }
      });
    });
    savePersonal();
  }

  const featureReadyTimer = window.setInterval(() => {
    if (!state.data) return;
    window.clearInterval(featureReadyTimer);
    seedPersonalFromPublishedData();
    render();
    refreshPersonalFunds();
    window.setInterval(refreshPersonalFunds, REALTIME_INTERVAL_MS);
  }, 100);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshPersonalFunds();
  });
})();
