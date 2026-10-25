"use strict";
// Native fullscreen transitions can complete asynchronously on macOS.
class FullscreenController {
	constructor(getWindow, { timeoutMs = 5000 } = {}) {
		this.getWindow = getWindow;
		this.timeoutMs = timeoutMs;
		this.queue = Promise.resolve();
	}
	window() {
		const win = this.getWindow();
		if (!win || win.isDestroyed())
			throw Error("The Orbit window is unavailable.");
		return win;
	}
	get() {
		return { fullscreen: this.window().isFullScreen() };
	}
	set(enabled) {
		if (typeof enabled !== "boolean")
			return Promise.reject(Error("Fullscreen state must be a boolean."));
		const request = this.queue
			.catch(() => {})
			.then(() => this.transition(enabled));
		this.queue = request;
		return request;
	}
	transition(enabled) {
		const win = this.window();
		if (win.isFullScreen() === enabled)
			return Promise.resolve({ fullscreen: enabled });
		return new Promise((resolve, reject) => {
			const event = enabled ? "enter-full-screen" : "leave-full-screen";
			let timer,
				finished = false;
			const cleanup = () => {
				clearTimeout(timer);
				win.removeListener(event, done);
				win.removeListener("closed", closed);
			};
			const finish = (error) => {
				if (finished) return;
				finished = true;
				cleanup();
				if (error) reject(error);
				else resolve({ fullscreen: enabled });
			};
			const done = () => finish();
			const closed = () => finish(Error("The Orbit window was closed."));
			win.once(event, done);
			win.once("closed", closed);
			timer = setTimeout(
				() =>
					finish(
						Error("The fullscreen transition did not complete. Try again."),
					),
				this.timeoutMs,
			);
			try {
				win.setFullScreen(enabled);
			} catch (error) {
				finish(error);
			}
		});
	}
}
module.exports = { FullscreenController };
