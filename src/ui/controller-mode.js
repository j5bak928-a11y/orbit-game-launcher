(() => {
	const escapeHtml = (value) =>
		String(value ?? "").replace(
			/[&<>"']/g,
			(char) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[char],
		);
	const t = (key, params = {}) => {
		const translated = window.OrbitI18n?.t?.(key, params);
		return String(translated ?? key).replace(
			/\{([a-zA-Z]+)\}/g,
			(match, name) =>
				Object.hasOwn(params, name) ? String(params[name]) : match,
		);
	};
	const formatNumber = (value) =>
		window.OrbitI18n?.formatNumber?.(value) ?? String(value);
	const formatDate = (value) =>
		window.OrbitI18n?.formatDate?.(value) ??
		new Date(value).toLocaleDateString();
	const art = (token) =>
		/^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token || "")
			? window.OrbitArtworkUrl?.(token) || `orbit-art://file/${token}`
			: "";
	const sources = {
		steam: "Steam",
		epic: "Epic Games",
		gog: "GOG",
		xbox: "Xbox / PC Game Pass",
		ea: "EA app",
		ubisoft: "Ubisoft Connect",
		battlenet: "Battle.net",
		folder: "Local",
		manual: "Manual",
	};
	const PLAY_STATUSES = [
		["playing", "Currently Playing"],
		["backlog", "Backlog"],
		["completed", "Completed"],
		["on_hold", "On Hold"],
	];
	const STATUS_LABELS = Object.fromEntries(PLAY_STATUSES);
	const SORT_OPTIONS = [
		["name", "A–Z"],
		["recent", "Recently played"],
		["time", "Most played"],
		["added", "Recently added"],
	];
	const SORT_LABELS = Object.fromEntries(SORT_OPTIONS);
	const KEYBOARD_ROWS = [
		["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
		["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
		["A", "S", "D", "F", "G", "H", "J", "K", "L"],
		["Z", "X", "C", "V", "B", "N", "M"],
	];
	const HEART_SVG =
		'<svg class="tv-heart-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
	const statusLabel = (code) =>
		STATUS_LABELS[code] ? t(STATUS_LABELS[code]) : "";
	const sourceName = (source, fallback = "Game") =>
		["folder", "manual"].includes(source)
			? t(sources[source])
			: sources[source] || t(fallback);
	const played = (seconds) =>
		seconds >= 3600
			? t("{count}h played", {
					count: formatNumber(Math.floor(seconds / 3600)),
				})
			: seconds
				? t("{count}m played", {
						count: formatNumber(Math.max(1, Math.round(seconds / 60))),
					})
				: t("No playtime recorded");
	const sanitizeFilter = (value) => {
		if (typeof value !== "string") return "all";
		if (value === "all" || value === "favorites" || value === "hidden")
			return value;
		if (
			value.startsWith("status:") &&
			Object.hasOwn(STATUS_LABELS, value.slice(7))
		)
			return value;
		if (value.startsWith("collection:") && value.length > 11 && value.length < 80)
			return value;
		return "all";
	};
	const sanitizeSort = (value) =>
		Object.hasOwn(SORT_LABELS, value) ? value : "name";
	const sanitizeQuery = (value) =>
		typeof value === "string" ? value.slice(0, 80) : "";

	class ControllerMode {
		constructor(options) {
			this.options = options;
			this.active = false;
			this.session = null;
			this.transitions = Promise.resolve();
			this.returnWrites = Promise.resolve();
			this.input = new window.OrbitControllerInput.GamepadInput();
			this.frame = null;
			this.timer = null;
			this.renderFrame = null;
			this.revealFocusAfterResize = false;
			this.filter = "all";
			this.sort = "name";
			this.query = "";
			this.showHidden = false;
			this.page = 0;
			this.gamesRef = null;
			this.collectionsRef = null;
			this.collections = [];
			this.collectionById = new Map();
			this.collectionGamesById = new Map();
			this.byId = new Map();
			this.allVisible = [];
			this.allWithHidden = [];
			this.hiddenGames = [];
			this.all = [];
			this.favorites = [];
			this.recent = [];
			this.detailId = null;
			this.overlay = null;
			this.overlayDialog = null;
			this.overlaySignature = "";
			this.dismissedBannerKey = "";
			this.bannerMarkup = "";
			this.activeBarMarkup = "";
			this.lastKey = "";
			this.lastPadAction = 0;
			this.detailSignature = "";
			this.launchInFlight = false;
			this.launchGameId = null;
			this.recentMarkup = "";
			this.libraryMarkup = "";
			this.alphaMarkup = "";
			this.statusKind = "none";
			this.statusOwner = null;
			this.statusFamily = "Standard";
			this.noticeTimer = null;
			this.audioCtx = null;
		}
		enter(returnPosition = null) {
			if (this.session) return this.session.promise;
			const session = { cancelled: false, touched: false, previous: false };
			this.session = session;
			const task = this.transitions
				.catch(() => {})
				.then(async () => {
					try {
						const state = await this.options.api.getWindowState();
						session.previous =
							typeof returnPosition?.previousFullscreen === "boolean"
								? returnPosition.previousFullscreen
								: !!state.fullscreen;
						if (session.cancelled) return;
						session.touched = true;
						await this.options.api.setFullscreen(true);
						if (session.cancelled) return;
						this.active = true;
						this.mount(returnPosition);
					} catch (error) {
						if (this.session === session) {
							this.session = null;
							this.active = false;
							this.unmount();
							this.options.onExit();
						}
						if (session.touched)
							await this.options.api
								.setFullscreen(session.previous)
								.catch(() => {});
						throw error;
					}
				});
			session.promise = task;
			this.transitions = task;
			return task;
		}
		toggle() {
			return this.session ? this.exit() : this.enter();
		}
		exit({ restoreFullscreen = true } = {}) {
			const session = this.session;
			if (!session) return Promise.resolve();
			session.cancelled = true;
			this.session = null;
			this.active = false;
			this.clearLaunchReturn();
			this.unmount();
			this.options.onExit();
			const task = this.transitions
				.catch(() => {})
				.then(() =>
					session.touched && restoreFullscreen
						? this.options.api.setFullscreen(session.previous)
						: undefined,
				);
			this.transitions = task;
			return task;
		}
		windowState(state) {
			if (state.fullscreen === false && this.active)
				this.exit({ restoreFullscreen: false }).catch((error) =>
					this.notify(error.message),
				);
		}
		notify(message) {
			if (this.notice) {
				if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
				this.notice.textContent = message;
				this.noticeTimer = setTimeout(() => {
					this.noticeTimer = null;
					if (this.notice && this.notice.textContent === message)
						this.notice.textContent = "";
				}, 3500);
			} else this.options.notify?.(message, true);
		}
		glyphs() {
			if (this.statusFamily === "Xbox") {
				return {
					select: "A",
					back: "B",
					fav: "X",
					recent: "Y",
					pages: "LB / RB",
					scroll: "RS ↕",
					search: "L3",
					browse: "R3",
				};
			}
			if (this.statusFamily === "PlayStation") {
				return {
					select: "×",
					back: "○",
					fav: "□",
					recent: "△",
					pages: "L1 / R1",
					scroll: "RS ↕",
					search: "L3",
					browse: "R3",
				};
			}
			return {
				select: "A / ×",
				back: "B / ○",
				fav: "X / □",
				recent: "Y / △",
				pages: "LB / RB",
				scroll: "RS ↕",
				search: "L3",
				browse: "R3",
			};
		}
		isGameBusy() {
			return !!(
				this.launchInFlight ||
				this.snapshot?.runningIds?.length ||
				this.snapshot?.pendingLaunches?.size
			);
		}
		playCue(kind) {
			if (
				!this.active ||
				!this.snapshot?.settings?.controllerAudio ||
				document.hidden ||
				!document.hasFocus()
			)
				return;
			if (kind !== "launch" && this.isGameBusy()) return;
			const AudioCtor =
				typeof window !== "undefined" &&
				(window.AudioContext || window.webkitAudioContext);
			if (!AudioCtor) return;
			try {
				if (!this.audioCtx) this.audioCtx = new AudioCtor();
				if (this.audioCtx.state === "suspended")
					void this.audioCtx.resume().catch(() => {});
				const now = this.audioCtx.currentTime;
				const sequences = {
					move: [[440, 0.024, 0.022, 0]],
					toggle: [[587, 0.032, 0.028, 0]],
					confirm: [
						[523, 0.036, 0.03, 0],
						[659, 0.044, 0.03, 0.03],
					],
					back: [
						[466, 0.032, 0.028, 0],
						[349, 0.042, 0.024, 0.028],
					],
					launch: [
						[440, 0.05, 0.038, 0],
						[554, 0.05, 0.038, 0.042],
						[659, 0.085, 0.042, 0.085],
					],
				};
				const notes = sequences[kind] || sequences.move;
				for (const [freq, dur, peak, offset] of notes) {
					const osc = this.audioCtx.createOscillator();
					const gain = this.audioCtx.createGain();
					osc.type = kind === "launch" ? "triangle" : "sine";
					osc.frequency.setValueAtTime(freq, now + offset);
					gain.gain.setValueAtTime(0.0001, now + offset);
					gain.gain.exponentialRampToValueAtTime(peak, now + offset + 0.008);
					gain.gain.exponentialRampToValueAtTime(
						0.0001,
						now + offset + dur,
					);
					osc.connect(gain);
					gain.connect(this.audioCtx.destination);
					osc.start(now + offset);
					osc.stop(now + offset + dur + 0.01);
				}
			} catch {
				// Audio cues are optional and must never block navigation or launch.
			}
		}
		pulseHaptic(kind) {
			if (
				!this.active ||
				!this.snapshot?.settings?.controllerHaptics ||
				document.hidden ||
				!document.hasFocus()
			)
				return;
			if (kind !== "launch" && this.isGameBusy()) return;
			if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function")
				return;
			try {
				const pads = navigator.getGamepads();
				const standard = [];
				for (let index = 0; index < Math.min(Number(pads?.length) || 0, 16); index++) {
					const candidate = pads[index];
					if (candidate?.connected && candidate.mapping === "standard")
						standard.push(candidate);
				}
				const target =
					standard.find((p) => `${p.index}:${p.id}` === this.input.owner) ||
					(standard.length === 1 ? standard[0] : null);
				if (!target) return;
				const duration = kind === "launch" ? 75 : 32;
				const weak = kind === "launch" ? 0.28 : 0.14;
				const strong = kind === "launch" ? 0.14 : 0;
				if (typeof target.vibrationActuator?.playEffect === "function") {
					Promise.resolve(
						target.vibrationActuator.playEffect("dual-rumble", {
							startDelay: 0,
							duration,
							weakMagnitude: weak,
							strongMagnitude: strong,
						}),
					).catch(() => {});
				} else if (typeof target.hapticActuators?.[0]?.pulse === "function") {
					Promise.resolve(
						target.hapticActuators[0].pulse(weak, duration),
					).catch(() => {});
				}
			} catch {
				// Haptics are optional and hardware-dependent.
			}
		}
		mount(returnPosition) {
			this.filter = "all";
			this.sort = "name";
			this.query = "";
			this.showHidden = false;
			this.page = 0;
			this.detailId = null;
			this.overlay = null;
			this.overlaySignature = "";
			this.dismissedBannerKey = "";
			this.bannerMarkup = "";
			this.activeBarMarkup = "";
			this.lastKey = "";
			this.lastPadAction = 0;
			this.detailSignature = "";
			this.launchInFlight = false;
			this.launchGameId = null;
			this.cardPosition = null;
			this.launchReturn = null;
			this.recentMarkup = "";
			this.libraryMarkup = "";
			this.alphaMarkup = "";
			this.statusKind = "none";
			this.statusOwner = null;
			this.statusFamily = "Standard";
			this.abort = new AbortController();
			const signal = this.abort.signal;
			this.inertRecords = ["app", "modal-root"]
				.map((id) => document.getElementById(id))
				.filter(Boolean)
				.map((node) => ({ node, inert: node.inert }));
			for (const { node } of this.inertRecords) node.inert = true;
			document.body.dataset.controllerMode = "true";
			this.root = document.createElement("section");
			this.root.id = "controller-root";
			this.root.className = "controller-shell";
			this.root.setAttribute("role", "dialog");
			this.root.setAttribute("aria-modal", "true");
			this.root.innerHTML = `<div class="tv-stage"><header class="tv-header"><div class="tv-brand"><span class="tv-brand-lockup" role="img" aria-label="Orbit Launcher"><img class="orbit-brand-mark tv-brand-mark" src="../../assets/branding/orbit-generated-mark.png" alt=""/><span class="orbit-brand-word tv-brand-word" aria-hidden="true">orbit</span></span><span data-tv-i18n="CONTROLLER MODE">CONTROLLER MODE</span></div><div class="tv-header-actions"><span class="tv-controller-status" role="status">Keyboard ready · connect a controller</span><button class="tv-focus tv-exit" data-tv-key="exit" data-tv-action="exit" data-tv-i18n="Exit controller mode">Exit controller mode <span>Esc</span></button></div></header><main class="tv-main"><div class="tv-banner-slot"></div><div class="tv-recent-slot"></div><section class="tv-library-section" data-tv-aria="Game library" aria-label="Game library"><div class="tv-library-heading"><div><p class="tv-eyebrow" data-tv-i18n="ONE HOME. EVERY GAME.">ONE HOME. EVERY GAME.</p><h1 data-tv-i18n="Your library">Your library <span class="tv-total"></span></h1></div><div class="tv-tabs" role="group" data-tv-aria="Choose collection" aria-label="Choose collection"><button class="tv-focus" data-tv-key="filter:all" data-tv-action="filter" data-tv-filter="all" data-tv-i18n="All games">All games</button><button class="tv-focus" data-tv-key="filter:favorites" data-tv-action="filter" data-tv-filter="favorites" data-tv-i18n="Favorites">Favorites</button><button class="tv-focus tv-tab-utility" data-tv-key="drawer:open" data-tv-action="openDrawer" aria-haspopup="dialog" aria-expanded="false" data-tv-i18n="Browse">Browse</button><button class="tv-focus tv-tab-utility" data-tv-key="search:open" data-tv-action="openSearch" aria-haspopup="dialog" aria-expanded="false" data-tv-i18n="Search">Search</button></div></div><div class="tv-active-filters-slot"></div><div class="tv-alpha-jump-slot"></div><div class="tv-library-slot"></div><div class="tv-pagination"><span class="tv-page-label"></span><div><button class="tv-focus" data-tv-key="page:previous" data-tv-action="previousPage" data-tv-aria="Previous page" aria-label="Previous page" data-tv-i18n="← Previous">← Previous</button><button class="tv-focus" data-tv-key="page:next" data-tv-action="nextPage" data-tv-aria="Next page" aria-label="Next page" data-tv-i18n="Next →">Next →</button></div></div></section></main><footer class="tv-footer"><div class="tv-selected">Choose something to play.</div><div class="tv-hints"></div></footer></div><div class="tv-detail-slot"></div><dialog class="tv-overlay-dialog" closedby="any" aria-labelledby="tv-overlay-title"></dialog><div class="tv-notice" role="status" aria-live="polite"></div>`;
			document.body.appendChild(this.root);
			this.stage = this.root.querySelector(".tv-stage");
			this.notice = this.root.querySelector(".tv-notice");
			this.overlayDialog = this.root.querySelector(".tv-overlay-dialog");
			this.bindOverlayDialog(signal);
			this.localizeShell();
			this.root.addEventListener(
				"click",
				(event) => {
					const button = event.target.closest("[data-tv-action]");
					if (
						!button ||
						button.disabled ||
						button.getAttribute("aria-disabled") === "true"
					)
						return;
					event.preventDefault();
					this.act(button.dataset.tvAction, button).catch((error) =>
						this.notify(error.message),
					);
				},
				{ signal },
			);
			this.root.addEventListener(
				"focusin",
				(event) => this.focused(event.target),
				{ signal },
			);
			this.root.addEventListener(
				"input",
				(event) => {
					if (event.target?.id === "tv-search-input") {
						this.query = sanitizeQuery(event.target.value);
						this.page = 0;
						this.render({ passive: true, preserveOverlayInput: true });
					}
				},
				{ signal },
			);
			this.root.addEventListener(
				"submit",
				(event) => {
					if (event.target?.id === "tv-search-form") {
						event.preventDefault();
						this.closeOverlay({ focusLibraryIfResults: true });
					}
				},
				{ signal },
			);
			this.root.addEventListener(
				"error",
				(event) => {
					if (!(event.target instanceof HTMLImageElement)) return;
					event.target.hidden = true;
					if (event.target.dataset.tvArt) {
						const frame = event.target.parentElement;
						frame?.classList.remove("has-art", "has-ambient");
						const ambient = frame?.querySelector(".tv-art-ambient");
						if (ambient) ambient.hidden = true;
					}
				},
				{ capture: true, signal },
			);
			this.root.addEventListener(
				"load",
				(event) => {
					const image = event.target;
					if (!(image instanceof HTMLImageElement) || !image.dataset.tvArt)
						return;
					this.applyArtworkFit(image);
				},
				{ capture: true, signal },
			);
			window.addEventListener("keydown", (event) => this.key(event), {
				capture: true,
				signal,
			});
			window.addEventListener("blur", () => this.pause(), { signal });
			window.addEventListener("focus", () => this.resume(), { signal });
			document.addEventListener(
				"visibilitychange",
				() => (document.hidden ? this.pause() : this.resume()),
				{ signal },
			);
			window.addEventListener("gamepadconnected", () => this.wake(), {
				signal,
			});
			window.addEventListener(
				"gamepaddisconnected",
				(event) => {
					this.input.disconnect(event.gamepad);
					this.wake();
				},
				{ signal },
			);
			window.addEventListener(
				"resize",
				() => this.update({ revealFocusAfterResize: true }),
				{ signal },
			);
			window.addEventListener(
				"orbit:languagechange",
				() => this.languageChanged(),
				{ signal },
			);
			if (returnPosition) {
				this.restoreCard(returnPosition);
				const sawRunning = !!this.snapshot.runningIds?.includes(
					returnPosition.gameId,
				);
				const awaitingConfirmation = !!this.snapshot.pendingLaunches?.has(
					returnPosition.gameId,
				);
				if (sawRunning || awaitingConfirmation) {
					this.launchReturn = {
						position: returnPosition,
						sawRunning,
						awaitingConfirmation,
					};
				} else {
					void this.saveLaunchReturn(null);
				}
			} else {
				this.render({ initial: true });
			}
			this.resume();
		}
		bindOverlayDialog(signal) {
			const dialog = this.overlayDialog;
			if (!dialog) return;
			dialog.addEventListener(
				"cancel",
				(event) => {
					if (event.cancelable) event.preventDefault();
					this.closeOverlay();
				},
				{ signal },
			);
			dialog.addEventListener(
				"close",
				() => {
					dialog.returnValue = "";
					if (this.overlay) {
						const returnKey = this.overlay.returnKey || "";
						this.overlay = null;
						this.overlaySignature = "";
						this.syncOverlayTriggers();
						this.render({ passive: true, focusKey: returnKey });
					}
				},
				{ signal },
			);
			// Fallback light-dismiss for runtimes without native closedby="any":
			// require both pointerdown and pointerup outside the dialog box.
			let pressedOutside = false;
			const isOutside = (event) => {
				const rect = dialog.getBoundingClientRect();
				return (
					event.clientX < rect.left ||
					event.clientX > rect.right ||
					event.clientY < rect.top ||
					event.clientY > rect.bottom
				);
			};
			dialog.addEventListener(
				"pointerdown",
				(event) => {
					pressedOutside = isOutside(event);
				},
				{ signal },
			);
			dialog.addEventListener(
				"pointerup",
				(event) => {
					if (pressedOutside && isOutside(event)) this.closeOverlay();
					pressedOutside = false;
				},
				{ signal },
			);
		}
		localizeShell() {
			if (!this.root) return;
			this.root.setAttribute("aria-label", t("Orbit controller mode"));
			for (const element of this.root.querySelectorAll("[data-tv-i18n]")) {
				const translated = t(element.dataset.tvI18n);
				if (element.firstChild?.nodeType === 3)
					element.firstChild.textContent = `${translated}${element.children.length ? " " : ""}`;
				else element.textContent = translated;
			}
			for (const element of this.root.querySelectorAll("[data-tv-aria]"))
				element.setAttribute("aria-label", t(element.dataset.tvAria));
			this.updateControllerStatus();
			this.updateHints();
		}
		updateHints() {
			const hints = this.root?.querySelector(".tv-hints");
			if (!hints) return;
			const g = this.glyphs();
			const pairs = [
				["↔ ↕", "Move"],
				[g.select, "Select"],
				[g.back, "Back"],
				[g.fav, "Favorite"],
				[g.recent, "Recent"],
				[g.pages, "Pages"],
				[g.scroll, "Scroll"],
				[g.search, "Search"],
				[g.browse, "Browse"],
			];
			hints.innerHTML = pairs
				.map(
					([key, label]) =>
						`<span><b>${escapeHtml(key)}</b> <span>${escapeHtml(t(label))}</span></span>`,
				)
				.join("");
		}
		updateControllerStatus() {
			const status = this.root?.querySelector(".tv-controller-status");
			const messages = {
				connected: "Controller connected",
				none: "Keyboard ready · connect a controller",
				unsupported: "Controller layout not recognized · use keyboard",
				unavailable: "Controller unavailable · use keyboard",
			};
			if (!status) return;
			const label = t(messages[this.statusKind] || messages.none);
			const owner =
				this.statusKind === "connected" && this.statusOwner
					? this.statusOwner
							.slice(this.statusOwner.indexOf(":") + 1)
							.trim()
							.slice(0, 80)
					: "";
			status.textContent = label;
			status.title = owner;
			status.setAttribute("aria-label", owner ? `${label} · ${owner}` : label);
		}
		languageChanged() {
			if (!this.active || !this.root) return;
			this.recentMarkup = "";
			this.libraryMarkup = "";
			this.alphaMarkup = "";
			this.detailSignature = "";
			this.bannerMarkup = "";
			this.activeBarMarkup = "";
			this.overlaySignature = "";
			this.localizeShell();
			this.render({ passive: true, revealFocusAfterResize: true });
		}
		unmount() {
			this.pause();
			this.input.reset();
			this.abort?.abort();
			if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
			if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
			this.renderFrame = null;
			this.noticeTimer = null;
			this.revealFocusAfterResize = false;
			this.detailSignature = "";
			this.recentMarkup = "";
			this.libraryMarkup = "";
			this.alphaMarkup = "";
			this.bannerMarkup = "";
			this.activeBarMarkup = "";
			this.overlay = null;
			this.overlaySignature = "";
			if (this.overlayDialog?.open) {
				try {
					this.overlayDialog.close();
				} catch {}
			}
			this.overlayDialog = null;
			if (this.audioCtx) {
				try {
					void this.audioCtx.close();
				} catch {}
				this.audioCtx = null;
			}
			this.root?.remove();
			this.root = null;
			this.notice = null;
			delete document.body.dataset.controllerMode;
			for (const record of this.inertRecords || [])
				record.node.inert = record.inert;
			this.inertRecords = [];
		}
		pause() {
			if (this.frame !== null) cancelAnimationFrame(this.frame);
			clearTimeout(this.timer);
			this.frame = null;
			this.timer = null;
			this.input.reset({ preserveOwner: true });
			if (this.audioCtx?.state === "running") {
				try {
					void this.audioCtx.suspend();
				} catch {}
			}
		}
		wake() {
			if (
				!this.active ||
				document.hidden ||
				!document.hasFocus() ||
				this.frame !== null
			)
				return;
			clearTimeout(this.timer);
			this.timer = null;
			this.frame = requestAnimationFrame((time) => this.poll(time));
		}
		resume() {
			this.pause();
			if (!this.active || document.hidden || !document.hasFocus()) return;
			this.updateLaunchReturn();
			this.frame = requestAnimationFrame((time) => this.poll(time));
		}
		poll(time) {
			this.frame = null;
			if (!this.active || document.hidden || !document.hasFocus()) {
				this.pause();
				return;
			}
			let result;
			try {
				result = this.input.read(
					typeof navigator.getGamepads === "function"
						? navigator.getGamepads()
						: [],
					time,
				);
			} catch {
				this.input.reset();
				result = { actions: [], status: { kind: "unavailable" } };
			}
			const nextFamily = result.status.family || "Standard";
			if (
				this.statusKind !== result.status.kind ||
				this.statusOwner !== (this.input.owner || null) ||
				this.statusFamily !== nextFamily
			) {
				this.statusKind = result.status.kind;
				this.statusOwner = this.input.owner || null;
				this.statusFamily = nextFamily;
				this.updateControllerStatus();
				this.updateHints();
				if (this.detailId) this.renderDetail();
			}
			if (result.actions.length) this.lastPadAction = time;
			for (const action of result.actions) this.command(action);
			if (!this.active) return;
			// Zero background gamepad polling when no standard gamepad is connected.
			// Connection events and window focus wake polling on demand.
			if (result.status.kind !== "connected") return;
			// Use animation frames only while actively navigating; fall back to low
			// frequency polling when idle or while a game is running.
			const playing = this.isGameBusy();
			const navigating =
				!playing &&
				this.lastPadAction > 0 &&
				time - this.lastPadAction < 950;
			if (navigating) {
				this.frame = requestAnimationFrame((next) => this.poll(next));
				return;
			}
			this.timer = setTimeout(() => {
				this.timer = null;
				if (this.active && !document.hidden && document.hasFocus())
					this.poll(performance.now());
			}, 48);
		}
		columns() {
			const width = this.root.clientWidth;
			return width >= 1600
				? 6
				: width >= 1200
					? 5
					: width >= 1000
						? 4
						: width >= 660
							? 3
							: 2;
		}
		rebuildIndexes() {
			const games = Array.isArray(this.snapshot?.games)
				? this.snapshot.games
				: [];
			const collections = Array.isArray(this.snapshot?.collections)
				? this.snapshot.collections
				: [];
			if (this.gamesRef !== games) {
				this.gamesRef = games;
				this.byId = new Map(games.map((game) => [game.id, game]));
				this.allWithHidden = games
					.slice()
					.sort(
						(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
					);
				this.allVisible = this.allWithHidden.filter((game) => !game.hidden);
				this.hiddenGames = this.allWithHidden.filter((game) => !!game.hidden);
				this.all = this.allVisible;
				this.favorites = this.allVisible.filter((game) => game.favorite);
				this.recent = this.allVisible
					.filter(
						(game) =>
							Number.isFinite(Date.parse(game.last_played_at)) &&
							Date.parse(game.last_played_at) > 0,
					)
					.sort(
						(a, b) =>
							Date.parse(b.last_played_at) - Date.parse(a.last_played_at) ||
							a.name.localeCompare(b.name),
					)
					.slice(0, 8);
			}
			if (this.collectionsRef !== collections) {
				this.collectionsRef = collections;
				this.collections = collections;
				this.collectionById = new Map(
					collections.map((col) => [col.id, col]),
				);
				this.collectionGamesById = new Map(
					collections.map((col) => [
						col.id,
						new Set(Array.isArray(col.game_ids) ? col.game_ids : []),
					]),
				);
			}
			if (
				this.filter.startsWith("collection:") &&
				!this.collectionById.has(this.filter.slice(11))
			) {
				this.filter = "all";
			}
		}
		gameCollections(gameId) {
			return this.collections.filter((col) =>
				this.collectionGamesById.get(col.id)?.has(gameId),
			);
		}
		basePool() {
			return this.showHidden ? this.allWithHidden : this.allVisible;
		}
		filterLabel(filter = this.filter) {
			if (filter === "all") return t("All games");
			if (filter === "favorites") return t("Favorites");
			if (filter === "hidden") return t("Hidden games");
			if (filter.startsWith("status:")) return statusLabel(filter.slice(7));
			if (filter.startsWith("collection:")) {
				const col = this.collectionById.get(filter.slice(11));
				return col ? col.name : t("All games");
			}
			return t("All games");
		}
		matchesQuery(game, needle) {
			if (!needle) return true;
			const parts = [
				game.name,
				game.genre,
				sourceName(game.source, ""),
				statusLabel(game.play_status),
				...(Array.isArray(game.tags) ? game.tags : []),
			];
			return parts.some((part) =>
				String(part || "")
					.toLocaleLowerCase()
					.includes(needle),
			);
		}
		filteredGames({ ignoreQuery = false } = {}) {
			let list;
			if (this.filter === "hidden") {
				list = this.hiddenGames;
			} else if (this.filter === "favorites") {
				list = this.basePool().filter((game) => game.favorite);
			} else if (this.filter.startsWith("status:")) {
				const code = this.filter.slice(7);
				list = this.basePool().filter((game) => game.play_status === code);
			} else if (this.filter.startsWith("collection:")) {
				const set = this.collectionGamesById.get(this.filter.slice(11));
				list = set
					? this.basePool().filter((game) => set.has(game.id))
					: this.basePool();
			} else {
				list = this.basePool();
			}
			const needle = ignoreQuery ? "" : this.query.trim().toLocaleLowerCase();
			if (needle)
				list = list.filter((game) => this.matchesQuery(game, needle));
			if (this.sort === "name") return list;
			return list.slice().sort((a, b) => {
				if (this.sort === "recent") {
					return (
						(Date.parse(b.last_played_at || 0) || 0) -
							(Date.parse(a.last_played_at || 0) || 0) ||
						a.name.localeCompare(b.name)
					);
				}
				if (this.sort === "time") {
					return (
						(b.total_play_seconds || 0) - (a.total_play_seconds || 0) ||
						a.name.localeCompare(b.name)
					);
				}
				if (this.sort === "added") {
					return (
						(Date.parse(b.created_at || 0) || 0) -
							(Date.parse(a.created_at || 0) || 0) ||
						a.name.localeCompare(b.name)
					);
				}
				return a.name.localeCompare(b.name);
			});
		}
		hasRefinements() {
			return (
				(this.filter !== "all" && this.filter !== "favorites") ||
				this.sort !== "name" ||
				this.query.trim() !== "" ||
				this.showHidden
			);
		}
		applyArtworkFit(image) {
			const w = image.naturalWidth;
			const h = image.naturalHeight;
			const frame = image.parentElement;
			if (!w || !h) {
				image.hidden = true;
				const ambient = frame?.querySelector(".tv-art-ambient");
				if (ambient) ambient.hidden = true;
				return;
			}
			const ratio = w / h;
			const slot = frame?.dataset.tvSlot || "landscape";
			const matchesSlot =
				slot === "poster"
					? ratio >= 0.55 && ratio <= 0.85
					: ratio >= 1.45 && ratio <= 2.45;
			frame?.classList.add("has-art");
			image.classList.toggle("is-fit-cover", matchesSlot);
			frame?.classList.toggle("has-ambient", !matchesSlot);
			const sheetArt = frame?.closest(".tv-sheet-art");
			if (sheetArt) {
				sheetArt.classList.toggle("is-landscape", ratio > 1.25);
			}
		}
		syncLoadedArtwork(container) {
			if (!container) return;
			for (const img of container.querySelectorAll("img[data-tv-art]")) {
				if (img.complete && img.naturalWidth > 0) this.applyArtworkFit(img);
			}
		}
		artwork(game, variant = "landscape") {
			const banner = art(game.banner),
				cover = art(game.cover),
				icon = art(game.icon);
			const portrait = variant === "poster" || variant === true;
			const image = portrait ? cover || banner : banner || cover;
			const kind = portrait && cover ? "cover" : banner ? "banner" : "cover";
			const slot = portrait ? "poster" : "landscape";
			const fallback = icon
				? `<img class="tv-native-icon" src="${icon}" alt="" loading="lazy"/>`
				: '<img class="tv-fallback-dark" src="../../assets/branding/orbit-mark-dark.png" alt="" loading="lazy"/><img class="tv-fallback-light" src="../../assets/branding/orbit-mark-light.png" alt="" loading="lazy"/>';
			return `<div class="tv-card-art" data-tv-slot="${slot}"><div class="tv-card-fallback">${fallback}</div>${image ? `<img class="tv-art-ambient" src="${image}" alt="" aria-hidden="true" loading="lazy"/><img class="tv-game-art ${kind === "banner" ? "is-banner" : "is-cover"}" src="${image}" data-tv-art="${kind}" alt="" loading="lazy"/>` : ""}</div>`;
		}
		spotlight(game) {
			if (!game)
				return `<section class="tv-spotlight tv-spotlight-empty" aria-label="${escapeHtml(t("Featured game"))}"><div class="tv-spotlight-copy"><p class="tv-spotlight-kicker"><span class="tv-signal"></span> ${escapeHtml(t("YOUR COLLECTION STARTS HERE"))}</p><h2>${escapeHtml(t("Every game."))}<br/>${escapeHtml(t("One place."))}</h2><p class="tv-spotlight-description">${escapeHtml(t("Bring your games together on the desktop, then take the library to your controller."))}</p><div class="tv-spotlight-foot"><span class="tv-spotlight-label">${escapeHtml(t("READY WHEN YOU ARE"))}</span></div></div><div class="tv-spotlight-visual" aria-hidden="true"><span class="tv-orbit-ring tv-orbit-ring-one"></span><span class="tv-orbit-ring tv-orbit-ring-two"></span><img class="tv-spotlight-mark tv-logo-dark" src="../../assets/branding/orbit-mark-dark.png" alt=""/><img class="tv-spotlight-mark tv-logo-light" src="../../assets/branding/orbit-mark-light.png" alt=""/></div></section>`;
			const bannerArt = art(game.banner);
			const coverArt = art(game.cover);
			const banner = bannerArt || coverArt;
			const usePoster = !bannerArt && !!coverArt;
			const running = this.snapshot.runningIds?.includes(game.id);
			const lastPlayed =
				Number.isFinite(Date.parse(game.last_played_at)) &&
				Date.parse(game.last_played_at) > 0;
			const tag =
				this.recent[0]?.id === game.id
					? "PICK UP WHERE YOU LEFT OFF"
					: "IN THE SPOTLIGHT";
			const metaParts = [
				sourceName(game.source, "Your library"),
				running ? t("Playing now") : played(game.total_play_seconds || 0),
			];
			const pStatus = statusLabel(game.play_status);
			if (pStatus) metaParts.push(pStatus);
			const profileCount = Array.isArray(game.launch_profiles)
				? game.launch_profiles.length
				: 0;
			if (profileCount > 0) {
				metaParts.push(
					t(
						profileCount === 1
							? "{count} launch profile"
							: "{count} launch profiles",
						{ count: formatNumber(profileCount) },
					),
				);
			}
			const metaHtml = metaParts
				.map((part) => escapeHtml(part))
				.join(' <span aria-hidden="true">·</span> ');
			return `<section class="tv-spotlight" aria-label="${escapeHtml(t("Featured game"))}"><div class="tv-spotlight-ambient" aria-hidden="true">${banner ? `<img src="${banner}" alt="" loading="lazy"/>` : ""}</div><div class="tv-spotlight-copy"><p class="tv-spotlight-kicker"><span class="tv-signal"></span> ${escapeHtml(t(tag))}</p><h2>${escapeHtml(game.name)}</h2><p class="tv-spotlight-description">${metaHtml}</p><div class="tv-spotlight-foot"><span class="tv-spotlight-label">${escapeHtml(t(running ? "SESSION ACTIVE" : lastPlayed ? "CONTINUE YOUR JOURNEY" : "DISCOVER SOMETHING NEW"))}</span><span class="tv-spotlight-prompt"><b>A</b><b>↵</b> ${escapeHtml(t("Open selected game"))}</span></div></div><div class="tv-spotlight-visual" aria-hidden="true"><div class="tv-spotlight-image${usePoster ? " is-portrait" : ""}">${this.artwork(game, usePoster ? "poster" : "landscape")}</div></div></section>`;
		}
		refreshSpotlight(game) {
			if (!game || this.spotlightGameId === game.id) return;
			const hero = this.root?.querySelector(".tv-spotlight");
			if (!hero) return;
			this.spotlightGameId = game.id;
			hero.outerHTML = this.spotlight(game);
			this.recentMarkup = "";
		}
		card(game, zone) {
			const running = this.snapshot.runningIds?.includes(game.id);
			const pStatus = statusLabel(game.play_status);
			const badge = game.hidden
				? `<span class="tv-card-badge tv-card-badge-hidden">${escapeHtml(t("Hidden"))}</span>`
				: pStatus
					? `<span class="tv-card-badge tv-card-badge-${escapeHtml(game.play_status)}">${escapeHtml(pStatus)}</span>`
					: "";
			const favBadge = game.favorite
				? `<span class="tv-card-fav" aria-hidden="true">${HEART_SVG}</span>`
				: "";
			const variant = zone === "library" ? "poster" : "landscape";
			return `<button class="tv-card tv-focus" data-tv-action="open" data-tv-game="${escapeHtml(game.id)}" data-tv-key="${zone}:${escapeHtml(game.id)}" aria-label="${escapeHtml(t("Open {name}", { name: game.name }))}" tabindex="-1">${this.artwork(game, variant)}${badge}${favBadge}<span class="tv-card-copy"><strong>${escapeHtml(game.name)}</strong><span><span class="tv-card-source">${running ? `● ${escapeHtml(t("Playing now"))}` : escapeHtml(sourceName(game.source))}</span><i>${running ? escapeHtml(t("In session")) : escapeHtml(played(game.total_play_seconds || 0))}</i></span></span></button>`;
		}
		renderBanner() {
			const slot = this.root?.querySelector(".tv-banner-slot");
			if (!slot) return;
			const update = this.snapshot?.updateStatus;
			const discoveryCount = Number(this.snapshot?.discoveryCount) || 0;
			let markup = "";
			if (
				update?.state === "ready" &&
				update.version &&
				!this.isGameBusy() &&
				this.dismissedBannerKey !== `update:${update.version}`
			) {
				markup = `<section class="tv-banner tv-banner-update" role="region" aria-label="${escapeHtml(t("Orbit notices"))}"><div class="tv-banner-copy"><span class="tv-banner-dot" aria-hidden="true"></span><span>${escapeHtml(t("Update v{version} is ready to install.", { version: update.version }))}</span></div><div class="tv-banner-actions"><button class="tv-focus tv-banner-primary" data-tv-key="banner:update" data-tv-action="installUpdate">${escapeHtml(t("Install & restart"))}</button><button class="tv-focus tv-banner-dismiss" data-tv-key="banner:dismiss" data-tv-action="dismissBanner" data-banner-key="update:${escapeHtml(update.version)}">${escapeHtml(t("Dismiss"))}</button></div></section>`;
			} else if (
				discoveryCount > 0 &&
				this.dismissedBannerKey !== `discoveries:${discoveryCount}`
			) {
				const text = t(
					discoveryCount === 1
						? "{count} new game found."
						: "{count} new games found.",
					{ count: formatNumber(discoveryCount) },
				);
				markup = `<section class="tv-banner tv-banner-discovery" role="region" aria-label="${escapeHtml(t("Orbit notices"))}"><div class="tv-banner-copy"><span class="tv-banner-dot" aria-hidden="true"></span><span>${escapeHtml(text)}</span></div><div class="tv-banner-actions"><button class="tv-focus tv-banner-primary" data-tv-key="banner:discoveries" data-tv-action="reviewDiscoveries">${escapeHtml(t("Review games"))}</button><button class="tv-focus tv-banner-dismiss" data-tv-key="banner:dismiss" data-tv-action="dismissBanner" data-banner-key="discoveries:${discoveryCount}">${escapeHtml(t("Dismiss"))}</button></div></section>`;
			}
			if (markup !== this.bannerMarkup) {
				slot.innerHTML = markup;
				this.bannerMarkup = markup;
			}
		}
		renderActiveFilters() {
			const slot = this.root?.querySelector(".tv-active-filters-slot");
			if (!slot) return;
			const pills = [];
			if (this.filter !== "all" && this.filter !== "favorites") {
				pills.push(
					`<span class="tv-filter-chip">${escapeHtml(t("Filter: {label}", { label: this.filterLabel() }))}</span>`,
				);
			}
			if (this.query.trim()) {
				pills.push(
					`<span class="tv-filter-chip">${escapeHtml(t("Search: {query}", { query: this.query.trim() }))}</span>`,
				);
			}
			if (this.sort !== "name") {
				pills.push(
					`<span class="tv-filter-chip">${escapeHtml(t("Sort: {sort}", { sort: t(SORT_LABELS[this.sort]) }))}</span>`,
				);
			}
			if (this.showHidden && this.filter !== "hidden") {
				pills.push(
					`<span class="tv-filter-chip">${escapeHtml(t("Include hidden games"))}</span>`,
				);
			}
			const markup = pills.length
				? `<div class="tv-active-filters" role="region" aria-label="${escapeHtml(t("Browse & filter"))}"><div class="tv-active-filter-chips">${pills.join("")}</div><button class="tv-focus tv-clear-filters" data-tv-key="filters:clear" data-tv-action="clearFilters">${escapeHtml(t("Clear filters"))}</button></div>`
				: "";
			if (markup !== this.activeBarMarkup) {
				slot.innerHTML = markup;
				this.activeBarMarkup = markup;
			}
			this.syncOverlayTriggers();
		}
		syncOverlayTriggers() {
			const browse = this.root?.querySelector('[data-tv-key="drawer:open"]');
			if (browse) {
				browse.setAttribute(
					"aria-expanded",
					String(this.overlay?.type === "drawer"),
				);
				browse.classList.toggle(
					"is-active",
					(this.filter !== "all" && this.filter !== "favorites") ||
						this.sort !== "name" ||
						this.showHidden,
				);
			}
			const search = this.root?.querySelector('[data-tv-key="search:open"]');
			if (search) {
				search.setAttribute(
					"aria-expanded",
					String(this.overlay?.type === "search"),
				);
				search.classList.toggle("is-active", this.query.trim().length > 0);
			}
		}
		update({ revealFocusAfterResize = false } = {}) {
			if (!this.active) return;
			if (this.updateLaunchReturn()) return;
			if (revealFocusAfterResize) this.revealFocusAfterResize = true;
			if (this.renderFrame !== null) return;
			this.renderFrame = requestAnimationFrame(() => {
				this.renderFrame = null;
				const revealFocus = this.revealFocusAfterResize;
				this.revealFocusAfterResize = false;
				if (this.active)
					this.render({ passive: true, revealFocusAfterResize: revealFocus });
			});
		}
		render({
			initial = false,
			focusLibrary = false,
			focusKey = "",
			passive = false,
			revealFocusAfterResize = false,
			restoreGameId = "",
			preserveOverlayInput = false,
		} = {}) {
			if (!this.root) return;
			const main = this.root.querySelector(".tv-main");
			const scrollTop = passive ? main.scrollTop : 0;
			const recentScrollLeft = passive
				? this.root.querySelector(".tv-recent")?.scrollLeft || 0
				: 0;
			const detailScrollTop = passive
				? this.root.querySelector(".tv-sheet")?.scrollTop || 0
				: 0;
			let previous =
				focusKey || document.activeElement?.dataset?.tvKey || this.lastKey;
			this.snapshot = this.options.snapshot();
			this.rebuildIndexes();
			if (restoreGameId) {
				const currentList = this.filteredGames();
				if (!currentList.some((game) => game.id === restoreGameId)) {
					this.filter = "all";
					this.query = "";
					const restoredGame = this.byId.get(restoreGameId);
					if (restoredGame?.hidden) this.showHidden = true;
				}
				if (
					previous !== `recent:${restoreGameId}` ||
					!this.recent.some((game) => game.id === restoreGameId)
				)
					previous = `library:${restoreGameId}`;
			}
			this.renderBanner();
			const recent = this.root.querySelector(".tv-recent-slot");
			const selectedId =
				previous.startsWith("recent:") || previous.startsWith("library:")
					? previous.slice(previous.indexOf(":") + 1)
					: "";
			const spotlightGame =
				this.byId.get(selectedId) || this.recent[0] || this.allVisible[0];
			const recentMarkup =
				this.spotlight(spotlightGame) +
				(this.recent.length
					? `<section class="tv-continue" aria-label="${escapeHtml(t("Continue playing"))}"><div class="tv-section-heading"><h2>${escapeHtml(t("Continue playing"))}</h2><span>${escapeHtml(t(this.recent.length === 1 ? "{count} recently played game" : "{count} recently played games", { count: formatNumber(this.recent.length) }))}</span></div><div class="tv-recent">${this.recent.map((game) => this.card(game, "recent")).join("")}</div></section>`
					: "");
			if (recentMarkup !== this.recentMarkup) {
				recent.innerHTML = recentMarkup;
				this.recentMarkup = recentMarkup;
				this.spotlightGameId = spotlightGame?.id || "";
				this.syncLoadedArtwork(recent);
			}
			this.renderActiveFilters();
			const list = this.filteredGames(),
				columns = this.columns(),
				size = columns * 2;
			if (
				(restoreGameId || (this.pageSize && this.pageSize !== size)) &&
				!focusLibrary &&
				!initial &&
				previous.startsWith("library:")
			) {
				const selected = list.findIndex(
					(game) => game.id === previous.slice(8),
				);
				if (selected !== -1) this.page = Math.floor(selected / size);
			}
			this.pageSize = size;
			this.pageCount = Math.max(1, Math.ceil(list.length / size));
			this.page = Math.max(0, Math.min(this.page, this.pageCount - 1));
			this.root.style.setProperty("--tv-columns", columns);
			const start = this.page * size,
				records = list.slice(start, start + size);
			this.root.querySelector(".tv-total").textContent = formatNumber(
				this.hasRefinements() ? list.length : this.allVisible.length,
			);
			for (const button of this.root.querySelectorAll(
				'[data-tv-action="filter"]',
			))
				button.setAttribute(
					"aria-pressed",
					String(button.dataset.tvFilter === this.filter),
				);
			const libraryMarkup = records.length
				? `<div class="tv-library">${records.map((game) => this.card(game, "library")).join("")}</div>`
				: this.emptyStateMarkup();
			this.renderAlphaJump(list, size, records);
			if (libraryMarkup !== this.libraryMarkup) {
				const librarySlot = this.root.querySelector(".tv-library-slot");
				librarySlot.innerHTML = libraryMarkup;
				this.libraryMarkup = libraryMarkup;
				this.syncLoadedArtwork(librarySlot);
			}
			this.root.querySelector(".tv-page-label").textContent = list.length
				? t("{first}–{last} of {total} · Page {page} of {pages}", {
						first: formatNumber(start + 1),
						last: formatNumber(start + records.length),
						total: formatNumber(list.length),
						page: formatNumber(this.page + 1),
						pages: formatNumber(this.pageCount),
					})
				: t("No games in this collection");
			this.root.querySelector('[data-tv-action="previousPage"]').disabled =
				this.page === 0;
			this.root.querySelector('[data-tv-action="nextPage"]').disabled =
				this.page === this.pageCount - 1;
			if (this.detailId && !this.byId.has(this.detailId)) this.detailId = null;
			if (
				this.overlay?.type === "game-actions" &&
				!this.byId.has(this.overlay.gameId)
			) {
				this.closeOverlay({ silent: true, skipRender: true });
			}
			this.renderDetail();
			this.renderOverlay({ preserveInput: preserveOverlayInput });
			if (preserveOverlayInput && this.overlay?.type === "search") {
				this.updateSelectedLabel();
				return;
			}
			const firstRecent = this.root.querySelector(".tv-recent [data-tv-game]"),
				firstLibrary = this.root.querySelector(".tv-library [data-tv-game]");
			let target = this.controls().find(
				(button) => button.dataset.tvKey === previous,
			);
			if (initial && !this.overlay) target = firstRecent || firstLibrary;
			if (focusLibrary && !this.overlay) target = firstLibrary;
			const fallback = this.overlay
				? this.controls()[0]
				: this.detailId
					? this.controls()[0]
					: firstLibrary ||
						this.root.querySelector(".tv-empty .tv-focus") ||
						firstRecent ||
						this.controls()[0];
			if (passive) {
				main.scrollTop = scrollTop;
				const recentNode = this.root.querySelector(".tv-recent");
				if (recentNode) recentNode.scrollLeft = recentScrollLeft;
				const sheet = this.root.querySelector(".tv-sheet");
				if (sheet) sheet.scrollTop = detailScrollTop;
			}
			this.focus(target || fallback, { scroll: !passive || !target });
			if (revealFocusAfterResize) {
				this.revealRecentCard(target || fallback);
				this.revealDetailAction(target || fallback);
			}
			this.updateSelectedLabel();
		}
		renderAlphaJump(list, size, records) {
			const slot = this.root?.querySelector(".tv-alpha-jump-slot");
			if (!slot) return;
			if (this.sort !== "name" || this.pageCount <= 2 || !list.length) {
				if (this.alphaMarkup) {
					slot.innerHTML = "";
					this.alphaMarkup = "";
				}
				return;
			}
			const bucketOf = (name) => {
				const ch = String(name || "").trim().charAt(0).toLocaleUpperCase();
				return /^[A-Z]$/.test(ch) ? ch : "#";
			};
			const pages = new Map();
			for (let idx = 0; idx < list.length; idx++) {
				const letter = bucketOf(list[idx].name);
				if (!pages.has(letter)) pages.set(letter, Math.floor(idx / size));
			}
			const activeLetter = records.length ? bucketOf(records[0].name) : "";
			const markup =
				pages.size > 1
					? `<div class="tv-alpha-jump" role="navigation" aria-label="${escapeHtml(t("Jump to letter"))}">${[
							...pages.entries(),
						]
							.map(
								([letter, targetPage]) =>
									`<button type="button" class="tv-focus tv-alpha-btn" data-tv-action="jumpLetter" data-tv-page="${targetPage}" data-tv-key="alpha:${letter}" ${letter === activeLetter ? 'aria-current="true"' : ""}>${letter}</button>`,
							)
							.join("")}</div>`
					: "";
			if (markup !== this.alphaMarkup) {
				slot.innerHTML = markup;
				this.alphaMarkup = markup;
			}
		}
		emptyStateMarkup() {
			if (this.query.trim() || this.filter.startsWith("collection:")) {
				return `<div class="tv-empty"><h2>${escapeHtml(t("No games match these filters"))}</h2><p>${escapeHtml(t("Try clearing your search or choosing another shelf."))}</p><button class="tv-focus" data-tv-action="clearFilters" data-tv-key="empty:clear">${escapeHtml(t("Clear filters"))}</button></div>`;
			}
			if (this.filter.startsWith("status:")) {
				return `<div class="tv-empty"><h2>${escapeHtml(t("No games in this status"))}</h2><p>${escapeHtml(t("Assign a play status from any game profile to see it here."))}</p><button class="tv-focus" data-tv-action="filter" data-tv-filter="all" data-tv-key="empty:all">${escapeHtml(t("Browse all games"))}</button></div>`;
			}
			if (this.filter === "hidden") {
				return `<div class="tv-empty"><h2>${escapeHtml(t("No hidden games"))}</h2><p>${escapeHtml(t("Hidden games stay tucked away until you browse them here."))}</p><button class="tv-focus" data-tv-action="filter" data-tv-filter="all" data-tv-key="empty:all">${escapeHtml(t("Browse all games"))}</button></div>`;
			}
			if (this.filter === "favorites") {
				return `<div class="tv-empty"><h2>${escapeHtml(t("No favorites yet"))}</h2><p>${escapeHtml(t("Favorite a game with X / Square to keep it here."))}</p><button class="tv-focus" data-tv-action="filter" data-tv-filter="all" data-tv-key="empty:all">${escapeHtml(t("Browse all games"))}</button></div>`;
			}
			return `<div class="tv-empty"><h2>${escapeHtml(t("Your next game starts here."))}</h2><p>${escapeHtml(t("Add games from the desktop library, then return to controller mode."))}</p><button class="tv-focus" data-tv-action="exit" data-tv-key="empty:exit">${escapeHtml(t("Back to desktop library"))}</button></div>`;
		}
		revealRecentCard(button) {
			const lane = button?.closest?.(".tv-recent");
			if (!lane) return;
			const viewport = lane.getBoundingClientRect();
			const card = button.getBoundingClientRect();
			if (card.right > viewport.right)
				lane.scrollLeft += card.right - viewport.right;
			else if (card.left < viewport.left)
				lane.scrollLeft += card.left - viewport.left;
		}
		revealDetailAction(button) {
			const sheet = button?.closest?.(".tv-sheet");
			if (!sheet) return;
			const viewport = sheet.getBoundingClientRect();
			const focused = button.getBoundingClientRect();
			if (focused.bottom > viewport.bottom - 8)
				sheet.scrollTop += focused.bottom - viewport.bottom + 8;
			else if (focused.top < viewport.top + 8)
				sheet.scrollTop += focused.top - viewport.top - 8;
		}
		renderDetail() {
			const slot = this.root.querySelector(".tv-detail-slot"),
				game = this.byId.get(this.detailId);
			this.stage.inert = !!game;
			if (!game) {
				if (this.detailSignature) slot.innerHTML = "";
				this.detailSignature = "";
				return;
			}
			const pending =
				this.snapshot.pendingLaunches?.has(game.id) ||
				(this.launchInFlight && this.launchGameId === game.id);
			const running = this.snapshot.runningIds?.includes(game.id);
			const profiles = Array.isArray(game.launch_profiles)
				? game.launch_profiles
				: [];
			const cols = this.gameCollections(game.id);
			const signature = JSON.stringify([
				window.OrbitI18n?.getLanguage?.(),
				this.statusFamily,
				game.id,
				game.name,
				game.source,
				game.banner,
				game.cover,
				game.icon,
				game.favorite,
				game.play_status || "",
				!!game.hidden,
				profiles.map((p) => `${p.id}:${p.name}`),
				cols.map((c) => `${c.id}:${c.name}`),
				running ? null : game.total_play_seconds,
				game.last_played_at,
				!!pending,
				!!running,
			]);
			if (this.detailSignature === signature && slot.firstElementChild) return;
			this.detailSignature = signature;
			const background = art(game.banner) || art(game.cover);
			const unavailable = pending || running;
			const pStatus = statusLabel(game.play_status);
			const metaLine = [
				running ? t("Session in progress") : played(game.total_play_seconds || 0),
				game.last_played_at
					? t("Last played {date}", { date: formatDate(game.last_played_at) })
					: "",
				pStatus ? t("Status: {status}", { status: pStatus }) : "",
				game.hidden ? t("Hidden") : "",
			]
				.filter(Boolean)
				.map((part) => escapeHtml(part))
				.join(" · ");
			const profileButton = profiles.length
				? `<button class="tv-focus tv-sheet-pill" data-tv-action="openGameSheet" data-tv-section="profiles" data-tv-key="detail:profiles" data-tv-game="${escapeHtml(game.id)}">${escapeHtml(t("Launch profile"))} (${formatNumber(profiles.length)})</button>`
				: "";
			const collectionBadges = cols.length
				? `<div class="tv-sheet-tags">${cols
						.slice(0, 4)
						.map(
							(col) =>
								`<span class="tv-sheet-tag">${escapeHtml(col.name)}</span>`,
						)
						.join("")}</div>`
				: "";
			const sheetLandscape = !art(game.cover) && !!art(game.banner);
			slot.innerHTML = `<div class="tv-sheet-scrim"><section class="tv-sheet" role="dialog" aria-modal="true" aria-labelledby="tv-game-title"><div class="tv-sheet-backdrop" aria-hidden="true">${background ? `<img src="${background}" alt="" loading="lazy"/>` : ""}</div><div class="tv-sheet-layout"><div class="tv-sheet-art${sheetLandscape ? " is-landscape" : ""}">${this.artwork(game, sheetLandscape ? "landscape" : "poster")}</div><div class="tv-sheet-copy"><p class="tv-eyebrow">${escapeHtml(t("GAME PROFILE"))} <span aria-hidden="true">/</span> ${escapeHtml(sourceName(game.source, "Your library"))}</p><h2 id="tv-game-title">${escapeHtml(game.name)}</h2><p class="tv-sheet-meta">${metaLine}</p>${collectionBadges}<div class="tv-sheet-actions"><button class="tv-focus tv-play" data-tv-action="launch" data-tv-key="detail:play" data-tv-game="${escapeHtml(game.id)}" aria-busy="${!!pending}" aria-disabled="${!!unavailable}">${escapeHtml(t(pending ? "Starting…" : running ? "Playing now" : "▶ Play game"))}</button><button class="tv-focus tv-favorite-btn${game.favorite ? " is-favorite" : ""}" data-tv-action="favorite" data-tv-key="detail:favorite" data-tv-game="${escapeHtml(game.id)}" aria-pressed="${String(!!game.favorite)}">${HEART_SVG}<span>${escapeHtml(t(game.favorite ? "Favorited" : "Add to favorites"))}</span></button><button class="tv-focus" data-tv-action="back" data-tv-key="detail:back">${escapeHtml(t("Back to library"))}</button></div><div class="tv-sheet-secondary"><button class="tv-focus tv-sheet-pill" data-tv-action="openGameSheet" data-tv-key="detail:options" data-tv-game="${escapeHtml(game.id)}">${escapeHtml(t("Game options"))}</button>${profileButton}</div><p class="tv-sheet-hint"><span>${escapeHtml(this.glyphs().back)}</span> ${escapeHtml(t("Return to the collection"))}</p></div></div></section></div>`;
			this.syncLoadedArtwork(slot);
		}
		renderOverlay({ preserveInput = false } = {}) {
			const dialog = this.overlayDialog;
			if (!dialog) return;
			if (!this.overlay) {
				if (dialog.open) {
					try {
						dialog.close();
					} catch {}
				}
				if (this.overlaySignature) {
					dialog.innerHTML = "";
					this.overlaySignature = "";
				}
				delete dialog.dataset.overlayKind;
				this.syncOverlayTriggers();
				return;
			}
			dialog.dataset.overlayKind = this.overlay.type;
			let markup = "";
			let sig = "";
			if (this.overlay.type === "drawer") {
				const counts = {
					all: this.basePool().length,
					favorites: this.basePool().filter((g) => g.favorite).length,
					hidden: this.hiddenGames.length,
				};
				for (const [code] of PLAY_STATUSES) {
					counts[`status:${code}`] = this.basePool().filter(
						(g) => g.play_status === code,
					).length;
				}
				const update = this.snapshot?.updateStatus;
				const updateReady =
					update?.state === "ready" && update.version && !this.isGameBusy();
				const discoveryCount = Number(this.snapshot?.discoveryCount) || 0;
				const audioOn = !!this.snapshot?.settings?.controllerAudio;
				const hapticsOn = !!this.snapshot?.settings?.controllerHaptics;
				sig = JSON.stringify([
					"drawer",
					window.OrbitI18n?.getLanguage?.(),
					this.filter,
					this.sort,
					this.showHidden,
					counts,
					this.collections.map((c) => [
						c.id,
						c.name,
						c.color,
						this.collectionGamesById.get(c.id)?.size || 0,
					]),
					audioOn,
					hapticsOn,
					updateReady ? update.version : "",
					discoveryCount,
				]);
				if (sig !== this.overlaySignature) {
					const shelfButton = (key, filterValue, label, count) =>
						`<button class="tv-focus tv-drawer-item" data-tv-action="drawerFilter" data-tv-filter="${escapeHtml(filterValue)}" data-tv-key="drawer:${escapeHtml(key)}" aria-pressed="${String(this.filter === filterValue)}"><span>${escapeHtml(label)}</span><span class="tv-drawer-count">${formatNumber(count)}</span></button>`;
					const statusButtons = PLAY_STATUSES.map(([code, label]) =>
						shelfButton(`status-${code}`, `status:${code}`, t(label), counts[`status:${code}`]),
					).join("");
					const collectionItems = this.collections.length
						? this.collections
								.map((col) => {
									const set = this.collectionGamesById.get(col.id);
									const count = set
										? this.basePool().filter((g) => set.has(g.id)).length
										: 0;
									const dot = /^#[0-9a-f]{6}$/i.test(col.color || "")
										? `<span class="tv-drawer-dot" style="background:${escapeHtml(col.color)}" aria-hidden="true"></span>`
										: '<span class="tv-drawer-dot" aria-hidden="true"></span>';
									return `<button class="tv-focus tv-drawer-item" data-tv-action="drawerFilter" data-tv-filter="collection:${escapeHtml(col.id)}" data-tv-key="drawer:col:${escapeHtml(col.id)}" aria-pressed="${String(this.filter === `collection:${col.id}`)}"><span class="tv-drawer-col-name">${dot}${escapeHtml(col.name)}</span><span class="tv-drawer-count">${formatNumber(count)}</span></button>`;
								})
								.join("")
						: `<p class="tv-drawer-empty">${escapeHtml(t("Create collections from the desktop library to browse them here."))}</p>`;
					const sortButtons = SORT_OPTIONS.map(
						([code, label]) =>
							`<button class="tv-focus tv-drawer-chip" data-tv-action="setSort" data-tv-sort="${code}" data-tv-key="drawer:sort:${code}" aria-pressed="${String(this.sort === code)}">${escapeHtml(t(label))}</button>`,
					).join("");
					const noticeActions = [];
					if (updateReady) {
						noticeActions.push(
							`<button class="tv-focus tv-drawer-item tv-drawer-accent" data-tv-action="installUpdate" data-tv-key="drawer:install-update"><span>${escapeHtml(t("Install update v{version}", { version: update.version }))}</span></button>`,
						);
					}
					if (discoveryCount > 0) {
						noticeActions.push(
							`<button class="tv-focus tv-drawer-item" data-tv-action="reviewDiscoveries" data-tv-key="drawer:review-discoveries"><span>${escapeHtml(t("Review {count} discovered games", { count: formatNumber(discoveryCount) }))}</span></button>`,
						);
					}
					markup = `<div class="tv-overlay-surface tv-drawer-surface"><div class="tv-overlay-head"><h1 id="tv-overlay-title">${escapeHtml(t("Browse & filter"))}</h1><button class="tv-focus tv-overlay-close" data-tv-action="closeOverlay" data-tv-key="overlay:close">${escapeHtml(t("Close"))}</button></div><div class="tv-overlay-body"><section class="tv-drawer-group"><h2>${escapeHtml(t("Shelves"))}</h2><div class="tv-drawer-list">${shelfButton("all", "all", t("All games"), counts.all)}${shelfButton("favorites", "favorites", t("Favorites"), counts.favorites)}${counts.hidden > 0 || this.filter === "hidden" ? shelfButton("hidden", "hidden", t("Hidden games"), counts.hidden) : ""}</div>${counts.hidden > 0 ? `<button class="tv-focus tv-drawer-item tv-drawer-toggle" data-tv-action="toggleShowHidden" data-tv-key="drawer:show-hidden" aria-pressed="${String(this.showHidden)}"><span>${escapeHtml(t("Include hidden games"))}</span><span class="tv-drawer-pill">${escapeHtml(t(this.showHidden ? "On" : "Off"))}</span></button>` : ""}</section><section class="tv-drawer-group"><h2>${escapeHtml(t("Play statuses"))}</h2><div class="tv-drawer-list">${statusButtons}</div></section><section class="tv-drawer-group"><h2>${escapeHtml(t("Custom collections"))}</h2><div class="tv-drawer-list">${collectionItems}</div></section><section class="tv-drawer-group"><h2>${escapeHtml(t("Sort order"))}</h2><div class="tv-drawer-chips">${sortButtons}</div></section><section class="tv-drawer-group"><h2>${escapeHtml(t("Controller feedback"))}</h2><div class="tv-drawer-list"><button class="tv-focus tv-drawer-item" data-tv-action="toggleSetting" data-tv-setting="controllerAudio" data-tv-key="drawer:audio" aria-pressed="${String(audioOn)}"><span>${escapeHtml(t("Navigation sounds"))}</span><span class="tv-drawer-pill">${escapeHtml(t(audioOn ? "On" : "Off"))}</span></button><button class="tv-focus tv-drawer-item" data-tv-action="toggleSetting" data-tv-setting="controllerHaptics" data-tv-key="drawer:haptics" aria-pressed="${String(hapticsOn)}"><span>${escapeHtml(t("Launch vibration"))}</span><span class="tv-drawer-pill">${escapeHtml(t(hapticsOn ? "On" : "Off"))}</span></button></div></section>${noticeActions.length ? `<section class="tv-drawer-group"><h2>${escapeHtml(t("Updates & discovery"))}</h2><div class="tv-drawer-list">${noticeActions.join("")}</div></section>` : ""}</div></div>`;
				}
			} else if (this.overlay.type === "game-actions") {
				const game = this.byId.get(this.overlay.gameId);
				if (!game) {
					this.closeOverlay({ silent: true, skipRender: true });
					return;
				}
				const profiles = Array.isArray(game.launch_profiles)
					? game.launch_profiles
					: [];
				const memberIds = new Set(
					this.gameCollections(game.id).map((c) => c.id),
				);
				const unavailable =
					this.snapshot.pendingLaunches?.has(game.id) ||
					this.snapshot.runningIds?.includes(game.id) ||
					(this.launchInFlight && this.launchGameId === game.id);
				sig = JSON.stringify([
					"game-actions",
					window.OrbitI18n?.getLanguage?.(),
					game.id,
					game.name,
					game.play_status || "",
					!!game.hidden,
					!!unavailable,
					profiles.map((p) => `${p.id}:${p.name}`),
					this.collections.map((c) => `${c.id}:${c.name}:${memberIds.has(c.id)}`),
				]);
				if (sig !== this.overlaySignature) {
					const profileItems = [
						`<button class="tv-focus tv-drawer-item tv-drawer-accent" data-tv-action="launchProfile" data-tv-game="${escapeHtml(game.id)}" data-tv-profile="" data-tv-key="sheet:profile:default" aria-disabled="${String(!!unavailable)}"><span>${escapeHtml(t("Default launch"))}</span></button>`,
						...profiles.map(
							(profile, idx) =>
								`<button class="tv-focus tv-drawer-item" data-tv-action="launchProfile" data-tv-game="${escapeHtml(game.id)}" data-tv-profile="${escapeHtml(profile.id || "")}" data-tv-key="sheet:profile:${idx}" aria-disabled="${String(!!unavailable)}"><span>${escapeHtml(profile.name)}</span></button>`,
						),
					].join("");
					const statusItems = [
						...PLAY_STATUSES.map(
							([code, label]) =>
								`<button class="tv-focus tv-drawer-chip" role="radio" aria-checked="${String(game.play_status === code)}" data-tv-action="setStatus" data-tv-game="${escapeHtml(game.id)}" data-tv-status="${code}" data-tv-key="sheet:status:${code}">${escapeHtml(t(label))}</button>`,
						),
						`<button class="tv-focus tv-drawer-chip" role="radio" aria-checked="${String(!game.play_status)}" data-tv-action="setStatus" data-tv-game="${escapeHtml(game.id)}" data-tv-status="" data-tv-key="sheet:status:none">${escapeHtml(t("No status"))}</button>`,
					].join("");
					const collectionSection = this.collections.length
						? `<section class="tv-drawer-group"><h2>${escapeHtml(t("Collections"))}</h2><div class="tv-drawer-list">${this.collections
								.map((col) => {
									const assigned = memberIds.has(col.id);
									return `<button class="tv-focus tv-drawer-item" data-tv-action="toggleGameCollection" data-tv-game="${escapeHtml(game.id)}" data-tv-collection="${escapeHtml(col.id)}" data-tv-key="sheet:col:${escapeHtml(col.id)}" aria-pressed="${String(assigned)}"><span>${escapeHtml(col.name)}</span><span class="tv-drawer-pill">${escapeHtml(t(assigned ? "On" : "Off"))}</span></button>`;
								})
								.join("")}</div></section>`
						: "";
					markup = `<div class="tv-overlay-surface tv-action-sheet-surface"><div class="tv-overlay-head"><div><p class="tv-eyebrow">${escapeHtml(t("Game options"))}</p><h1 id="tv-overlay-title">${escapeHtml(game.name)}</h1></div><button class="tv-focus tv-overlay-close" data-tv-action="closeOverlay" data-tv-key="overlay:close">${escapeHtml(t("Close"))}</button></div><div class="tv-overlay-body"><section class="tv-drawer-group"><h2>${escapeHtml(t("Launch profiles"))}</h2><div class="tv-drawer-list">${profileItems}</div></section><section class="tv-drawer-group"><h2>${escapeHtml(t("Play status"))}</h2><div class="tv-drawer-chips" role="radiogroup" aria-label="${escapeHtml(t("Play status"))}">${statusItems}</div></section>${collectionSection}<section class="tv-drawer-group"><button class="tv-focus tv-drawer-item" data-tv-action="toggleGameHidden" data-tv-game="${escapeHtml(game.id)}" data-tv-key="sheet:hidden"><span>${escapeHtml(t(game.hidden ? "Restore to library" : "Hide from library"))}</span></button></section></div></div>`;
				}
			} else if (this.overlay.type === "search") {
				const matches = this.filteredGames();
				const topMatches = matches.slice(0, 10);
				const g = this.glyphs();
				const summary = matches.length
					? t(
							matches.length === 1
								? "{count} matching game"
								: "{count} matching games",
							{ count: formatNumber(matches.length) },
						)
					: t("No matching games");
				sig = JSON.stringify([
					"search",
					window.OrbitI18n?.getLanguage?.(),
					this.statusFamily,
					this.query,
					matches.length,
					topMatches.map((m) => `${m.id}:${m.name}`),
				]);
				if (preserveInput && dialog.querySelector("#tv-search-input")) {
					const resultsSlot = dialog.querySelector(".tv-search-results-slot");
					const countSlot = dialog.querySelector(".tv-search-count");
					if (countSlot) countSlot.textContent = summary;
					if (resultsSlot)
						resultsSlot.innerHTML = this.searchResultsMarkup(topMatches);
					this.overlaySignature = sig;
					return;
				}
				if (sig !== this.overlaySignature) {
					const keyboardHtml = KEYBOARD_ROWS.map(
						(row) =>
							`<div class="tv-kbd-row">${row
								.map(
									(char) =>
										`<button type="button" class="tv-focus tv-kbd-key" data-tv-action="searchKey" data-tv-char="${char}" data-tv-key="kbd:${char}">${char}</button>`,
								)
								.join("")}</div>`,
					).join("");
					markup = `<div class="tv-overlay-surface tv-search-surface"><div class="tv-overlay-head"><h1 id="tv-overlay-title">${escapeHtml(t("Quick search"))}</h1><button type="button" class="tv-focus tv-overlay-close" data-tv-action="closeOverlay" data-tv-key="overlay:close">${escapeHtml(t("Close"))}</button></div><div class="tv-overlay-body"><form id="tv-search-form" class="tv-search-form"><label for="tv-search-input" class="tv-sr-only">${escapeHtml(t("Search games"))}</label><input id="tv-search-input" class="tv-focus tv-search-input" data-tv-key="search:input" type="search" value="${escapeHtml(this.query)}" placeholder="${escapeHtml(t("Type a title, genre, or tag…"))}" autocomplete="off" /><button type="submit" class="tv-focus tv-search-apply" data-tv-key="search:apply">${escapeHtml(t("Apply"))}</button></form><div class="tv-kbd" role="group" aria-label="${escapeHtml(t("Quick search"))}">${keyboardHtml}<div class="tv-kbd-row tv-kbd-actions"><button type="button" class="tv-focus tv-kbd-wide" data-tv-action="searchKey" data-tv-char=" " data-tv-key="kbd:space">${escapeHtml(t("Space"))}</button><button type="button" class="tv-focus tv-kbd-wide" data-tv-action="searchBackspace" data-tv-key="kbd:back" aria-label="${escapeHtml(t("Delete character"))}">⌫</button><button type="button" class="tv-focus tv-kbd-wide" data-tv-action="searchClear" data-tv-key="kbd:clear">${escapeHtml(t("Clear"))}</button><button type="button" class="tv-focus tv-kbd-wide tv-drawer-accent" data-tv-action="closeOverlay" data-tv-key="kbd:done">${escapeHtml(t("Done"))}</button></div><p class="tv-kbd-hint">${escapeHtml(t("{back} Backspace · {space} Space", { back: g.fav, space: g.recent }))}</p></div><div class="tv-search-results-head"><h2>${escapeHtml(t("Matching games"))}</h2><span class="tv-search-count">${escapeHtml(summary)}</span></div><div class="tv-search-results-slot">${this.searchResultsMarkup(topMatches)}</div></div></div>`;
				}
			}
			if (markup && sig !== this.overlaySignature) {
				dialog.innerHTML = markup;
				this.overlaySignature = sig;
			}
			if (!dialog.open && typeof dialog.showModal === "function") {
				try {
					dialog.showModal();
				} catch {}
			}
			this.syncOverlayTriggers();
		}
		searchResultsMarkup(matches) {
			if (!matches.length) {
				return `<p class="tv-drawer-empty">${escapeHtml(t("No matching games"))}</p>`;
			}
			return `<div class="tv-search-results">${matches
				.map(
					(game) =>
						`<button type="button" class="tv-focus tv-drawer-item" data-tv-action="openFromSearch" data-tv-game="${escapeHtml(game.id)}" data-tv-key="search:game:${escapeHtml(game.id)}"><span>${escapeHtml(game.name)}</span><span class="tv-drawer-count">${escapeHtml(sourceName(game.source))}</span></button>`,
				)
				.join("")}</div>`;
		}
		openOverlay(type, extra = {}) {
			const returnKey =
				document.activeElement?.dataset?.tvKey || this.lastKey || "";
			this.overlay = { type, returnKey, ...extra };
			this.overlaySignature = "";
			const initialFocus =
				extra.focusKey ||
				(type === "search"
					? "search:input"
					: type === "game-actions"
						? "sheet:profile:default"
						: "drawer:all");
			this.playCue("confirm");
			this.render({ passive: true, focusKey: initialFocus });
		}
		closeOverlay({
			silent = false,
			skipRender = false,
			focusLibraryIfResults = false,
		} = {}) {
			if (!this.overlay) return;
			const returnKey = this.overlay.returnKey || "";
			this.overlay = null;
			this.overlaySignature = "";
			if (this.overlayDialog?.open) {
				try {
					this.overlayDialog.close();
				} catch {}
			}
			this.syncOverlayTriggers();
			if (!silent) this.playCue("back");
			if (!skipRender) {
				this.render({
					passive: !focusLibraryIfResults,
					focusLibrary: focusLibraryIfResults,
					focusKey: focusLibraryIfResults ? "" : returnKey,
				});
			}
		}
		controls() {
			const scope =
				this.overlay && this.overlayDialog?.open
					? this.overlayDialog
					: this.detailId
						? this.root.querySelector(".tv-sheet")
						: this.root;
			return [
				...(scope?.querySelectorAll(".tv-focus:not([disabled])") || []),
			].filter(
				(button) =>
					button.getClientRects().length &&
					!button.closest("[inert]") &&
					(scope === this.overlayDialog || !button.closest("dialog")),
			);
		}
		focus(button, { scroll = true } = {}) {
			if (!button) return;
			button.focus({ preventScroll: true });
			if (!scroll) return;
			const reduced =
				document.body.dataset.reduceMotion === "true" ||
				window.matchMedia?.("(prefers-reduced-motion:reduce)").matches;
			button.scrollIntoView({
				block: "nearest",
				inline: "nearest",
				behavior: reduced ? "auto" : "smooth",
			});
		}
		focused(button) {
			if (!button?.classList?.contains("tv-focus")) return;
			this.lastKey = button.dataset.tvKey || "";
			for (const item of this.root.querySelectorAll(".tv-focus"))
				item.tabIndex = item === button ? 0 : -1;
			const game = this.byId.get(button.dataset.tvGame);
			if (game && !this.overlay) {
				this.refreshSpotlight(game);
			}
			this.updateSelectedLabel();
		}
		updateSelectedLabel() {
			const selected = this.root?.querySelector(".tv-selected");
			if (!selected) return;
			const game = this.byId.get(document.activeElement?.dataset?.tvGame);
			selected.textContent = game
				? `${game.name} · ${sourceName(game.source)}`
				: t("Choose something to play.");
		}
		move(direction) {
			const current = document.activeElement,
				controls = this.controls();
			if (!controls.includes(current)) {
				this.focus(controls[0]);
				return;
			}
			if (
				(direction === "left" || direction === "right") &&
				(current.closest(".tv-recent") || current.closest(".tv-alpha-jump"))
			) {
				const strip = current.closest(".tv-recent, .tv-alpha-jump");
				const row = [...strip.querySelectorAll(".tv-focus")],
					index = row.indexOf(current) + (direction === "right" ? 1 : -1);
				if (row[index]) {
					this.focus(row[index]);
					this.playCue("move");
				}
				return;
			}
			const candidates = controls.filter((button) => button !== current),
				index = window.OrbitControllerInput.directionalTarget(
					current.getBoundingClientRect(),
					candidates.map((button) => button.getBoundingClientRect()),
					direction,
				);
			if (index !== -1) {
				this.focus(candidates[index]);
				this.playCue("move");
			}
		}
		command(action) {
			if (!this.active) return;
			if (action === "scrollUp" || action === "scrollDown") {
				this.scrollScene(action === "scrollDown" ? 1 : -1);
				return;
			}
			if (["up", "down", "left", "right"].includes(action)) {
				this.move(action);
				return;
			}
			if (action === "search") {
				if (this.overlay?.type === "search") this.closeOverlay();
				else {
					if (this.overlay) this.closeOverlay({ silent: true, skipRender: true });
					this.openOverlay("search");
				}
				return;
			}
			if (action === "drawer") {
				if (this.overlay) {
					this.closeOverlay();
				} else if (this.detailId) {
					this.openOverlay("game-actions", { gameId: this.detailId });
				} else {
					this.openOverlay("drawer");
				}
				return;
			}
			const button = document.activeElement;
			if (action === "select") {
				if (
					this.controls().includes(button) &&
					button.getAttribute("aria-disabled") !== "true"
				) {
					if (button.id === "tv-search-input") {
						this.closeOverlay({ focusLibraryIfResults: true });
					} else {
						button.click();
					}
				}
				return;
			}
			if (action === "favorite") {
				if (this.overlay?.type === "search") {
					this.act("searchBackspace", button).catch((error) =>
						this.notify(error.message),
					);
					return;
				}
				if (this.overlay) return;
				const id = button?.dataset?.tvGame || this.detailId;
				if (id)
					this.act("favorite", { dataset: { tvGame: id } }).catch((error) =>
						this.notify(error?.message || t("Could not update the library.")),
					);
				return;
			}
			if (action === "recent" && this.overlay?.type === "search") {
				this.act("searchKey", {
					dataset: { tvChar: " ", tvKey: button?.dataset?.tvKey || "kbd:space" },
				}).catch((error) => this.notify(error.message));
				return;
			}
			this.act(action, button).catch((error) => this.notify(error.message));
		}
		scrollScene(direction) {
			const panel =
				this.overlay && this.overlayDialog?.open
					? this.overlayDialog.querySelector(".tv-overlay-body")
					: this.detailId
						? this.root?.querySelector(".tv-sheet")
						: this.root?.querySelector(".tv-main");
			if (!panel) return;
			const distance = Math.round(
				Math.max(72, Math.min(180, panel.clientHeight / 3)),
			);
			panel.scrollBy({ top: direction * distance, behavior: "auto" });
		}
		saveLaunchReturn(position) {
			this.returnWrites = this.returnWrites
				.then(() => this.options.api.saveControllerReturn?.(position))
				.catch(() => {
					// A failed checkpoint cannot prevent launching the game.
				});
			return this.returnWrites;
		}
		clearLaunchReturn() {
			if (!this.launchReturn) return;
			this.launchReturn = null;
			void this.saveLaunchReturn(null);
		}
		restoreCard(position) {
			this.detailId = null;
			this.closeOverlay({ silent: true, skipRender: true });
			this.filter = sanitizeFilter(position.filter);
			this.sort = sanitizeSort(position.sort);
			this.query = sanitizeQuery(position.query);
			this.showHidden = !!position.showHidden;
			this.page = Number.isSafeInteger(position.page) ? position.page : 0;
			this.render({
				passive: true,
				focusKey: position.focusKey,
				restoreGameId: position.gameId,
			});
			const applyScroll = () => {
				const main = this.root?.querySelector(".tv-main");
				if (main)
					main.scrollTop = Number.isFinite(position.scrollTop)
						? position.scrollTop
						: 0;
				const recent = this.root?.querySelector(".tv-recent");
				if (recent)
					recent.scrollLeft = Number.isFinite(position.recentScrollLeft)
						? position.recentScrollLeft
						: 0;
			};
			applyScroll();
			if (typeof requestAnimationFrame === "function") {
				requestAnimationFrame(() => {
					if (this.active && !this.detailId && !this.overlay) applyScroll();
				});
			}
		}
		updateLaunchReturn() {
			const returning = this.launchReturn;
			if (!returning) return false;
			const { runningIds, pendingLaunches } = this.options.snapshot();
			const { gameId } = returning.position;
			if (runningIds?.includes(gameId)) {
				returning.sawRunning = true;
				return false;
			}
			if (!returning.sawRunning) {
				if (returning.awaitingConfirmation && !pendingLaunches?.has(gameId))
					this.clearLaunchReturn();
				return false;
			}
			if (document.hidden || !document.hasFocus()) return false;
			this.restoreCard(returning.position);
			this.clearLaunchReturn();
			return true;
		}
		async act(action, button) {
			if (action === "open") {
				this.returnKey = button.dataset.tvKey;
				this.detailId = button.dataset.tvGame;
				this.cardPosition = {
					gameId: this.detailId,
					focusKey: this.returnKey,
					filter: this.filter,
					sort: this.sort,
					query: this.query,
					showHidden: this.showHidden,
					page: this.page,
					scrollTop: this.root.querySelector(".tv-main")?.scrollTop || 0,
					recentScrollLeft:
						this.root.querySelector(".tv-recent")?.scrollLeft || 0,
					previousFullscreen: !!this.session?.previous,
				};
				this.playCue("confirm");
				this.render({ focusKey: "detail:play" });
				return;
			}
			if (action === "openFromSearch") {
				const gameId = button.dataset.tvGame;
				if (!gameId || !this.byId.has(gameId)) return;
				this.closeOverlay({ silent: true, skipRender: true });
				this.returnKey = `library:${gameId}`;
				this.detailId = gameId;
				this.cardPosition = {
					gameId,
					focusKey: this.returnKey,
					filter: this.filter,
					sort: this.sort,
					query: this.query,
					showHidden: this.showHidden,
					page: this.page,
					scrollTop: this.root.querySelector(".tv-main")?.scrollTop || 0,
					recentScrollLeft:
						this.root.querySelector(".tv-recent")?.scrollLeft || 0,
					previousFullscreen: !!this.session?.previous,
				};
				this.playCue("confirm");
				this.render({ focusKey: "detail:play" });
				return;
			}
			if (action === "openDrawer") {
				this.openOverlay("drawer");
				return;
			}
			if (action === "openSearch") {
				this.openOverlay("search");
				return;
			}
			if (action === "openGameSheet") {
				const gameId = button.dataset.tvGame || this.detailId;
				if (!gameId) return;
				this.openOverlay("game-actions", {
					gameId,
					focusKey:
						button.dataset.tvSection === "profiles"
							? "sheet:profile:0"
							: "sheet:profile:default",
				});
				return;
			}
			if (action === "closeOverlay") {
				this.closeOverlay();
				return;
			}
			if (action === "back") {
				if (this.overlay) {
					this.closeOverlay();
				} else if (this.detailId) {
					this.detailId = null;
					this.playCue("back");
					this.render({ focusKey: this.returnKey });
				} else {
					this.playCue("back");
					await this.exit();
				}
				return;
			}
			if (action === "exit") {
				this.playCue("back");
				await this.exit();
				return;
			}
			if (action === "launch" || action === "launchProfile") {
				const id = button?.dataset?.tvGame;
				const profileId = button?.dataset?.tvProfile || null;
				if (
					!id ||
					this.launchInFlight ||
					this.snapshot.pendingLaunches?.has(id) ||
					this.snapshot.runningIds?.includes(id)
				)
					return;
				if (action === "launchProfile") {
					this.closeOverlay({ silent: true, skipRender: true });
				}
				const session = this.session;
				const position = this.cardPosition;
				const returning = position?.gameId === id ? { position } : null;
				this.launchReturn = returning;
				this.launchInFlight = true;
				this.launchGameId = id;
				this.playCue("launch");
				this.pulseHaptic("launch");
				this.render({ passive: true, focusKey: "detail:play" });
				try {
					if (returning) await this.saveLaunchReturn(position);
					if (this.session !== session) return;
					const result = profileId
						? await this.options.launch(id, profileId)
						: await this.options.launch(id);
					if (returning && this.launchReturn === returning) {
						if (
							!result?.tracked &&
							!result?.confirmationTimeoutMs &&
							!returning.sawRunning
						)
							this.clearLaunchReturn();
						else
							returning.awaitingConfirmation =
								!!result?.confirmationTimeoutMs;
					}
				} catch (error) {
					if (returning && this.launchReturn === returning)
						this.clearLaunchReturn();
					throw error;
				} finally {
					if (this.session === session) {
						this.launchInFlight = false;
						this.launchGameId = null;
						this.update();
					}
				}
				return;
			}
			if (action === "favorite") {
				this.playCue("toggle");
				await this.options.favorite(button.dataset.tvGame);
				return;
			}
			if (action === "setStatus") {
				const id = button.dataset.tvGame;
				const status = button.dataset.tvStatus || "";
				if (!id || typeof this.options.updateGame !== "function") return;
				this.playCue("toggle");
				await this.options.updateGame(id, { play_status: status });
				this.notify(t("Status updated."));
				return;
			}
			if (action === "toggleGameCollection") {
				const id = button.dataset.tvGame;
				const colId = button.dataset.tvCollection;
				if (
					!id ||
					!colId ||
					typeof this.options.setGameCollections !== "function"
				)
					return;
				const current = new Set(
					this.gameCollections(id).map((col) => col.id),
				);
				if (current.has(colId)) current.delete(colId);
				else current.add(colId);
				this.playCue("toggle");
				await this.options.setGameCollections(id, [...current]);
				this.notify(t("Collections updated."));
				return;
			}
			if (action === "toggleGameHidden") {
				const id = button.dataset.tvGame;
				const game = this.byId.get(id);
				if (!game || typeof this.options.updateGame !== "function") return;
				const nextHidden = !game.hidden;
				this.playCue("toggle");
				await this.options.updateGame(id, { hidden: nextHidden });
				this.notify(
					t(
						nextHidden
							? "Game hidden from library."
							: "Game restored to library.",
					),
				);
				return;
			}
			if (action === "toggleShowHidden") {
				this.showHidden = !this.showHidden;
				this.page = 0;
				this.playCue("toggle");
				this.render({ passive: true, focusKey: "drawer:show-hidden" });
				return;
			}
			if (action === "toggleSetting") {
				const key = button.dataset.tvSetting;
				if (!key || typeof this.options.saveSettings !== "function") return;
				const current = !!this.snapshot?.settings?.[key];
				await this.options.saveSettings({ [key]: !current });
				this.snapshot = this.options.snapshot();
				if (key === "controllerAudio" && !current) this.playCue("toggle");
				else if (key === "controllerHaptics" && !current)
					this.pulseHaptic("confirm");
				else this.playCue("toggle");
				this.render({ passive: true, focusKey: button.dataset.tvKey });
				return;
			}
			if (action === "searchKey") {
				const char = button.dataset.tvChar || "";
				if (this.query.length < 80) {
					this.query = sanitizeQuery(this.query + char);
					this.page = 0;
					this.playCue("move");
					this.render({ passive: true, focusKey: button.dataset.tvKey });
				}
				return;
			}
			if (action === "searchBackspace") {
				if (this.query.length) {
					this.query = this.query.slice(0, -1);
					this.page = 0;
					this.playCue("back");
					this.render({ passive: true, focusKey: button.dataset.tvKey });
				}
				return;
			}
			if (action === "searchClear") {
				this.query = "";
				this.page = 0;
				this.playCue("back");
				this.render({ passive: true, focusKey: button.dataset.tvKey });
				return;
			}
			if (action === "drawerFilter") {
				this.filter = sanitizeFilter(button.dataset.tvFilter);
				this.page = 0;
				this.playCue("confirm");
				this.closeOverlay({ silent: true, focusLibraryIfResults: true });
				return;
			}
			if (action === "setSort") {
				this.sort = sanitizeSort(button.dataset.tvSort);
				this.page = 0;
				this.playCue("toggle");
				this.render({ passive: true, focusKey: button.dataset.tvKey });
				return;
			}
			if (action === "clearFilters") {
				this.filter = "all";
				this.sort = "name";
				this.query = "";
				this.showHidden = false;
				this.page = 0;
				this.playCue("back");
				this.render({ focusLibrary: true });
				return;
			}
			if (action === "dismissBanner") {
				this.dismissedBannerKey = button.dataset.bannerKey || "";
				this.playCue("back");
				this.render({ focusLibrary: true });
				return;
			}
			if (action === "installUpdate") {
				if (typeof this.options.installUpdate !== "function") return;
				this.closeOverlay({ silent: true, skipRender: true });
				this.playCue("confirm");
				await this.options.installUpdate();
				return;
			}
			if (action === "reviewDiscoveries") {
				if (typeof this.options.reviewDiscoveries !== "function") return;
				this.closeOverlay({ silent: true, skipRender: true });
				this.playCue("confirm");
				await this.options.reviewDiscoveries();
				return;
			}
			if (action === "recent") {
				if (this.overlay) return;
				const hasRecent = this.root.querySelector(".tv-recent .tv-focus");
				if (!hasRecent) {
					this.notify(t("No recently played games yet."));
					return;
				}
				if (this.detailId) {
					this.detailId = null;
					this.render();
				}
				const recentNode = this.root.querySelector(".tv-recent .tv-focus");
				if (recentNode) {
					this.focus(recentNode);
					this.playCue("move");
				}
				return;
			}
			if (action === "filter") {
				this.filter = sanitizeFilter(button.dataset.tvFilter);
				this.page = 0;
				this.playCue("confirm");
				this.render({ focusLibrary: true });
				return;
			}
			if (action === "jumpLetter") {
				const targetPage = Math.max(
					0,
					Math.min(Number(button.dataset.tvPage) || 0, this.pageCount - 1),
				);
				this.page = targetPage;
				this.playCue("move");
				this.render({ focusLibrary: true });
				return;
			}
			if (
				(action === "nextPage" || action === "previousPage") &&
				!this.detailId &&
				!this.overlay
			) {
				const nextPage = Math.max(
					0,
					Math.min(
						this.page + (action === "nextPage" ? 1 : -1),
						this.pageCount - 1,
					),
				);
				if (nextPage === this.page) return;
				this.page = nextPage;
				this.playCue("move");
				this.render({ focusLibrary: true });
			}
		}
		key(event) {
			if (!this.active) return;
			const target = event.composedPath?.()[0] || event.target;
			const inEditable =
				typeof Element !== "undefined" &&
				target instanceof Element &&
				target.matches(':read-write, select, input[type="range"], [role="slider"]');
			if (inEditable) {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.closeOverlay();
					return;
				}
				if (event.key === "Enter") {
					event.preventDefault();
					event.stopImmediatePropagation();
					// IME safety: never submit while composing or during Safari VK_PROCESSKEY (229).
					if (event.isComposing || event.keyCode === 229) return;
					this.closeOverlay({ focusLibraryIfResults: true });
					return;
				}
				if (event.key === "ArrowDown") {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.move("down");
					return;
				}
				if (event.key === "Tab") {
					event.preventDefault();
					event.stopImmediatePropagation();
					const controls = this.controls();
					const index = controls.indexOf(document.activeElement);
					if (controls.length) {
						this.focus(
							controls[
								(index + (event.shiftKey ? -1 : 1) + controls.length) %
									controls.length
							],
						);
					}
				}
				return;
			}
			if (
				(event.ctrlKey || event.metaKey) &&
				!event.altKey &&
				(event.key.toLowerCase() === "f" || event.key.toLowerCase() === "k")
			) {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (!event.repeat) this.command("search");
				return;
			}
			if (event.altKey || event.ctrlKey || event.metaKey) return;
			const arrows = {
				ArrowUp: "up",
				ArrowDown: "down",
				ArrowLeft: "left",
				ArrowRight: "right",
			};
			const action =
				(event.shiftKey && event.key === "ArrowUp"
					? "scrollUp"
					: event.shiftKey && event.key === "ArrowDown"
						? "scrollDown"
						: arrows[event.key]) ||
				{
					Enter: "select",
					" ": "select",
					Escape: "back",
					Backspace: "back",
					PageDown: "nextPage",
					PageUp: "previousPage",
					Home: "recent",
					F2: "drawer",
					F3: "search",
					F11: "exit",
				}[event.key];
			if (event.key === "Tab") {
				event.preventDefault();
				event.stopImmediatePropagation();
				const controls = this.controls(),
					index = controls.indexOf(document.activeElement);
				if (controls.length) {
					this.focus(
						controls[
							(index + (event.shiftKey ? -1 : 1) + controls.length) %
								controls.length
						],
					);
				}
				return;
			}
			if (!action) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (
				event.repeat &&
				!arrows[event.key] &&
				action !== "scrollUp" &&
				action !== "scrollDown"
			)
				return;
			this.command(action);
		}
	}
	window.OrbitControllerMode = {
		create: (options) => new ControllerMode(options),
	};
})();
