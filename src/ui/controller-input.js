// Pure input policy shared by the sandboxed renderer and Node tests.
(() => {
	const bindings = [
		// Standard Gamepad API indices, shared by Xbox and PlayStation pads.
		// Home is an optional browser-exposed button; never infer HID indices.
		[16, "exit"],
		[1, "back"],
		[8, "back"], // View / Share
		[9, "recent"], // Menu / Options
		[0, "select"],
		[2, "favorite"],
		[3, "recent"],
		[4, "previousPage"],
		[6, "previousPage"], // LT / L2
		[5, "nextPage"],
		[7, "nextPage"], // RT / R2
	];
	const pressed = (button) =>
		typeof button === "number"
			? button > 0.5
			: !!button?.pressed || Number(button?.value) > 0.5;
	const axis = (value) =>
		Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
	const padKey = (pad) => `${pad.index}:${pad.id}`;
	const family = (pad) => {
		const id = typeof pad?.id === "string" ? pad.id : "";
		if (/xbox|xinput|x-box/i.test(id)) return "Xbox";
		if (/dualsense|dualshock|playstation|sony|054c/i.test(id))
			return "PlayStation";
		return "Standard";
	};
	const triggerPressed = (button, wasPressed) => {
		// A half-squeezed analog trigger must not turn into a page command.
		// Some browsers only supply the digital `pressed` flag.
		const value = typeof button === "number" ? button : button?.value;
		return Number.isFinite(value)
			? value >= (wasPressed ? 0.4 : 0.7)
			: !!button?.pressed;
	};
	const neutral = (pad) =>
		!Array.from(pad.buttons || []).some((button, index) =>
			index === 6 || index === 7
				? triggerPressed(button, false)
				: pressed(button),
		) &&
		[0, 1, 2, 3].every((index) => Math.abs(axis(pad.axes?.[index])) <= 0.35);

	class GamepadInput {
		constructor() {
			this.reset();
		}
		reset({ preserveOwner = false } = {}) {
			this.owner = preserveOwner ? (this.owner ?? null) : null;
			this.armed = false;
			this.readyPads = new Set();
			this.buttons = new Set();
			this.direction = null;
			this.nextRepeat = 0;
			this.scrollDirection = null;
			this.nextScrollRepeat = 0;
		}
		disconnect(pad) {
			if (!pad) return;
			if (this.owner === padKey(pad)) this.reset();
			else this.readyPads.delete(padKey(pad));
		}
		read(pads, now) {
			const available = [];
			for (
				let index = 0;
				index < Math.min(Number(pads?.length) || 0, 16);
				index++
			)
				if (pads[index]?.connected) available.push(pads[index]);
			const standard = available.filter((pad) => pad.mapping === "standard");
			if (!standard.length) {
				this.reset();
				return {
					actions: [],
					status: { kind: available.length ? "unsupported" : "none" },
				};
			}
			let pad = standard.find((item) => padKey(item) === this.owner);
			if (this.owner && !pad) {
				this.reset();
			}
			if (!pad) {
				// A gamepad's index is not its user's preferred controller. Don't
				// reserve an idle pad on entry: the first controller to make a fresh
				// input after being observed neutral becomes the owner. Requiring a
				// neutral frame also prevents held A/B during entry from activating.
				let chosen = null;
				const connected = new Set(standard.map(padKey));
				for (const candidate of standard) {
					const key = padKey(candidate);
					if (neutral(candidate)) this.readyPads.add(key);
					else if (this.readyPads.has(key) && !chosen) chosen = candidate;
				}
				for (const key of this.readyPads) if (!connected.has(key)) this.readyPads.delete(key);
				if (!chosen)
					return { actions: [], status: { kind: "connected", family: standard.length === 1 ? family(standard[0]) : "Standard" } };
				this.owner = padKey(chosen);
				this.armed = true;
				this.readyPads.clear();
				pad = chosen;
			}
			const buttons = new Set();
			for (
				let index = 0;
				index < Math.min(Number(pad.buttons?.length) || 0, 32);
				index++
			)
				if (index === 6 || index === 7
					? triggerPressed(pad.buttons[index], this.buttons.has(index))
					: pressed(pad.buttons[index])) buttons.add(index);
			const x = axis(pad.axes?.[0]),
				y = axis(pad.axes?.[1]),
				rightY = axis(pad.axes?.[3]);
			const result = { actions: [], status: { kind: "connected", family: family(pad) } };
			if (!this.armed) {
				if (neutral(pad))
					this.armed = true;
				this.buttons = buttons;
				return result;
			}
			let direction = buttons.has(12)
				? "up"
				: buttons.has(13)
					? "down"
					: buttons.has(14)
						? "left"
						: buttons.has(15)
							? "right"
							: null;
			if (!direction) {
				if (Math.max(Math.abs(x), Math.abs(y)) >= 0.55)
					direction =
						Math.abs(x) > Math.abs(y)
							? x > 0
								? "right"
								: "left"
							: y > 0
								? "down"
								: "up";
				else if (this.direction === "left" && x < -0.35) direction = "left";
				else if (this.direction === "right" && x > 0.35) direction = "right";
				else if (this.direction === "up" && y < -0.35) direction = "up";
				else if (this.direction === "down" && y > 0.35) direction = "down";
			}
			const time = Number.isFinite(now) ? now : 0;
			const action = bindings.find(
				([button]) => buttons.has(button) && !this.buttons.has(button),
			);
			if (action) result.actions.push(action[1]);
			// Do not move focus while a shortcut is held (including Back + D-pad).
			// Exactly one action per sample also prevents launch and navigation conflicts.
			if (bindings.some(([button]) => buttons.has(button))) {
				this.direction = null;
				this.scrollDirection = null;
				this.nextRepeat = 0;
				this.nextScrollRepeat = 0;
				this.buttons = buttons;
				return result;
			}
			if (direction !== this.direction) {
				this.direction = direction;
				this.nextRepeat = time + 360;
				if (direction) result.actions.push(direction);
			} else if (direction && time >= this.nextRepeat) {
				result.actions.push(direction);
				this.nextRepeat = time + 120;
			}
			// Right-stick vertical scrolling is separate from left-stick navigation.
			// It stays idle through drift and never competes with D-pad commands.
			let scrollDirection = null;
			if (!direction) {
				if (Math.abs(rightY) >= 0.65)
					scrollDirection = rightY > 0 ? "scrollDown" : "scrollUp";
				else if (this.scrollDirection === "scrollUp" && rightY < -0.42)
					scrollDirection = "scrollUp";
				else if (this.scrollDirection === "scrollDown" && rightY > 0.42)
					scrollDirection = "scrollDown";
			}
			if (scrollDirection !== this.scrollDirection) {
				this.scrollDirection = scrollDirection;
				this.nextScrollRepeat = time + 400;
				if (scrollDirection && !result.actions.length) result.actions.push(scrollDirection);
			} else if (scrollDirection && time >= this.nextScrollRepeat) {
				if (!result.actions.length) result.actions.push(scrollDirection);
				this.nextScrollRepeat = time + 160;
			}
			this.buttons = buttons;
			return result;
		}
	}

	function directionalTarget(origin, candidates, direction) {
		const horizontal = direction === "left" || direction === "right";
		const negative = direction === "left" || direction === "up";
		const valid = (rect) =>
			rect &&
			["left", "right", "top", "bottom"].every((key) =>
				Number.isFinite(rect[key]),
			);
		if (!valid(origin) || !["left", "right", "up", "down"].includes(direction))
			return -1;
		const center = (rect) => ({
			x: (rect.left + rect.right) / 2,
			y: (rect.top + rect.bottom) / 2,
		});
		const from = center(origin);
		let best = -1,
			bestScore = Infinity;
		candidates.forEach((rect, index) => {
			if (!valid(rect)) return;
			const to = center(rect),
				primary =
					(horizontal ? to.x - from.x : to.y - from.y) * (negative ? -1 : 1);
			if (primary <= 1) return;
			const cross = Math.abs(horizontal ? to.y - from.y : to.x - from.x);
			const overlap = horizontal
				? Math.min(origin.bottom, rect.bottom) - Math.max(origin.top, rect.top)
				: Math.min(origin.right, rect.right) - Math.max(origin.left, rect.left);
			if (horizontal && overlap <= 1) return;
			const score = primary + cross * 3 + (overlap > 1 ? 0 : 100000);
			if (score < bestScore) {
				best = index;
				bestScore = score;
			}
		});
		return best;
	}
	const api = { GamepadInput, directionalTarget };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else window.OrbitControllerInput = api;
})();
