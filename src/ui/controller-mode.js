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
	const art = (token) =>
		/^[a-f\d-]{36}\.(jpg|jpeg|png|webp)$/.test(token || "")
			? (window.OrbitArtworkUrl?.(token) || `orbit-art://file/${token}`)
			: "";
	const sources = {
		steam: "Steam",
		epic: "Epic Games",
		gog: "GOG",
		ea: "EA app",
		ubisoft: "Ubisoft Connect",
		battlenet: "Battle.net",
		folder: "Local",
		manual: "Manual",
	};
	const played = (seconds) =>
		seconds >= 3600
			? `${Math.floor(seconds / 3600)}h played`
			: seconds
				? `${Math.max(1, Math.round(seconds / 60))}m played`
				: "No playtime recorded";

	class ControllerMode {
		constructor(options) {
			this.options = options;
			this.active = false;
			this.session = null;
			this.transitions = Promise.resolve();
			this.input = new window.OrbitControllerInput.GamepadInput();
			this.frame = null;
			this.timer = null;
			this.renderFrame = null;
			this.filter = "all";
			this.page = 0;
			this.gamesRef = null;
			this.byId = new Map();
			this.detailId = null;
			this.lastKey = "";
			this.lastPadAction = 0;
			this.detailSignature = "";
			this.launchInFlight = false;
			this.recentMarkup = "";
			this.libraryMarkup = "";
		}
		enter() {
			if (this.session) return this.session.promise;
			const session = { cancelled: false, touched: false, previous: false };
			this.session = session;
			const task = this.transitions
				.catch(() => {})
				.then(async () => {
					try {
						const state = await this.options.api.getWindowState();
						session.previous = !!state.fullscreen;
						if (session.cancelled) return;
						session.touched = true;
						await this.options.api.setFullscreen(true);
						if (session.cancelled) return;
						this.active = true;
						this.mount();
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
			if (this.notice) this.notice.textContent = message;
			else this.options.notify?.(message, true);
		}
		mount() {
			this.filter = "all";
			this.page = 0;
			this.detailId = null;
			this.lastKey = "";
			this.lastPadAction = 0;
			this.detailSignature = "";
			this.launchInFlight = false;
			this.recentMarkup = "";
			this.libraryMarkup = "";
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
			this.root.setAttribute("aria-label", "Orbit controller mode");
			this.root.innerHTML = `<div class="tv-stage"><header class="tv-header"><div class="tv-brand"><img class="tv-logo-dark" src="../../assets/branding/orbit-logo-dark.png" alt="Orbit"/><img class="tv-logo-light" src="../../assets/branding/orbit-logo-light.png" alt="Orbit"/><span>CONTROLLER MODE</span></div><div class="tv-header-actions"><span class="tv-controller-status" role="status">Keyboard ready · connect a controller</span><button class="tv-focus tv-exit" data-tv-key="exit" data-tv-action="exit">Exit controller mode <span>Esc</span></button></div></header><main class="tv-main"><div class="tv-recent-slot"></div><section class="tv-library-section" aria-label="Game library"><div class="tv-library-heading"><div><p class="tv-eyebrow">ONE HOME. EVERY GAME.</p><h1>Your library <span class="tv-total"></span></h1></div><div class="tv-tabs" role="group" aria-label="Choose collection"><button class="tv-focus" data-tv-key="filter:all" data-tv-action="filter" data-tv-filter="all">All games</button><button class="tv-focus" data-tv-key="filter:favorites" data-tv-action="filter" data-tv-filter="favorites">Favorites</button></div></div><div class="tv-library-slot"></div><div class="tv-pagination"><span class="tv-page-label"></span><div><button class="tv-focus" data-tv-key="page:previous" data-tv-action="previousPage" aria-label="Previous page">← Previous</button><button class="tv-focus" data-tv-key="page:next" data-tv-action="nextPage" aria-label="Next page">Next →</button></div></div></section></main><footer class="tv-footer"><div class="tv-selected">Choose something to play.</div><div class="tv-hints"><span><b>↔ ↕</b> Move</span><span><b>A / ×</b> Select</span><span><b>B / ○</b> Back</span><span><b>X / □</b> Favorite</span><span><b>Y / △</b> Recent</span><span><b>LB / RB</b> Pages</span></div></footer></div><div class="tv-detail-slot"></div><div class="tv-notice" role="status" aria-live="polite"></div>`;
			document.body.appendChild(this.root);
			this.stage = this.root.querySelector(".tv-stage");
			this.notice = this.root.querySelector(".tv-notice");
			this.root.addEventListener(
				"click",
				(event) => {
					const button = event.target.closest("[data-tv-action]");
					if (!button || button.disabled) return;
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
				"error",
				(event) => {
					if (event.target instanceof HTMLImageElement)
						event.target.hidden = true;
				},
				{ capture: true, signal },
			);
			this.root.addEventListener(
				"load",
				(event) => {
					const image = event.target;
					if (!(image instanceof HTMLImageElement) || !image.dataset.tvArt)
						return;
					// Do not discard a valid uploaded image because its proportions
					// differ from a store's usual portrait/landscape convention.
					// Both formats are fully visible using object-fit: contain.
					if (!image.naturalWidth || !image.naturalHeight)
						image.hidden = true;
					else image.parentElement.classList.add("has-art");
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
				{
					signal,
				},
			);
			window.addEventListener("resize", () => this.update(), { signal });
			this.render({ initial: true });
			this.resume();
		}
		unmount() {
			this.pause();
			this.input.reset();
			this.abort?.abort();
			if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
			this.renderFrame = null;
			this.detailSignature = "";
			this.recentMarkup = "";
			this.libraryMarkup = "";
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
			const messages = {
				connected: "Controller connected",
				none: "Keyboard ready · connect a controller",
				unsupported: "Controller layout not recognized · use keyboard",
				unavailable: "Controller unavailable · use keyboard",
			};
			const status = this.root.querySelector(".tv-controller-status");
			if (status.textContent !== messages[result.status.kind])
				status.textContent = messages[result.status.kind];
			if (result.actions.length) this.lastPadAction = time;
			for (const action of result.actions) this.command(action);
			if (!this.active) return;
			// Use animation frames only while a person actively navigates. The
			// controller remains sampled at low frequency when idle, and the
			// launcher never runs a continuous RAF loop while a game is active.
			const playing = !!(this.launchInFlight || this.snapshot?.runningIds?.length ||
				this.snapshot?.pendingLaunches?.size);
			const navigating = result.status.kind === "connected" && !playing &&
				this.lastPadAction > 0 && time - this.lastPadAction < 950;
			if (navigating) {
				this.frame = requestAnimationFrame((next) => this.poll(next));
				return;
			}
			const interval = result.status.kind === "connected" ? 48 : 250;
			this.timer = setTimeout(() => {
				this.timer = null;
				if (this.active && !document.hidden && document.hasFocus())
					this.poll(performance.now());
			}, interval);
		}
		columns() {
			const width = this.root.clientWidth;
			return width >= 1600 ? 4 : width >= 1100 ? 3 : width >= 700 ? 2 : 1;
		}
		artwork(game, portrait = false) {
			const banner = art(game.banner),
				cover = art(game.cover),
				icon = art(game.icon);
			const image = portrait ? cover || banner : banner || cover;
			const kind = portrait && cover ? "cover" : banner ? "banner" : "cover";
			const fallback = icon
				? `<img class="tv-native-icon" src="${icon}" alt="" loading="lazy"/>`
				: '<img class="tv-fallback-dark" src="../../assets/branding/orbit-mark-dark.png" alt="" loading="lazy"/><img class="tv-fallback-light" src="../../assets/branding/orbit-mark-light.png" alt="" loading="lazy"/>';
			return `<div class="tv-card-art"><div class="tv-card-fallback">${fallback}</div>${image ? `<img class="tv-game-art ${kind === "banner" ? "is-banner" : "is-cover"}" src="${image}" data-tv-art="${kind}" alt="" loading="lazy"/>` : ""}</div>`;
		}
		spotlight(game) {
			if (!game)
				return `<section class="tv-spotlight tv-spotlight-empty" aria-label="Featured game"><div class="tv-spotlight-copy"><p class="tv-spotlight-kicker"><span class="tv-signal"></span> YOUR COLLECTION STARTS HERE</p><h2>Every game.<br/>One place.</h2><p class="tv-spotlight-description">Bring your games together on the desktop, then take the library to your controller.</p><div class="tv-spotlight-foot"><span class="tv-spotlight-label">READY WHEN YOU ARE</span></div></div><div class="tv-spotlight-visual" aria-hidden="true"><span class="tv-orbit-ring tv-orbit-ring-one"></span><span class="tv-orbit-ring tv-orbit-ring-two"></span><img class="tv-spotlight-mark tv-logo-dark" src="../../assets/branding/orbit-mark-dark.png" alt=""/><img class="tv-spotlight-mark tv-logo-light" src="../../assets/branding/orbit-mark-light.png" alt=""/></div></section>`;
			const banner = art(game.banner) || art(game.cover);
			const running = this.snapshot.runningIds?.includes(game.id);
			const lastPlayed = Number.isFinite(Date.parse(game.last_played_at)) && Date.parse(game.last_played_at) > 0;
			const tag = this.recent[0]?.id === game.id ? "PICK UP WHERE YOU LEFT OFF" : "IN THE SPOTLIGHT";
			return `<section class="tv-spotlight" aria-label="Featured game"><div class="tv-spotlight-ambient" aria-hidden="true">${banner ? `<img src="${banner}" alt="" loading="lazy"/>` : ""}</div><div class="tv-spotlight-copy"><p class="tv-spotlight-kicker"><span class="tv-signal"></span> ${tag}</p><h2>${escapeHtml(game.name)}</h2><p class="tv-spotlight-description">${escapeHtml(sources[game.source] || "Your library")} <span aria-hidden="true">·</span> ${escapeHtml(running ? "Playing now" : played(game.total_play_seconds || 0))}</p><div class="tv-spotlight-foot"><span class="tv-spotlight-label">${running ? "SESSION ACTIVE" : lastPlayed ? "CONTINUE YOUR JOURNEY" : "DISCOVER SOMETHING NEW"}</span><span class="tv-spotlight-prompt"><b>A</b><b>↵</b> Open selected game</span></div></div><div class="tv-spotlight-visual" aria-hidden="true"><div class="tv-spotlight-image">${this.artwork(game)}</div></div></section>`;
		}
		refreshSpotlight(game) {
			if (!game || this.spotlightGameId === game.id) return;
			const hero = this.root?.querySelector(".tv-spotlight");
			if (!hero) return;
			this.spotlightGameId = game.id;
			hero.outerHTML = this.spotlight(game);
			// The focus-driven spotlight differs from the last full render.
			// Keep the next background update from mistaking stale markup for
			// the actual featured game.
			this.recentMarkup = "";
		}
		card(game, zone) {
			const running = this.snapshot.runningIds?.includes(game.id);
			return `<button class="tv-card tv-focus" data-tv-action="open" data-tv-game="${escapeHtml(game.id)}" data-tv-key="${zone}:${escapeHtml(game.id)}" aria-label="Open ${escapeHtml(game.name)}" tabindex="-1">${this.artwork(game)}<span class="tv-card-copy"><strong>${escapeHtml(game.name)}</strong><span>${running ? "● Playing now" : escapeHtml(sources[game.source] || "Game")}<i>${game.favorite ? "♥" : running ? "In session" : played(game.total_play_seconds || 0)}</i></span></span></button>`;
		}
		update() {
			if (!this.active || this.renderFrame !== null) return;
			this.renderFrame = requestAnimationFrame(() => {
				this.renderFrame = null;
				if (this.active) this.render({ passive: true });
			});
		}
		render({ initial = false, focusLibrary = false, focusKey = "", passive = false } = {}) {
			if (!this.root) return;
			const main = this.root.querySelector(".tv-main");
			const scrollTop = passive ? main.scrollTop : 0;
			const recentScrollLeft = passive
				? this.root.querySelector(".tv-recent")?.scrollLeft || 0
				: 0;
			const detailScrollTop = passive
				? this.root.querySelector(".tv-sheet")?.scrollTop || 0
				: 0;
			const previous =
				focusKey || document.activeElement?.dataset.tvKey || this.lastKey;
			this.snapshot = this.options.snapshot();
			if (this.gamesRef !== this.snapshot.games) {
				this.gamesRef = this.snapshot.games;
				this.byId = new Map(this.gamesRef.map((game) => [game.id, game]));
				this.all = this.gamesRef
					.slice()
					.sort(
						(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
					);
				this.favorites = this.all.filter((game) => game.favorite);
				this.recent = this.gamesRef
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
			const recent = this.root.querySelector(".tv-recent-slot");
			const selectedId = previous.startsWith("recent:") || previous.startsWith("library:")
				? previous.slice(previous.indexOf(":") + 1)
				: "";
			const spotlightGame = this.byId.get(selectedId) || this.recent[0] || this.all[0];
			const recentMarkup = this.spotlight(spotlightGame) + (this.recent.length
				? `<section class="tv-continue" aria-label="Continue playing"><div class="tv-section-heading"><h2>Continue playing</h2><span>${this.recent.length} recently played ${this.recent.length === 1 ? "game" : "games"}</span></div><div class="tv-recent">${this.recent.map((game) => this.card(game, "recent")).join("")}</div></section>`
				: "");
			if (recentMarkup !== this.recentMarkup) {
				recent.innerHTML = recentMarkup;
				this.recentMarkup = recentMarkup;
				this.spotlightGameId = spotlightGame?.id || "";
			}
			const list = this.filter === "favorites" ? this.favorites : this.all,
				columns = this.columns(),
				size = columns * 2;
			if (
				this.pageSize &&
				this.pageSize !== size &&
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
			this.root.querySelector(".tv-total").textContent = String(
				this.all.length,
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
				: `<div class="tv-empty"><h2>${this.filter === "favorites" ? "No favorites yet" : "Your next game starts here."}</h2><p>${this.filter === "favorites" ? "Favorite a game with X / Square to keep it here." : "Add games from the desktop library, then return to controller mode."}</p>${this.filter === "favorites" ? '<button class="tv-focus" data-tv-action="filter" data-tv-filter="all" data-tv-key="empty:all">Browse all games</button>' : '<button class="tv-focus" data-tv-action="exit" data-tv-key="empty:exit">Back to desktop library</button>'}</div>`;
			if (libraryMarkup !== this.libraryMarkup) {
				this.root.querySelector(".tv-library-slot").innerHTML = libraryMarkup;
				this.libraryMarkup = libraryMarkup;
			}
			this.root.querySelector(".tv-page-label").textContent = list.length
				? `${start + 1}–${start + records.length} of ${list.length} · Page ${this.page + 1} of ${this.pageCount}`
				: "No games in this collection";
			this.root.querySelector('[data-tv-action="previousPage"]').disabled =
				this.page === 0;
			this.root.querySelector('[data-tv-action="nextPage"]').disabled =
				this.page === this.pageCount - 1;
			if (this.detailId && !this.byId.has(this.detailId)) this.detailId = null;
			this.renderDetail();
			const firstRecent = this.root.querySelector(".tv-recent [data-tv-game]"),
				firstLibrary = this.root.querySelector(".tv-library [data-tv-game]");
			let target = this.controls().find(
				(button) => button.dataset.tvKey === previous,
			);
			if (initial) target = firstRecent || firstLibrary;
			if (focusLibrary) target = firstLibrary;
			const fallback = this.detailId
				? this.controls()[0]
				: firstLibrary ||
					this.root.querySelector(".tv-empty .tv-focus") ||
					firstRecent ||
					this.controls()[0];
				if (passive) {
					main.scrollTop = scrollTop;
					const recent = this.root.querySelector(".tv-recent");
					if (recent) recent.scrollLeft = recentScrollLeft;
					const sheet = this.root.querySelector(".tv-sheet");
					if (sheet) sheet.scrollTop = detailScrollTop;
				}
				// Data updates must not pull the user's wheel/touch scroll position
				// back to whichever card happens to have keyboard focus.
				this.focus(target || fallback, { scroll: !passive || !target });
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
			const pending = this.snapshot.pendingLaunches?.has(game.id),
				running = this.snapshot.runningIds?.includes(game.id);
			const signature = JSON.stringify([game.id, game.name, game.source, game.banner,
				game.cover, game.icon, game.favorite, running ? null : game.total_play_seconds, game.last_played_at,
				!!pending, !!running]);
			// Prevent an unrelated library refresh from replacing the focused
			// controls, reloading artwork, or resetting detail scroll.
			if (this.detailSignature === signature && slot.firstElementChild) return;
			this.detailSignature = signature;
			const background = art(game.banner) || art(game.cover);
			slot.innerHTML = `<div class="tv-sheet-scrim"><section class="tv-sheet" role="dialog" aria-modal="true" aria-labelledby="tv-game-title"><div class="tv-sheet-backdrop" aria-hidden="true">${background ? `<img src="${background}" alt="" loading="lazy"/>` : ""}</div><div class="tv-sheet-layout"><div class="tv-sheet-art">${this.artwork(game, true)}</div><div class="tv-sheet-copy"><p class="tv-eyebrow">GAME PROFILE <span aria-hidden="true">/</span> ${escapeHtml(sources[game.source] || "Your library")}</p><h2 id="tv-game-title">${escapeHtml(game.name)}</h2><p class="tv-sheet-meta">${escapeHtml(running ? "Session in progress" : played(game.total_play_seconds || 0))}${game.last_played_at ? ` · Last played ${escapeHtml(new Date(game.last_played_at).toLocaleDateString())}` : ""}</p><div class="tv-sheet-actions"><button class="tv-focus tv-play" data-tv-action="launch" data-tv-key="detail:play" data-tv-game="${escapeHtml(game.id)}" aria-busy="${!!pending}" ${pending || running ? "disabled" : ""}>${pending ? "Starting…" : running ? "Playing now" : "▶ Play game"}</button><button class="tv-focus" data-tv-action="favorite" data-tv-key="detail:favorite" data-tv-game="${escapeHtml(game.id)}">${game.favorite ? "♥ Remove favorite" : "♡ Add favorite"}</button><button class="tv-focus" data-tv-action="back" data-tv-key="detail:back">Back to library</button></div><p class="tv-sheet-hint"><span>B / ○</span> Return to the collection</p></div></div></section></div>`;
		}
		controls() {
			const scope = this.detailId
				? this.root.querySelector(".tv-sheet")
				: this.root;
			return [
				...(scope?.querySelectorAll(".tv-focus:not([disabled])") || []),
			].filter(
				(button) =>
					button.getClientRects().length && !button.closest("[inert]"),
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
			if (!button.classList?.contains("tv-focus")) return;
			this.lastKey = button.dataset.tvKey;
			for (const item of this.root.querySelectorAll(".tv-focus"))
				item.tabIndex = item === button ? 0 : -1;
			const game = this.byId.get(button.dataset.tvGame);
			if (game) {
				this.refreshSpotlight(game);
				this.root.querySelector(".tv-selected").textContent =
					`${game.name} · ${sources[game.source] || "Game"}`;
			}
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
				current.closest(".tv-recent")
			) {
				const row = [...this.root.querySelectorAll(".tv-recent .tv-focus")],
					index = row.indexOf(current) + (direction === "right" ? 1 : -1);
				this.focus(row[index]);
				return;
			}
			const candidates = controls.filter((button) => button !== current),
				index = window.OrbitControllerInput.directionalTarget(
					current.getBoundingClientRect(),
					candidates.map((button) => button.getBoundingClientRect()),
					direction,
				);
			if (index !== -1) this.focus(candidates[index]);
		}
		command(action) {
			if (!this.active) return;
			if (["up", "down", "left", "right"].includes(action)) {
				this.move(action);
				return;
			}
			const button = document.activeElement;
			if (action === "select") {
				if (this.controls().includes(button)) button.click();
				return;
			}
			if (action === "favorite") {
				const id = button?.dataset.tvGame || this.detailId;
				if (id) this.options.favorite(id);
				return;
			}
			this.act(action, button).catch((error) => this.notify(error.message));
		}
		async act(action, button) {
			if (action === "open") {
				this.returnKey = button.dataset.tvKey;
				this.detailId = button.dataset.tvGame;
				this.render({ focusKey: "detail:play" });
				return;
			}
			if (action === "back") {
				if (this.detailId) {
					this.detailId = null;
					this.render({ focusKey: this.returnKey });
				} else await this.exit();
				return;
			}
			if (action === "exit") {
				await this.exit();
				return;
			}
			if (action === "launch") {
				this.launchInFlight = true;
				try {
					await this.options.launch(button.dataset.tvGame);
				} finally {
					this.launchInFlight = false;
				}
				return;
			}
			if (action === "favorite") {
				await this.options.favorite(button.dataset.tvGame);
				return;
			}
			if (action === "recent") {
				if (this.detailId) {
					this.detailId = null;
					this.render();
				}
				const recent = this.root.querySelector(".tv-recent .tv-focus");
				if (recent) this.focus(recent);
				else this.notify("No recently played games yet.");
				return;
			}
			if (action === "filter") {
				this.filter = button.dataset.tvFilter;
				this.page = 0;
				this.render({ focusLibrary: true });
				return;
			}
			if (
				(action === "nextPage" || action === "previousPage") &&
				!this.detailId
			) {
				this.page = Math.max(
					0,
					Math.min(
						this.page + (action === "nextPage" ? 1 : -1),
						this.pageCount - 1,
					),
				);
				this.render({ focusLibrary: true });
			}
		}
		key(event) {
			if (!this.active || event.altKey || event.ctrlKey || event.metaKey)
				return;
			const arrows = {
				ArrowUp: "up",
				ArrowDown: "down",
				ArrowLeft: "left",
				ArrowRight: "right",
			};
			const action =
				arrows[event.key] ||
				{
					Enter: "select",
					" ": "select",
					Escape: "back",
					Backspace: "back",
					PageDown: "nextPage",
					PageUp: "previousPage",
					Home: "recent",
					F11: "exit",
				}[event.key];
			if (event.key === "Tab") {
				event.preventDefault();
				event.stopImmediatePropagation();
				const controls = this.controls(),
					index = controls.indexOf(document.activeElement);
				this.focus(
					controls[
						(index + (event.shiftKey ? -1 : 1) + controls.length) %
							controls.length
					],
				);
				return;
			}
			if (!action) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.repeat && !arrows[event.key]) return;
			this.command(action);
		}
	}
	window.OrbitControllerMode = {
		create: (options) => new ControllerMode(options),
	};
})();
