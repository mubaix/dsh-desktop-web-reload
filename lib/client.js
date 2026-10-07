// Browser half of dsh-desktop-web-reload: the 「刷新」 button in the DSH Desktop
// Windows caption row, immediately right of 「编辑」.
//
// WHY THIS TOUCHES THE DOM
//
// On Windows the desktop draws its own caption: the Electron preload
// (`app.asar!/lib/preload-app.cjs`, `installWindowsMenu`) creates a
// `<div data-windows-menu>` appended to `document.body`, attaches an **open**
// shadow root, and puts a `role=menubar` row holding 「应用」 and 「编辑」 inside it.
// Those two buttons open NATIVE popups by invoking the `dsh-desktop:windows-menu`
// IPC, whose handler in the Electron main process is hardcoded to the names
// `application` and `edit`.
//
// That menubar is not a Cordis Slot. No Slot in the live tree owns the caption row
// — `shell.leading` is macOS-only and only mounts while the sidebar is collapsed —
// and no shipped Client API registers caption buttons. So the only seam that
// reaches that row is the DOM: an open shadow root is reachable from the page, and
// this plugin appends exactly one button to it.
//
// The consequence, stated plainly: this plugin depends on the shipped caption's
// DOM (the `data-windows-menu` host, its `role=menubar` row, and the
// `dsh-windows-menu-start` custom property the sidebar publishes). It degrades
// quietly — if that host never appears, the plugin installs nothing and the app is
// untouched. It never patches app.asar, so an app update can at worst stop the
// button from appearing; it cannot leave the shell in a broken state.
//
// WHY A RELOAD IS REFUSED WHILE WORK RUNS
//
// A page reload tears down every live Client generation. A Session whose turn is in
// flight keeps running on the Host, but its live stream, queue and scroll state
// belong to the page that just died, so the user loses sight of it. The button is
// therefore disabled while ANY Session reports `running`, and a click is answered
// with a warning instead. `ctx.sessions.list` is the Client's authoritative catalog
// of every Session it knows about, so "全静默" is read as "no row in that catalog is
// running".

