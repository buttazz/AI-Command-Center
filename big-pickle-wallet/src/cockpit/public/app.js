/* Big Pickle simulation cockpit — vanilla JS view.
 *
 * SIMULATION / PAPER TRADING ONLY. This file renders numbers produced by the
 * local simulation API. It never calls anything off-box: every request goes to
 * the same loopback origin that served this page.
 */
(function () {
  "use strict";

  var POLL_MS = 1000;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function metric(label, value, tone) {
    var box = el("div", "metric");
    box.appendChild(el("span", "k", label));
    var v = el("span", "v", value);
    if (tone) v.classList.add(tone);
    box.appendChild(v);
    return box;
  }

  function toneFor(value) {
    var n = Number(value);
    if (Number.isNaN(n) || n === 0) return "flat";
    return n > 0 ? "up" : "down";
  }

  function signed(value, suffix) {
    var n = Number(value);
    if (Number.isNaN(n)) return String(value);
    return (n > 0 ? "+" : "") + value + (suffix || "");
  }

  function renderTicker(state) {
    var ticker = document.getElementById("ticker");
    if (!ticker) return;
    ticker.innerHTML = "";
    ticker.appendChild(el("span", "ticker-label", "SYNTHETIC FEED (not a real market)"));
    (state.market && state.market.quotes ? state.market.quotes : []).forEach(function (q) {
      var wrap = el("span", "quote");
      wrap.appendChild(el("span", "sym", q.symbol));
      wrap.appendChild(el("span", "", "$" + q.priceUsdc));
      wrap.appendChild(
        el("span", q.changeBps > 0 ? "up" : q.changeBps < 0 ? "down" : "flat", signed(q.changeBps, " bps"))
      );
      ticker.appendChild(wrap);
    });
  }

  function section(title) {
    var s = el("section", "section");
    s.appendChild(el("h3", "", title));
    return s;
  }

  function renderPositions(account) {
    var s = section("Positions (" + account.positions.length + ")");
    if (account.positions.length === 0) {
      s.appendChild(el("p", "empty", "No open paper positions."));
      return s;
    }
    var table = el("table");
    var head = el("tr");
    ["Symbol", "Qty", "Avg entry", "Mark", "Cost", "Value", "uP&L", "bps"].forEach(function (h) {
      head.appendChild(el("th", "", h));
    });
    table.appendChild(head);
    account.positions.forEach(function (p) {
      var row = el("tr");
      row.appendChild(el("td", "", p.symbol));
      row.appendChild(el("td", "", p.qty));
      row.appendChild(el("td", "", "$" + p.avgEntryUsdc));
      row.appendChild(el("td", "", "$" + p.markUsdc));
      row.appendChild(el("td", "", "$" + p.costBasisUsdc));
      row.appendChild(el("td", "", "$" + p.markValueUsdc));
      row.appendChild(el("td", toneFor(p.unrealizedPnlBps), signed(p.unrealizedPnlUsdc)));
      row.appendChild(el("td", toneFor(p.unrealizedPnlBps), signed(p.unrealizedPnlBps)));
      table.appendChild(row);
    });
    s.appendChild(table);
    return s;
  }

  function renderDecisions(account) {
    var title =
      account.id === "constitution"
        ? "Constitution decisions (newest first)"
        : "Recent decisions (newest first)";
    var s = section(title);

    if (account.id === "constitution") {
      var chips = el("div", "chips");
      ["APPROVED", "RESIZED", "VETOED", "NO_TRADE", "PAPER_EXIT"].forEach(function (key) {
        var chip = el(
          "span",
          "chip " + key.toLowerCase(),
          key.replace("_", " ") + ": " + (account.decisionCounts[key] || 0)
        );
        chips.appendChild(chip);
      });
      s.appendChild(chips);
    }

    if (!account.decisions.length) {
      s.appendChild(el("p", "empty", "No decisions yet — advance the simulation."));
      return s;
    }
    var list = el("ul", "list");
    account.decisions.forEach(function (d) {
      var li = el("li");
      var head = el("div", "head");
      head.appendChild(el("span", "verdict " + d.verdict, d.verdict));
      head.appendChild(el("span", "ref", d.id));
      head.appendChild(el("span", "", "tick " + d.tick));
      if (d.symbol) head.appendChild(el("span", "", d.symbol));
      if (d.finalBps !== null && d.finalBps !== undefined) {
        head.appendChild(el("span", "", d.finalBps + " bps"));
      }
      if (d.notionalUsdc) head.appendChild(el("span", "", "$" + d.notionalUsdc));
      li.appendChild(head);
      if (d.paperRef) li.appendChild(el("div", "ref", d.paperRef + " (paper)"));
      if (d.reasons && d.reasons.length) {
        var ul = el("ul", "reasons");
        d.reasons.forEach(function (r) {
          ul.appendChild(el("li", "", r));
        });
        li.appendChild(ul);
      }
      if (d.rule && d.rule !== "none") li.appendChild(el("div", "ref", "rule: " + d.rule));
      list.appendChild(li);
    });
    s.appendChild(list);
    return s;
  }

  function renderActivity(account) {
    var s = section("Activity feed (audit chain)");
    if (!account.activity.length) {
      s.appendChild(el("p", "empty", "Nothing audited yet."));
      return s;
    }
    var list = el("ul", "list");
    account.activity.forEach(function (a) {
      var li = el("li");
      var head = el("div", "head");
      head.appendChild(el("span", "ref", a.action));
      head.appendChild(el("span", "", a.actor));
      head.appendChild(el("span", "", a.at.slice(11, 19)));
      li.appendChild(head);
      li.appendChild(el("div", "reasons", a.summary));
      list.appendChild(li);
    });
    s.appendChild(list);
    return s;
  }

  function renderControl(account) {
    var s = section("Control plane (kill / freeze / de-risk)");
    var grid = el("div", "control-grid");

    function cell(label, value) {
      var d = el("div");
      d.appendChild(el("span", "", label));
      d.appendChild(document.createTextNode(value));
      grid.appendChild(d);
    }

    cell("State", account.control.state.toUpperCase());
    cell("Kill switch", account.control.killSwitchEngaged ? "ENGAGED" : "off");
    cell("Freeze", account.control.frozen ? "FROZEN" : "clear");
    cell("Cooldown", account.control.cooldownUntil || "none");
    cell("Daily loss response", account.control.dailyLossResponse);
    cell("Remaining daily loss budget", "$" + account.remainingDailyLossBudgetUsdc);
    cell("Drawdown", account.drawdownBps + " / " + account.maxDailyDrawdownBps + " bps");
    cell("Gross deployed today", "$" + account.control.deployedTodayUsdc);
    cell("Trades today", account.control.tradeCountToday);
    if (account.id === "sovereign") {
      cell(
        "Owner mode",
        account.ownerOverride && account.ownerOverride.active ? "OWNER_OVERRIDE" : "normal owner controls"
      );
      if (account.ownerOverride && account.ownerOverride.at) {
        cell("Override since", account.ownerOverride.at.slice(11, 19) + "Z");
      }
    }
    if (account.control.killSwitchReason) cell("Kill reason", account.control.killSwitchReason);
    if (account.control.freezeReason) cell("Freeze reason", account.control.freezeReason);
    s.appendChild(grid);

    var actions = el("div", "control-actions");
    [
      ["kill", "Engage kill switch", "danger"],
      ["release", "Release kill switch", ""],
      ["freeze", "Trip freeze", "danger"],
      ["resume", "Resume from freeze", ""],
    ].forEach(function (spec) {
      var btn = el("button", spec[2], spec[1]);
      btn.type = "button";
      btn.setAttribute("data-control", spec[0]);
      btn.setAttribute("data-account", account.id);
      actions.appendChild(btn);
    });
    if (account.id === "sovereign") {
      var override = el(
        "button",
        "owner-override",
        account.ownerOverride && account.ownerOverride.active
          ? "OWNER FORCE RESUME (ACTIVE)"
          : "OWNER FORCE RESUME"
      );
      override.type = "button";
      override.setAttribute("data-owner-force-resume", "sovereign");
      actions.appendChild(override);
    }
    s.appendChild(actions);
    return s;
  }

  function renderTarget(account) {
    var t = account.target;
    var s = section("Target — settled cash $" + t.targetCashUsdc);
    if (!t) {
      s.appendChild(el("p", "empty", "No target configured for this account."));
      return s;
    }
    if (t.status === "REACHED") s.classList.add("target-reached");

    var bar = el("div", "progress");
    var fill = el("div", "progress-fill");
    var pct = Math.max(0, Math.min(100, t.progressPct));
    fill.style.width = pct + "%";
    if (t.status === "REACHED") fill.classList.add("done");
    bar.appendChild(fill);
    s.appendChild(bar);

    var grid = el("div", "target-grid");
    function cell(label, value, cls) {
      var d = el("div", "target-cell");
      d.appendChild(el("span", "k", label));
      var v = el("span", "v" + (cls ? " " + cls : ""), value);
      d.appendChild(v);
      grid.appendChild(d);
    }

    cell("START", "$" + account.startingBalanceUsdc);
    cell("TARGET CASH", "$" + t.targetCashUsdc, "target-cash");
    cell("CURRENT CASH", "$" + t.currentCashUsdc, "target-current");
    cell("PROGRESS TO TARGET", t.progressPct.toFixed(2) + " %", t.status === "REACHED" ? "up" : "");
    cell("AMOUNT REMAINING", "$" + t.remainingUsdc);
    cell("TARGET STATUS", t.status, t.status === "REACHED" ? "up" : "flat");
    cell("ELAPSED", t.elapsedTicks + " ticks · " + Math.round(t.elapsedWallMs / 1000) + "s");
    s.appendChild(grid);

    s.appendChild(
      el(
        "p",
        "note",
        "Counts free settled cash only — not open-position value, unrealised P&L or turnover. " +
          "Reaching the target locks new positions; it never changes sizing or risk limits."
      )
    );

    if (t.status === "REACHED" && t.final) {
      var f = t.final;
      var fin = el("div", "target-final");
      fin.appendChild(el("h4", "", "TARGET REACHED at tick " + f.tick));
      var fg = el("div", "target-grid");
      function fcell(label, value, cls) {
        var d = el("div", "target-cell");
        d.appendChild(el("span", "k", label));
        d.appendChild(el("span", "v" + (cls ? " " + cls : ""), value));
        fg.appendChild(d);
      }
      fcell("Final cash", "$" + f.cashUsdc, "up");
      fcell("Final equity", "$" + f.equityUsdc);
      fcell("Total P&L", signed(f.totalPnlUsdc), toneFor(f.totalPnlUsdc));
      fcell("Return", signed(f.returnBps, " bps"), toneFor(f.returnBps));
      fcell("Drawdown", f.drawdownBps + " / max " + f.maxDrawdownBps + " bps");
      fcell("Closed trades", f.closedTrades);
      fcell("Paper fills", f.paperFills);
      fcell("Gross turnover", "$" + f.grossTurnoverUsdc);
      fcell("Elapsed", f.elapsedTicks + " ticks");
      fcell("Positions left open", f.openPositionsAtReach);
      fin.appendChild(fg);

      if (t.ownerSweep) {
        var sw = el("div", "sweep");
        sw.appendChild(el("h4", "", "OWNER SWEEP — PREPARED, NOT EXECUTED"));
        var sg = el("div", "target-grid");
        var sd = el("div", "target-cell");
        sd.appendChild(el("span", "k", "Sweepable cash"));
        sd.appendChild(el("span", "v", "$" + t.ownerSweep.sweepableCashUsdc));
        sg.appendChild(sd);
        var rd = el("div", "target-cell");
        rd.appendChild(el("span", "k", "Retained for open positions"));
        rd.appendChild(el("span", "v", "$" + t.ownerSweep.retainedForOpenPositionsUsdc));
        sg.appendChild(rd);
        var ed = el("div", "target-cell");
        ed.appendChild(el("span", "k", "Executed"));
        ed.appendChild(el("span", "v down", "NO — simulation only"));
        sg.appendChild(ed);
        sw.appendChild(sg);
        sw.appendChild(el("p", "note", t.ownerSweep.note));
        fin.appendChild(sw);
      }
      s.appendChild(fin);
    }
    return s;
  }

  function renderAccount(account) {
    var card = el("article", "card");
    card.id = "account-" + account.id;

    var head = el("div", "card-head");
    var titleBox = el("div");
    titleBox.appendChild(el("h2", "", account.label));
    titleBox.appendChild(
      el("div", "sub", account.root + (account.simulation ? " · simulation root" : ""))
    );
    head.appendChild(titleBox);
    var chipClass =
      account.ownerOverride && account.ownerOverride.active
        ? "state-chip owner-override"
        : account.control.state === "frozen"
        ? "state-chip frozen"
        : account.control.state === "de-risk"
          ? "state-chip derisk"
          : "state-chip";
    head.appendChild(
      el(
        "span",
        chipClass,
        account.ownerOverride && account.ownerOverride.active
          ? "OWNER_OVERRIDE"
          : account.control.state.toUpperCase()
      )
    );
    card.appendChild(head);

    card.appendChild(el("div", "mode", account.mode));

    var metrics = el("div", "metrics");
    metrics.appendChild(metric("Starting balance", "$" + account.startingBalanceUsdc));
    metrics.appendChild(metric("Current equity", "$" + account.equityUsdc));
    metrics.appendChild(metric("Cash", "$" + account.cashUsdc));
    metrics.appendChild(
      metric("Realized P&L", signed(account.realizedPnlUsdc), toneFor(account.realizedPnlUsdc))
    );
    metrics.appendChild(
      metric("Unrealized P&L", signed(account.unrealizedPnlUsdc), toneFor(account.unrealizedPnlUsdc))
    );
    metrics.appendChild(
      metric("Total P&L", signed(account.totalPnlUsdc), toneFor(account.totalPnlUsdc))
    );
    metrics.appendChild(metric("Return", signed(account.returnBps, " bps"), toneFor(account.returnBps)));
    metrics.appendChild(
      metric("Drawdown", account.drawdownBps + " bps", account.drawdownBps > 0 ? "down" : "flat")
    );
    metrics.appendChild(metric("Trade count", account.tradeCount));
    metrics.appendChild(metric("Paper fills", account.fillCount));
    metrics.appendChild(metric("Gross deployed / turnover", "$" + account.grossTurnoverUsdc));
    metrics.appendChild(metric("Max drawdown", account.maxDrawdownBps + " bps", account.maxDrawdownBps > 0 ? "down" : "flat"));
    metrics.appendChild(
      metric("Deployable cash", "$" + account.deployableUsdc)
    );
    metrics.appendChild(metric("Open positions", account.positions.length));
    metrics.appendChild(metric("Audit chain", account.audit.ok ? "intact" : "BROKEN", account.audit.ok ? "up" : "down"));
    card.appendChild(metrics);

    card.appendChild(renderTarget(account));
    card.appendChild(renderControl(account));
    card.appendChild(renderPositions(account));
    card.appendChild(renderDecisions(account));
    card.appendChild(renderActivity(account));
    return card;
  }

  function render(state) {
    renderTicker(state);
    var tick = document.getElementById("tick");
    if (tick) tick.textContent = state.tick;
    var updated = document.getElementById("updated");
    if (updated) updated.textContent = state.serverTime.slice(11, 19) + "Z";
    var disclaimer = document.getElementById("disclaimer");
    if (disclaimer && state.disclaimer) disclaimer.textContent = state.disclaimer;

    var host = document.getElementById("accounts");
    if (!host) return;
    var focus = document.activeElement && document.activeElement.blur ? document.activeElement : null;
    host.innerHTML = "";
    (state.accounts || []).forEach(function (account) {
      host.appendChild(renderAccount(account));
    });
    if (focus && focus.blur) focus.blur();
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false };
      });
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var global = target.getAttribute("data-global");
    if (global === "step") {
      post("/api/sim/step", {}).then(refresh);
      return;
    }
    if (global === "reset") {
      if (window.confirm("Reset BOTH simulation books? Audit history is preserved.")) {
        post("/api/sim/reset", { account: "all" }).then(refresh);
      }
      return;
    }
    var action = target.getAttribute("data-control");
    var account = target.getAttribute("data-account");
    var ownerForceResume = target.getAttribute("data-owner-force-resume");
    if (ownerForceResume === "sovereign") {
      if (!window.confirm("OWNER FORCE RESUME SOVEREIGN? This clears only its paper cooldown.")) return;
      var overrideReason = window.prompt(
        "Owner reason (recorded as OWNER_OVERRIDE in the SOVEREIGN paper audit):",
        "manual owner force resume"
      );
      if (overrideReason === null) return;
      post("/api/sim/sovereign/force-resume", {
        confirmation: "OWNER_FORCE_RESUME",
        reason: overrideReason || "manual owner force resume",
      }).then(function (result) {
        if (!result || !result.ok) {
          window.alert((result && result.error) || "OWNER_FORCE_RESUME was refused");
        }
        return refresh();
      });
      return;
    }
    if (action && account) {
      var reason = window.prompt("Reason (recorded in the simulation audit log):", "cockpit button");
      if (reason === null) return;
      post("/api/sim/control", {
        account: account,
        action: action,
        reason: reason || "cockpit button",
      }).then(refresh);
    }
  });

  function refresh() {
    return fetch("/api/state", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        render(data);
        lastError = null;
      })
      .catch(function (err) {
        lastError = err;
        var host = document.getElementById("accounts");
        if (host && !host.children.length) {
          host.appendChild(el("p", "empty", "Waiting for the local simulation API…"));
        }
      });
  }

  var lastError = null;
  refresh();
  setInterval(refresh, POLL_MS);
})();