window.__ModuleLoader__.load({
  id: 'dsh-desktop-web-reload',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    //#region constants
    /** Dictionary namespace this plugin owns. */
    const NS = 'desktop.webReload';
    /** Test id for the injected button. */
    const BUTTON_TEST_ID = 'dsh-desktop-web-reload-button';
    /** Test id for the injected caption stylesheet. */
    const STYLE_TEST_ID = 'dsh-desktop-web-reload-style';
    /** The shipped caption host the Electron preload appends to `document.body`. */
    const MENU_HOST_SELECTOR = '[data-windows-menu]';
    /** The row inside that host's shadow root. */
    const MENUBAR_SELECTOR = '[role="menubar"]';
    /** Attribute the sidebar sets while it is collapsed. */
    const COLLAPSED_ATTR = 'data-sidebar-collapsed';
    /** How long a refusal warning stays up, in ms. */
    const WARNING_MS = 3200;
    /** How long to keep waiting for the caption host, in ms. */
    const DISCOVERY_BUDGET_MS = 120000;
    /** Poll interval while waiting for the caption host, in ms. */
    const DISCOVERY_POLL_MS = 150;
    /** Popover offset below the button, in px (fallback positioning path). */
    const POPOVER_GAP_PX = 6;
    //#endregion

    //#region copy
    /** Simplified Chinese copy. */
    const zh = {
      refresh: '刷新',
      blocked: '有对话正在运行，刷新会中断它。请等它结束，或先在会话里点停止。',
      blockedMany: '有 {n} 个对话正在运行，刷新会中断它们。请等它们结束再刷新。'
    };
    /** English copy. */
    const en = {
      refresh: 'Reload',
      blocked: 'A conversation is running; reloading would interrupt it. Wait for it to finish, or stop it first.',
      blockedMany: '{n} conversations are running; reloading would interrupt them. Wait for them to finish.'
    };

    /**
     * The dictionary for a locale id, defaulting to Simplified Chinese so the
     * button is never label-less on a locale this plugin does not ship.
     * @param id - the active locale id.
     * @returns the dictionary to read messages from.
     */
    function dictionaryFor(id) {
      return /^en/i.test(id ?? '') ? en : zh;
    }

    /**
     * Resolve the active locale id from the locale service, falling back to the
     * document language and then to Simplified Chinese.
     *
     * Reached through `ctx.get` rather than property access on the locale service, on
     * purpose: Cordis's context proxy throws `cannot get property "locale" without
     * inject` for property access to a service this plugin does not declare, and `?.`
     * does not swallow a `throw`.
     * `ctx.get` resolves the same realm-wide registry and returns `undefined` when the
     * service is absent, which is exactly the tolerance this button needs.
     * @param ctx - the browser plugin context.
     * @returns the active locale id.
     */
    function localeId(ctx) {
      try {
        const locale = ctx.get?.('locale');
        const snapshot = locale?.getSnapshot?.() ?? locale?.getLocale?.();
        if (typeof snapshot?.id === 'string' && snapshot.id !== '') return snapshot.id;
      } catch {
        // An unavailable locale service is not fatal: the caption still needs a label.
      }
      return document.documentElement.lang || navigator.language || 'zh-CN';
    }
    //#endregion

    //#region state
    /**
     * Count the Sessions the Client reports as running right now.
     *
     * The list snapshot is the Client's session catalog: `byId` maps every known
     * Session id to its row, and a row's `running` flag is the Client's reading of
     * the Host's `api-session/status` channel. The read is defensive because it
     * touches another plugin's store — a deployment whose session service is absent
     * or shaped differently must degrade to "assume idle" instead of throwing inside
     * a caption click.
     * @param ctx - the browser plugin context.
     * @returns the number of running Sessions, or 0 when that cannot be read.
     */
    function runningCount(ctx) {
      let rows;
      try {
        const sessions = ctx.sessions ?? ctx.get?.('sessions');
        rows = sessions?.list?.getSnapshot?.()?.byId;
      } catch {
        return 0;
      }
      if (rows === null || typeof rows !== 'object') return 0;
      let count = 0;
      for (const id of Object.keys(rows)) {
        if (rows[id]?.running === true) count += 1;
      }
      return count;
    }

    /**
     * Track the session catalog and the Host's own running-state channel, calling
     * back on any change that could flip the button's state.
     *
     * Two independent signals on purpose. The catalog subscription is the one that
     * normally fires; `api-session/status` is the Host's push of the same fact (the
     * channel `@deepseek-ai/dsh-client-ui-session` folds into its own status store).
     * Subscribing to both means a Client whose catalog lags the Host still disables
     * the button, and if either signal is missing entirely the button degrades to a
     * click-time re-read that still refuses correctly.
     * @param ctx - the browser plugin context.
     * @param onChange - called after any observed change.
     * @returns a disposer releasing both subscriptions.
     */
    function subscribeSessions(ctx, onChange) {
      const disposers = [];
      try {
        const sessions = ctx.sessions ?? ctx.get?.('sessions');
        const stop = sessions?.list?.subscribe?.(() => {
          onChange();
        });
        if (typeof stop === 'function') disposers.push(stop);
      } catch (error) {
        console.warn('dsh-desktop-web-reload: session list subscription failed', error);
      }
      try {
        const stop = ctx.remote?.$on?.('api-session/status', () => {
          onChange();
        });
        if (typeof stop === 'function') disposers.push(stop);
        else if (typeof stop?.dispose === 'function') disposers.push(() => stop.dispose());
      } catch (error) {
        console.warn('dsh-desktop-web-reload: status subscription failed', error);
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (error) {
            console.warn('dsh-desktop-web-reload: subscription teardown failed', error);
          }
        }
      };
    }
    //#endregion

    //#region caption
    /**
     * The caption stylesheet. It restates the shipped menubar's own button rules and
     * adds only what that row does not need: a disabled look and the refusal
     * popover. Every colour is a `--dsw-alias-*` token, so the button follows the
     * app's theme instead of hardcoding a palette; the tokens themselves inherit
     * into the shadow tree from `:root` on the host page.
     *
     * The two states are separated by the widest step the label scale offers, so
     * "can I reload right now?" reads at a glance: `label-primary` (the darkest step
     * — `#0f1115` light, `#f9fafb` dark) while idle, `label-tertiary` (the lightest —
     * `#81858c` light, `#adb2b8` dark) while a Session is running. Because the idle
     * state already carries the strongest colour, hover only adds its background and
     * leaves the text colour alone.
     * @returns the caption style element.
     */
    function createStyle() {
      const style = document.createElement('style');
      style.dataset.testid = STYLE_TEST_ID;
      style.textContent = `
        button[data-dsh-reload] { height: 28px; padding: 0 10px; border: 0; border-radius: 6px;
          background: transparent; color: var(--dsw-alias-label-primary);
          font-family: inherit; font-size: 14px; cursor: default; }
        button[data-dsh-reload]:not([disabled]):hover { background: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-primary); }
        button[data-dsh-reload][disabled] { color: var(--dsw-alias-label-tertiary); cursor: not-allowed; }
        button[data-dsh-reload]:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
        :host-context(html[data-input-modality='pointer']) button[data-dsh-reload]:focus-visible { outline-color: transparent; }
        [data-dsh-reload-warning] { position: fixed; margin: 0; inset: auto; max-width: 340px;
          padding: 8px 12px; border: 0; border-radius: var(--dsw-radius-md, 8px);
          background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base));
          color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 18px;
          box-shadow: 0 6px 24px var(--dsw-alias-bg-mask, rgb(0 0 0 / 24%)); }
        [data-dsh-reload-warning]:not(:popover-open) { display: none; }
      `;
      return style;
    }

    /**
     * Build the refresh button, wired to the same focus-preservation contract the
     * shipped caption buttons use: `pointerdown`/`mousedown` are prevented so
     * clicking the caption never moves focus out of the composer.
     * @param handlers - the refusal and activation handlers.
     * @returns the button element.
     */
    function createButton(handlers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.dshReload = '';
      button.dataset.testid = BUTTON_TEST_ID;
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      const swallow = (event) => {
        event.preventDefault();
      };
      button.addEventListener('pointerdown', swallow);
      button.addEventListener('mousedown', swallow);
      button.addEventListener('click', () => {
        if (button.disabled) handlers.onRefused();
        else handlers.onActivate();
      });
      return button;
    }

    /**
     * Install the button into the shipped caption menubar.
     * @param ctx - the browser plugin context.
     * @returns a disposer removing everything this function added, or undefined when
     *   this deployment has no Windows caption menubar to extend.
     */
    function installCaption(ctx) {
      const host = document.querySelector(MENU_HOST_SELECTOR);
      const shadow = host?.shadowRoot ?? null;
      const bar = shadow?.querySelector(MENUBAR_SELECTOR) ?? null;
      if (host === null || shadow === null || bar === null) return undefined;

      const edit = bar.lastElementChild;
      const root = document.documentElement;
      let sessionCount = runningCount(ctx);
      let dict = dictionaryFor(localeId(ctx));

      // The caption row and the sidebar both sit at the top of the window in normal
      // flow, so the row's left inset is a shared, published value: the sidebar moves
      // it while it is collapsed and never writes it back. Its stylesheet sets
      // `--dsh-windows-menu-start: 84px` only under `:has([data-sidebar-collapsed])`,
      // so once the sidebar expands the property is unset again — and an unset custom
      // property substituted into the host's own `left` makes that declaration invalid
      // at computed-value time, which computes to `auto` and would strand the whole
      // menubar — 「应用」/「编辑」 included — against the left edge. Pinning the value
      // survives that transition, and the fallback reproduces the host's own 48px.
      // Whether the pin is needed depends on how the app was left: a window that
      // starts with the sidebar collapsed mounts the menubar already shifted.
      let shifted = root.getAttribute(COLLAPSED_ATTR) === 'true';
      const expandedInset = '48px';
      /** Drop the pin once the sidebar is expanded again. */
      const restoreInset = () => {
        if (!shifted) return;
        shifted = false;
        host.style.left = expandedInset;
      };
      if (shifted) host.style.left = 'var(--dsh-windows-menu-start, 48px)';

      const style = createStyle();

      // The refusal warning. `popover` puts it in the top layer so the caption's
      // stacking context cannot clip it; the fallback path positions it directly and
      // toggles `display`.
      let warning = null;
      let warningTimer = undefined;
      const blockedText = (count) =>
        count > 1 ? dict.blockedMany.replace('{n}', String(count)) : dict.blocked;
      const placeWarning = () => {
        if (warning === null || typeof warning.showPopover !== 'function') return;
        const rect = button.getBoundingClientRect();
        warning.style.left = `${String(Math.round(rect.left))}px`;
        warning.style.top = `${String(Math.round(rect.bottom + POPOVER_GAP_PX))}px`;
      };
      const hideWarning = () => {
        if (warning === null) return;
        if (typeof warning.hidePopover === 'function' && warning.matches(':popover-open')) warning.hidePopover();
        else warning.style.display = 'none';
      };
      const warn = (count) => {
        if (warning === null) {
          warning = document.createElement('div');
          warning.dataset.dshReloadWarning = '';
          warning.setAttribute('role', 'status');
          warning.setAttribute('popover', 'manual');
          if (typeof warning.showPopover !== 'function') {
            warning.style.position = 'fixed';
            warning.style.zIndex = '1200';
            warning.style.display = 'none';
          }
          shadow.append(warning);
        }
        warning.textContent = blockedText(count);
        placeWarning();
        if (typeof warning.showPopover === 'function') {
          if (!warning.matches(':popover-open')) warning.showPopover();
        } else {
          warning.style.display = '';
        }
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        warningTimer = setTimeout(() => {
          warningTimer = undefined;
          hideWarning();
        }, WARNING_MS);
      };

      /**
       * Resolve one theme token to a concrete colour, measured on the **light** side of
       * the shadow boundary.
       *
       * The stylesheet already asks for these tokens by name, and the preload's own
       * caption buttons rely on the same names resolving inside this shadow tree. This
       * reads them from `document.documentElement` anyway and applies the result as an
       * inline style, because that removes every way the by-name route can silently
       * fail (a token renamed or dropped by a theme, an unset variable substituted into
       * `color` — which is invalid at computed-value time and leaves the button at its
       * UA default, i.e. looking unchanged). An unresolvable token returns undefined and
       * the stylesheet's own rule stands.
       * @param token - the custom property name, including its leading `--`.
       * @returns the resolved colour, or undefined when the token is not set.
       */
      const resolveToken = (token) => {
        try {
          const value = getComputedStyle(root).getPropertyValue(token).trim();
          return value === '' ? undefined : value;
        } catch {
          return undefined;
        }
      };

      /**
       * Paint the two states onto the button.
       *
       * Applied inline so no shadow-tree cascade can win over it, and re-run on every
       * sync so a theme switch (which `theme/change` re-triggers sync for) repaints the
       * button with the new palette.
       * @param busy - whether a Session is running, i.e. the button is disabled.
       */
      const paint = (busy) => {
        const idle = resolveToken('--dsw-alias-label-primary');
        const disabled = resolveToken('--dsw-alias-label-tertiary');
        if (idle === undefined && disabled === undefined) return;
        if (busy) {
          if (disabled !== undefined) button.style.color = disabled;
        } else if (idle !== undefined) {
          button.style.color = idle;
        }
      };

      /** Project the running-session count and the active locale onto the button. */
      const sync = () => {
        sessionCount = runningCount(ctx);
        dict = dictionaryFor(localeId(ctx));
        const busy = sessionCount > 0;
        button.textContent = dict.refresh;
        button.disabled = busy;
        button.setAttribute('aria-disabled', busy ? 'true' : 'false');
        const message = busy ? `${dict.refresh} — ${blockedText(sessionCount)}` : dict.refresh;
        button.title = message;
        button.setAttribute('aria-label', message);
        paint(busy);
        if (!busy) {
          if (warningTimer !== undefined) {
            clearTimeout(warningTimer);
            warningTimer = undefined;
          }
          hideWarning();
        }
      };

      const button = createButton({
        onActivate: () => {
          // Re-read the truth at click time: the disabled look is a projection of this
          // value, but a click can still land between a state change and its repaint.
          const running = runningCount(ctx);
          if (running > 0) {
            sync();
            warn(running);
            return;
          }
          // A reload re-runs the page's boot, which re-reads the profile and re-fetches
          // every Client plugin bundle — that is the whole point of the button.
          window.location.reload();
        },
        onRefused: () => {
          warn(sessionCount > 0 ? sessionCount : runningCount(ctx));
        }
      });
      sync();

      // Immediately right of 「编辑」, which is the row's last button today — so the
      // insertion point is that button's next sibling, and appending is the same
      // thing when there is none (`insertBefore` needs a real node, never null).
      const after = edit?.nextSibling ?? null;
      if (after === null) bar.append(button);
      else bar.insertBefore(button, after);

      // Roving focus over the caption row, extending the shipped left/right
      // behaviour to three buttons: the existing pair only ever knew about two.
      const focusables = () => Array.from(bar.querySelectorAll('button'));
      const onKeydown = (event) => {
        if (event.target !== button) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const all = focusables();
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        const next = all[(all.indexOf(button) + step + all.length) % all.length];
        for (const other of all) other.tabIndex = other === next ? 0 : -1;
        next.focus();
      };
      bar.addEventListener('keydown', onKeydown);

      const unsubscribe = subscribeSessions(ctx, sync);
      const stopLocale = ctx.on?.('locale/change', sync);
      // A theme switch rewrites the alias tokens, so the inline colours `paint()` read
      // have to be re-measured — the button is not a React component and therefore
      // never re-renders on its own.
      const stopTheme = ctx.on?.('theme/change', sync);
      const collapsedObserver = new MutationObserver(() => {
        if (root.getAttribute(COLLAPSED_ATTR) !== 'true') restoreInset();
      });
      collapsedObserver.observe(root, { attributes: true, attributeFilter: [COLLAPSED_ATTR] });

      return () => {
        collapsedObserver.disconnect();
        bar.removeEventListener('keydown', onKeydown);
        if (typeof stopLocale === 'function') stopLocale();
        if (typeof stopTheme === 'function') stopTheme();
        unsubscribe();
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        warning?.remove();
        button.remove();
        style.remove();
        restoreInset();
      };
    }

    /**
     * Wait for the shipped caption menubar, then install the button into it.
     *
     * The preload appends its host only once `[data-shell-overlay]` exists — the
     * mounted application frame — which is strictly after this plugin's `apply` runs.
     * So discovery has to be reactive: a `MutationObserver` for the insertion, plus a
     * bounded poll as a cheap belt-and-braces for a host inserted before the observer
     * attached.
     * @param ctx - the browser plugin context.
     * @returns a disposer ending discovery and removing an installed button.
     */
    function mountWhenAvailable(ctx) {
      let dispose;
      let observer = null;
      let poll;
      let deadline = 0;
      const finish = () => {
        observer?.disconnect();
        observer = null;
        if (poll !== undefined) clearInterval(poll);
        poll = undefined;
      };
      const attempt = () => {
        if (dispose !== undefined) {
          finish();
          return true;
        }
        const installed = installCaption(ctx);
        if (installed === undefined) return false;
        dispose = installed;
        finish();
        return true;
      };
      if (attempt()) {
        return () => {
          dispose?.();
          dispose = undefined;
        };
      }
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {
          attempt();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
      deadline = Date.now() + DISCOVERY_BUDGET_MS;
      poll = setInterval(() => {
        if (attempt() || Date.now() > deadline) finish();
      }, DISCOVERY_POLL_MS);
      return () => {
        finish();
        dispose?.();
        dispose = undefined;
      };
    }
    //#endregion

    //#region plugin
    /**
     * Required services. `sessions` is the running-state source and `remote` carries
     * the Host's own status channel. The locale service is read through `ctx.get`
     * instead and is deliberately not required: the button still gets a label from
     * the document language when that service is absent.
     */
    const inject = ['sessions', 'remote'];

    /**
     * Mount the caption button while the desktop shell is present.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      // `data-windows-titlebar` is set by the desktop preload on Windows only, and
      // `dshPlatform` is exposed by the desktop preload only. Both are checked so a
      // plain `dsh web` / browser session — which has no caption row to extend —
      // installs nothing at all.
      const desktopShell =
        globalThis.dshPlatform !== undefined || document.documentElement.hasAttribute('data-windows-titlebar');
      if (!desktopShell) return;

      try {
        ctx.effect(() => ctx.get?.('locale')?.register?.(NS, { zh, en }), 'desktop-web-reload: dictionaries');
      } catch (error) {
        console.warn('dsh-desktop-web-reload: locale registration failed', error);
      }

      ctx.effect(() => mountWhenAvailable(ctx), 'dsh-desktop-web-reload: caption button');
    }
    //#endregion

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.runningCount = runningCount;
    exports.dictionaryFor = dictionaryFor;
    exports.mountWhenAvailable = mountWhenAvailable;
    return module.exports;
  }
});
